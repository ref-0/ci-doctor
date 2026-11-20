#!/usr/bin/env node
/**
 * Builds ci-doctor's guide for ci-doctor.ref0.dev: the repo's Markdown, and the files it links to, as
 * static files at the paths they have in the repo, under `/guide/`, with `/llms.txt` at the root.
 *
 *     node scripts/site/build.ts [<out>]      default out: dist/site
 *
 * - **Served:** the tracked Markdown in SERVED_DIRS, the SERVED_ROOT files, and every tracked file a
 *   served Markdown file links to, Markdown or not, or that is in a folder one links to, so a relative
 *   link resolves on the site as it does in the repo. LEFT_OUT's paths, tests' fixtures and
 *   `node_modules` are never served.
 * - **Folders:** each folder holding a served file gets an `index.html` listing it, so a link to a
 *   folder resolves too.
 * - **`/llms.txt`:** the guide's pages in `docs/README.md`'s order, the skills, the reference
 *   implementations' READMEs and the README and CHANGELOG, each described from its own frontmatter
 *   or first sentence. **`/guide/llms-full.txt`:** the guide's pages in that order, whole.
 * - **`_headers`:** serves every file as UTF-8 text, Markdown as `text/markdown`, so a `.ts` script
 *   isn't taken for video.
 *
 * Deterministic: the same commit builds the same bytes (files are read from the working tree, so
 * build from a clean one). `node scripts/check.ts` builds it and checks every link and `llms.txt`
 * (`siteProblems` below). Deploy: `scripts/site/README.md`. Node 24 only, and `git`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { argv, cwd } from 'node:process';
import { fileURLToPath } from 'node:url';

import { linkTargets, proseLines } from '../docs/check-links.ts';

export const ORIGIN = 'https://ci-doctor.ref0.dev';
/** Where the repo's files go on the site; the root keeps `/<owner>/<repo>` free for the score site's reports. */
export const BASE = 'guide';

/** Folders whose tracked Markdown is served. */
export const SERVED_DIRS = ['docs/', 'skills/', 'templates/', 'scripts/', 'tools/', 'cache/', 'scorer/'];
/** Files at the repo's root that are served. */
export const SERVED_ROOT = ['README.md', 'CHANGELOG.md', 'LICENSE'];
/** Never served, even when linked: this site's own build. */
export const LEFT_OUT = ['scripts/site/'];

/** Tests' fixtures: a `fixtures/` folder, or a `fixtures.*` file in a test folder. */
export const isFixture = (path: string) => /(^|\/)fixtures\//.test(path) || /(^|\/)tests?\/(.+\/)?fixtures\.[^/]+$/.test(path);

const external = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|<)/i;

const tracked = (root: string) =>
  spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .stdout.split('\0')
    .filter((f) => f !== '' && existsSync(join(root, f)) && statSync(join(root, f)).isFile());

/** The repo paths a Markdown file links to, relative and outside code, resolved from the file. */
export const linksOf = (text: string, from: string): string[] =>
  proseLines(text).flatMap((line) =>
    linkTargets(line)
      .filter((t) => !external.test(t))
      .map((t) => posix.normalize(posix.join(posix.dirname(from), decodeURIComponent(t.split('#')[0] ?? '')))),
  );

/** Every served file, as a sorted list of repo paths. */
export const served = (root: string): string[] => {
  const files = new Set(tracked(root).filter((f) => !isFixture(f) && !LEFT_OUT.some((l) => f.startsWith(l)) && !f.split('/').includes('node_modules')));
  const out = new Set([...files].filter((f) => SERVED_ROOT.includes(f) || (f.endsWith('.md') && SERVED_DIRS.some((d) => f.startsWith(d)))));

  const queue = [...out].filter((f) => f.endsWith('.md'));
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const target of linksOf(readFileSync(join(root, file), 'utf8'), file)) {
      const folder = target === '.' ? '' : `${target.replace(/\/$/, '')}/`;
      for (const f of files.has(target) ? [target] : [...files].filter((f) => f.startsWith(folder))) {
        if (out.has(f)) continue;
        out.add(f);
        if (f.endsWith('.md')) queue.push(f);
      }
    }
  }
  return [...out].sort();
};

/** Markdown reduced to one plain line: links to their text, emphasis marks dropped. */
const plain = (md: string) =>
  md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/(?<![\w*])\*(?!\s)([^*]+)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/** Lines outside fenced code, inline code kept. */
