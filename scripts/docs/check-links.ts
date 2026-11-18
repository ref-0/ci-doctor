#!/usr/bin/env node
/**
 * Fails on a broken relative link or anchor in any Markdown file the repo holds.
 *
 *     node scripts/docs/check-links.ts [--mentions] [<file or folder>...]
 *
 * - Every `[text](target)` and `[label]: target` outside code fences and inline code: the file or
 *   folder must exist, and a `#anchor` must match a heading in that file, slugged as GitHub does
 *   (duplicates get `-1`, `-2`), or an explicit `<a id>`/`<a name>`.
 * - `--mentions` also reads code, YAML and Markdown text for bare repo paths under `CONFIG.mentionRoots`
 *   (such as `docs/pages/06-...md` in a comment) and fails on any that don't exist. Paths with a
 *   `<placeholder>` are skipped.
 * - With no paths it checks the whole repo: `git ls-files` in a Git checkout, else every file under
 *   the working directory. `CONFIG.skip` folders are left out either way.
 *
 * Where: CI's static job, and before a push. Needs Node 24 and nothing else. Tests:
 * `node --test check-links.test.ts`. Configure: the CONFIG block. Why: docs/pages/17-keeping-agent-knowledge-from-going-stale.md.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';

// CONFIG: adapt to your repo.
export const CONFIG = {
  /** Folders never checked: vendored code and installs. */
  skip: ['node_modules', 'vendor', '.git', 'dist', '.wrangler'],
  /** Top-level folders whose bare path mentions `--mentions` checks. Empty turns mentions off. */
  mentionRoots: ['docs', 'skills', 'scripts', 'templates', 'tools', 'cache', 'checks'],
  /** File types `--mentions` reads. */
  mentionFiles: /\.(md|ts|tsx|js|mjs|sh|ya?ml|json|jsonc|sql|toml)$/,
};

export type Problem = { file: string; line: number; target: string; why: string };

/** GitHub's heading slug: lowercase, punctuation dropped, spaces to hyphens. */
export const slug = (heading: string) =>
  heading
    .replace(/`/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\- _]/gu, '')
    .replace(/ /g, '-');

/** Lines outside fenced code blocks, with inline code blanked, keeping line numbers. */
const proseLines = (text: string) => {
  let fence: string | undefined;
  return text.split('\n').map((line) => {
    const mark = /^\s*(`|~)\1\1/.exec(line)?.[1];
    if (mark) {
      if (fence === undefined) fence = mark;
      else if (mark === fence) fence = undefined;
      return '';
    }
    return fence === undefined ? line.replace(/`[^`]*`/g, '``') : '';
  });
};

const anchorCache = new Map<string, Set<string>>();

export const anchorsOf = (file: string) => {
  const cached = anchorCache.get(file);
  if (cached) return cached;

  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  const text = readFileSync(file, 'utf8');
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    const mark = /^\s*(`|~)\1\1/.exec(line)?.[1];
    if (mark) {
      if (fence === undefined) fence = mark;
      else if (mark === fence) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (!heading) continue;
    const base = slug(heading);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  for (const [, id = ''] of text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(id);

  anchorCache.set(file, anchors);
  return anchors;
};

const external = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Every broken link in one Markdown file. */
export const checkFile = (file: string): Problem[] => {
  const problems: Problem[] = [];
  const lines = proseLines(readFileSync(file, 'utf8'));

  lines.forEach((line, index) => {
    const targets = [
      ...[...line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].flatMap((m) => m[1] ?? []),
      ...[...line.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/g)].flatMap((m) => m[1] ?? []),
    ];
    for (const target of targets) {
      if (external.test(target) || target.startsWith('<')) continue;
      const hash = target.indexOf('#');
      const path = decodeURIComponent(hash === -1 ? target : target.slice(0, hash));
      const anchor = hash === -1 ? '' : decodeURIComponent(target.slice(hash + 1));
      const resolved = path === '' ? file : resolve(dirname(file), path);
      const at = { file, line: index + 1, target };

      if (!existsSync(resolved)) {
        problems.push({ ...at, why: 'no such file' });
        continue;
      }
      if (anchor && resolved.endsWith('.md') && statSync(resolved).isFile() && !anchorsOf(resolved).has(anchor.toLowerCase())) {
        problems.push({ ...at, why: 'no such heading' });
      }
    }
  });

  return problems;
};

/** Bare repo-path mentions in a file's text that don't exist. */
export const checkMentions = (file: string, root: string): Problem[] => {
  if (CONFIG.mentionRoots.length === 0) return [];
  const roots = CONFIG.mentionRoots.map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const mention = new RegExp(`(?<![\\w./-])((?:\\.\\./)*(?:${roots})/[\\w./-]*[\\w/])`, 'g');
  const problems: Problem[] = [];

  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      for (const match of line.matchAll(mention)) {
        const path = match[1] ?? '';
        if (/[<>]/.test(line.slice(match.index, match.index + path.length + 2))) continue;
        const fromRoot = resolve(root, path.replace(/^(?:\.\.\/)+/, ''));
        const fromFile = resolve(dirname(file), path);
        if (!existsSync(fromRoot) && !existsSync(fromFile)) {
          problems.push({ file, line: index + 1, target: path, why: 'mentioned path missing' });
        }
      }
    });

  return problems;
};

const skipped = (path: string) => path.split(sep).some((part) => CONFIG.skip.includes(part));

/** The files to check: the paths given, else the repo's tracked files, else everything here. */
export const filesUnder = (root: string, paths: string[]): string[] => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (CONFIG.skip.includes(entry.name)) return [];
      return entry.isDirectory() ? walk(full) : [full];
    });

  if (paths.length > 0) {
    return paths.flatMap((p) => {
      const full = resolve(root, p);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  }
  try {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return tracked
      .split('\0')
      .filter(Boolean)
      .map((f) => resolve(root, f))
      .filter((f) => existsSync(f) && !skipped(relative(root, f)));
  } catch {
    return walk(root);
  }
};

const main = () => {
  const args = process.argv.slice(2);
  const mentions = args.includes('--mentions');
  const paths = args.filter((a) => a !== '--mentions');
  const root = process.cwd();
  const files = filesUnder(root, paths);

  const problems = [
    ...files.filter((f) => f.endsWith('.md')).flatMap(checkFile),
    ...(mentions ? files.filter((f) => CONFIG.mentionFiles.test(f)).flatMap((f) => checkMentions(f, root)) : []),
  ];

  for (const p of problems) console.log(`${normalize(relative(root, p.file))}:${p.line}: ${p.target}: ${p.why}`);
  const checked = files.filter((f) => f.endsWith('.md')).length;
  console.log(problems.length === 0 ? `ok: ${checked} Markdown files, every link resolves` : `${problems.length} broken`);
  process.exitCode = problems.length === 0 ? 0 : 1;
};

if (import.meta.url === `file://${process.argv[1]}`) main();