const unfenced = (text: string) => {
  let fence: string | undefined;
  return text.split('\n').map((line) => {
    const mark = /^\s*(`|~)\1\1/.exec(line)?.[1];
    if (mark && (fence === undefined || mark === fence)) fence = fence === undefined ? mark : undefined;
    return mark || fence !== undefined ? '' : line;
  });
};

/** A file's title (its first heading) and description (its frontmatter's, its comment's `What:`, or its first sentence). */
export const describe = (text: string): { title: string; description: string } => {
  const front = /^---\n[\s\S]*?\n---\n/.exec(text)?.[0] ?? '';
  const fromFront = /^description:\s*"?(.*?)"?\s*$/m.exec(front)?.[1]?.replace(/\\"/g, '"');
  const fromComment = /^<!--[\s\S]*?^What:\s*(.+)$/m.exec(text)?.[1];
  const body = unfenced(text.slice(front.length).replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, '')));
  const heading = body.findIndex((l) => /^#\s/.test(l));
  const title = plain(body[heading]?.replace(/^#\s+/, '') ?? '');

  // The first paragraph after the heading, skipping headings, tables, HTML, quotes, a lone link such as
  // "[Guide](../README.md)", and a technique's "**Applies when:**" line, which says when, not what.
  const rest = body.slice(heading + 1);
  const start = rest.findIndex((l) => l.trim() !== '' && !/^\s*(#|\||<|>|\[[^\]]*\]\([^)]*\)\s*$|\*\*(?:Applies|Skip) when:\*\*)/.test(l));
  const end = rest.findIndex((l, i) => i > start && l.trim() === '');
  const paragraph = start === -1 ? '' : rest.slice(start, end === -1 ? undefined : end).join(' ').replace(/^\s*(?:[-*]|\d+\.)\s+/, '');
  // A bold lead that is a sentence of its own, "**Cache by real inputs.** …", keeps the sentence after it.
  const lead = /^\*\*[^*]+\.\*\*/.test(paragraph);
  const sentences = plain(paragraph).match(/.+?(?:[.!?](?=\s|$)|$)/g) ?? [];
  // A sentence that introduces a list, "This is a field report from …:", ends as a sentence.
  const first = sentences.slice(0, lead ? 2 : 1).join('').trim().replace(/:$/, '.');
  return { title, description: fromFront ?? fromComment ?? (first || title) };
};

/** A served path's URL on the site. */
export const url = (path: string) => `${ORIGIN}/${BASE}/${path}`;

/** The guide's pages in `docs/README.md`'s order: that file, then each page its Contents and after link to. */
export const guidePages = (root: string, files: ReadonlySet<string>): string[] => {
  const readme = readFileSync(join(root, 'docs/README.md'), 'utf8');
  const linked = linksOf(readme.slice(Math.max(0, readme.search(/^## Contents$/m))), 'docs/README.md').filter((f) => f.startsWith('docs/') && f.endsWith('.md') && files.has(f));
  return [...new Set(['docs/README.md', ...linked])];
};

/** `llms.txt`, from the served files. */
export const llms = (root: string, files: ReadonlySet<string>): string => {
  // A guide page's title says what it is; its first paragraph is often a technique's lead or a table's note,
  // which reads wrong out of place, so guide pages get the title alone.
  const entry = (path: string) => {
    const { title, description } = describe(readFileSync(join(root, path), 'utf8'));
    const page = /^docs\/pages\/[^/]+\.md$/.test(path);
    return `- [${title || path}](${url(path)})${page ? '' : `: ${description}`}`;
  };
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const summary = plain(/<\/h1>\s*\n+([^\n]+)/.exec(readme)?.[1] ?? describe(readme).description);
  const skills = [...files].filter((f) => /^skills\/[^/]+\/SKILL\.md$/.test(f)).sort((a, b) => Number(!a.startsWith('skills/ci-doctor/')) - Number(!b.startsWith('skills/ci-doctor/')) || a.localeCompare(b));
  const references = [...files].filter((f) => /^(scripts|templates|tools|cache|scorer)\/(.+\/)?README\.md$/.test(f));
  const section = (name: string, paths: readonly string[]) => `## ${name}\n\n${paths.filter((p) => files.has(p)).map(entry).join('\n')}\n`;

  return [
    `# ci-doctor\n\n> ${summary}\n`,
    `Every file here is also at the path it has in the repo, ${ORIGIN}/${BASE}/<path>, so its relative links resolve. The skills are a plugin for coding agents: the README says how to install them. ${ORIGIN}/${BASE}/llms-full.txt holds the guide's pages whole.\n`,
    section('Guide', guidePages(root, files)),
    section('Skills', ['skills/README.md', ...skills]),
    section('Reference implementations', references),
    section('About', ['README.md', 'CHANGELOG.md']),
  ].join('\n');
};

/** `llms-full.txt`: the guide's pages whole, each headed by its URL. */
export const llmsFull = (root: string, files: ReadonlySet<string>) =>
  guidePages(root, files)
    .map((p) => `<!-- ${url(p)} -->\n\n${readFileSync(join(root, p), 'utf8').trimEnd()}\n`)
    .join('\n');

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A folder's listing: its subfolders, then its files, each linked. */
export const listing = (folder: string, entries: readonly string[]) => {
  const name = folder === '' ? `${BASE}/` : `${BASE}/${folder}/`;
  const items = entries.map((e) => `<li><a href="${escape(encodeURI(e))}">${escape(e)}</a></li>`).join('\n');
  return `<!doctype html>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escape(name)}</title>\n<h1>${escape(name)}</h1>\n<ul>\n${folder === '' ? '' : '<li><a href="../">../</a></li>\n'}${items}\n</ul>\n`;
};

/** Content types: Markdown as Markdown, a folder's listing as HTML, every other served file as plain text. */
export const HEADERS = `# Written by scripts/site/build.ts.
/${BASE}/*
  Content-Type: text/plain; charset=utf-8
  X-Content-Type-Options: nosniff
/${BASE}/*.md
  ! Content-Type
  Content-Type: text/markdown; charset=utf-8
/${BASE}/
  ! Content-Type
  Content-Type: text/html; charset=utf-8
/${BASE}/*/
  ! Content-Type
  Content-Type: text/html; charset=utf-8
/${BASE}/*.svg
  ! Content-Type
  Content-Type: image/svg+xml
/llms.txt
  Content-Type: text/plain; charset=utf-8
`;

/** Writes the site into `out`, which must be absent, empty or an earlier build. */
export const build = (root: string, out: string): { files: number; bytes: number } => {
  if (existsSync(out) && readdirSync(out).length > 0 && !existsSync(join(out, 'llms.txt'))) throw new Error(`${out}: not empty and not an earlier build; name another folder`);
  rmSync(out, { recursive: true, force: true });

  const files = served(root);
  const set = new Set(files);
  const write = (path: string, data: string | Buffer) => {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), data);
  };
  for (const f of files) write(`${BASE}/${f}`, readFileSync(join(root, f)));

  const folders = new Map<string, Set<string>>([['', new Set()]]);
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 0; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/');
      const entry = i === parts.length - 1 ? parts[i] ?? '' : `${parts[i]}/`;
      folders.set(folder, (folders.get(folder) ?? new Set()).add(entry));
    }
  }
  for (const [folder, entries] of folders) {
    const sorted = [...entries].sort((a, b) => Number(!a.endsWith('/')) - Number(!b.endsWith('/')) || a.localeCompare(b));
    write(posix.join(BASE, folder, 'index.html'), listing(folder, sorted));
  }

  write('llms.txt', llms(root, set));
  write(`${BASE}/llms-full.txt`, llmsFull(root, set));
  write('_headers', HEADERS);

  const all = walk(out);
  return { files: all.length, bytes: all.reduce((n, f) => n + statSync(f).size, 0) };
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

/** What's wrong with a build: relative links that leave what's served, and `llms.txt` against the pages it must name. */
export const siteProblems = (root: string, out: string): string[] => {
  const problems: string[] = [];
  const site = join(out, BASE);
  const resolves = (path: string) => existsSync(path) && (statSync(path).isFile() || existsSync(join(path, 'index.html')));

  for (const file of walk(site).filter((f) => f.endsWith('.md'))) {
    const shown = relative(site, file).split('\\').join('/');
    proseLines(readFileSync(file, 'utf8')).forEach((line, index) => {
      for (const target of linkTargets(line)) {
        if (external.test(target)) continue;
        const path = decodeURIComponent(target.split('#')[0] ?? '');
        const there = path.startsWith('/') ? join(out, path) : resolve(dirname(file), path);
        const inSite = relative(site, there).split('\\').join('/');
        if (inSite.startsWith('..') || !resolves(there)) problems.push(`${shown}:${index + 1}: ${target}: ${inSite.startsWith('..') ? 'leaves /guide/' : `${inSite} isn't served`}`);
      }
    });
  }

  const llmsTxt = existsSync(join(out, 'llms.txt')) ? readFileSync(join(out, 'llms.txt'), 'utf8') : '';
  if (llmsTxt === '') problems.push('llms.txt: missing');
  const named = new Set<string>();
  for (const [, link = ''] of llmsTxt.matchAll(/\]\((\S+?)\)/g)) {
    const prefix = `${ORIGIN}/${BASE}/`;
    if (!link.startsWith(prefix)) {
      problems.push(`llms.txt: ${link}: not under ${prefix}`);
      continue;
    }
    const path = link.slice(prefix.length);
    named.add(path);
    if (!existsSync(join(site, path)) || !statSync(join(site, path)).isFile()) problems.push(`llms.txt: ${link}: isn't served`);
  }
  const must = tracked(root).filter((f) => /^docs\/(pages\/)?[^/]+\.md$/.test(f) || /^skills\/[^/]+\/SKILL\.md$/.test(f) || /^(scripts|templates|tools|cache|scorer)\/(.+\/)?README\.md$/.test(f) || f === 'README.md' || f === 'CHANGELOG.md');
  for (const f of must.filter((f) => !LEFT_OUT.some((l) => f.startsWith(l))).sort()) if (!named.has(f)) problems.push(`llms.txt: doesn't name ${f}`);
  return problems;
};

if (argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(argv[1])) {
  const out = resolve(cwd(), argv[2] ?? 'dist/site');
  const { files, bytes } = build(cwd(), out);
  console.log(`${relative(cwd(), out) || out}: ${files} files, ${(bytes / 1024).toFixed(0)} KB`);
}
