#!/usr/bin/env node
/**
 * What: installs the skills a user approved into the folder their agent harness reads, and checks
 *   that every relative link and heading anchor in Markdown resolves.
 * Where: run by a person or an agent from the target repo's root, after the user approved the plan.
 * Configure: nothing; pass the playbook's pinned copy (--root), the harness's skills folder (--into)
 *   and the skills to install. Node 24 built-ins only.
 * Tests: `node --test install.test.ts`, from this folder.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * Install approved skills, pointing their links at a pinned copy of the whole playbook.
 *
 *   install.ts --root .agents/ci-doctor --into .claude/skills ci-workflows ci-runners
 *       copy each skill into --into, rewrite every link that leaves the skill so it points into
 *       --root, then check every link and anchor in what was installed
 *   install.ts --manifest --root .agents/ci-doctor ci-workflows
 *       the files outside each skill that it links to, without installing
 *   install.ts --check <dir or file>...
 *       check every relative link and anchor in the Markdown under each path
 *
 * A skill links to the rest of the playbook (checks, docs, templates, scripts, tools and its sibling
 * skills), so --root is a copy of all of it, pinned at a tag or commit. A skill you leave out stays
 * readable in --root, and the installed skills' links to it resolve there, but the harness doesn't
 * load it. The installer writes `.installed-from` in each folder it installs, and replaces only a
 * folder holding that file: it never overwrites a skill of the repo's own.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process, { argv, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const LINK = /(\]\()([^)\s]+)(\))/g;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
export const MARKER = '.installed-from';

/** A refusal: the message goes to stderr and the run exits 1. */
export class Stop extends Error {}

const isFile = (p: string) => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
const isDir = (p: string) => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
const lexists = (p: string) => lstatSync(p, { throwIfNoEntry: false }) !== undefined;
const lines = (path: string) => readFileSync(path, 'utf8').split(/\r\n|\r|\n/);
const leaves = (target: string) => SCHEME.test(target) || target.startsWith('<');

/** Every file under `top`, descending into symlinked folders only with `followLinks`. */
function walk(top: string, followLinks: boolean): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(top, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(top, entry.name);
    const folder = entry.isDirectory() || (entry.isSymbolicLink() && isDir(path));
    if (!folder) found.push(path);
    else if (followLinks || !entry.isSymbolicLink()) found.push(...walk(path, followLinks));
  }
  return found;
}

/** GitHub's anchor for a heading: lowercase, punctuation dropped, spaces to hyphens. */
export function slug(heading: string): string {
  const text = heading.replace(/`|\*\*|__|\[([^\]]*)\]\([^)]*\)/g, (_, label: string | undefined) => label ?? '');
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replaceAll(' ', '-');
}

/** Every anchor a Markdown file's headings make, numbered as GitHub numbers repeats. */
export function anchors(path: string): Set<string> {
  const found = new Set<string>();
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of lines(path)) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : HEADING.exec(line);
    if (!heading) continue;
    const base = slug(heading[2] ?? '');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    found.add(n === 0 ? base : `${base}-${n}`);
  }
  return found;
}

/** [line number, target] for every inline link outside code fences and code spans. */
export function links(path: string): [number, string][] {
  const found: [number, string][] = [];
  let fenced = false;
  lines(path).forEach((line, index) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(LINK)) found.push([index + 1, m[2] ?? '']);
  });
  return found;
}

/** Each relative link or anchor in one Markdown file that doesn't resolve, as a message. */
export function broken(path: string): string[] {
  const problems: string[] = [];
  for (const [number, target] of links(path)) {
    if (leaves(target)) continue;
    const [file = '', ...rest] = target.split('#');
    const anchor = rest.join('#');
    const resolved = file ? join(dirname(path), file) : path;
    if (!existsSync(resolved)) problems.push(`${path}:${number}: ${target}: no such file`);
    else if (anchor && resolved.endsWith('.md') && isFile(resolved) && !anchors(resolved).has(anchor)) {
      problems.push(`${path}:${number}: ${target}: no heading makes #${anchor}`);
    }
  }
  return problems;
}

/** Every problem in the Markdown under each path, walked lexically, as an agent resolves it. */
export function check(paths: readonly string[]): string[] {
  const problems: string[] = [];
  for (const top of paths) {
    if (!existsSync(top)) {
      problems.push(`${top}: doesn't exist`);
      continue;
    }
    const files = isFile(top) ? [top] : walk(top, true).filter((f) => f.endsWith('.md')).sort();
    for (const path of files) problems.push(...broken(path));
  }
  return problems;
}

/** The files outside a skill that its Markdown links to, relative to the playbook's root. */
export function outside(root: string, skill: string): string[] {
  const folder = join(root, 'skills', skill);
  const found = new Set<string>();
  for (const path of walk(folder, false).filter((f) => f.endsWith('.md'))) {
    for (const [, target] of links(path)) {
      const file = target.split('#')[0] ?? '';
      if (!file || leaves(file)) continue;
      const resolved = join(dirname(path), file);
      if (relative(folder, resolved).startsWith('..')) found.add(relative(root, resolved) || '.');
    }
  }
  return [...found].sort();
}

/** Copy one skill into `into`, pointing each link that leaves it at the same file under `root`. */
export function install(root: string, into: string, skill: string): string {
  const source = join(root, 'skills', skill);
  const target = join(into, skill);
  if (!isFile(join(source, 'SKILL.md'))) throw new Stop(`${source}: no SKILL.md, so no skill '${skill}' in --root`);
  if (lexists(target)) {
    if (!isFile(join(target, MARKER))) throw new Stop(`${target} exists and this installer didn't write it: leaving it alone`);
    rmSync(target, { recursive: !lstatSync(target).isSymbolicLink(), force: true });
  }

  cpSync(source, target, { recursive: true, dereference: true });
  for (const path of walk(target, false).filter((f) => f.endsWith('.md'))) {
    const d = dirname(path);
    const original = join(source, relative(target, path));
    const point = (whole: string, open: string, link: string, close: string) => {
      const [file = '', ...rest] = link.split('#');
      if (!file || leaves(file)) return whole;
      const resolved = join(dirname(original), file);
      if (!relative(source, resolved).startsWith('..')) return whole;
      return `${open}${relative(d, resolved) || '.'}${rest.length ? `#${rest.join('#')}` : ''}${close}`;
    };
    writeFileSync(path, readFileSync(path, 'utf8').replace(/\r\n?/g, '\n').replace(LINK, point));
  }
  writeFileSync(join(target, MARKER), `${resolve(source)}\n`);
  return target;
}

const USAGE = `usage:
  install.ts --root <root> --into <skills-dir> <skill>...
  install.ts --manifest --root <root> <skill>...
  install.ts --check <path>...`;
const HELP = `Install approved skills, pointing their links at a pinned copy of the whole playbook.

${USAGE}

options:
  --root <root>         the pinned copy of the whole playbook
  --into <skills-dir>   the skills folder your harness reads, such as .claude/skills
  --manifest            print what each skill links to outside it
  --check               check every relative link and anchor in the Markdown under each path
  -h, --help            print this help
`;

/** A usage error: the usage and the reason on stderr, exit 2. */
const usageError = (message: string) => {
  stderr.write(`install.ts: ${message}\n${USAGE}\n`);
  return 2;
};

export function main(args: readonly string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        root: { type: 'string' },
        into: { type: 'string' },
        manifest: { type: 'boolean' },
        check: { type: 'boolean' },
      },
    });
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals: names } = parsed;
  if (values.help) {
    stdout.write(HELP);
    return 0;
  }
  if (!names.length) return usageError('name at least one skill, or a path with --check');

  if (values.check) {
    const problems = check(names);
    stdout.write(`${problems.join('\n') || `every link and anchor resolves under ${names.join(', ')}`}\n`);
    return problems.length ? 1 : 0;
  }
  if (!values.root) return usageError('--root is required to install or to print a manifest');
  if (values.manifest) {
    for (const skill of names) stdout.write(`${skill}:\n${outside(values.root, skill).map((path) => `  ${path}\n`).join('')}\n`);
    return 0;
  }
  if (!values.into) return usageError('--into is required to install');
  if (!isDir(dirname(resolve(values.into)))) throw new Stop(`${values.into}: its parent folder doesn't exist; is this the harness's folder?`);

  mkdirSync(values.into, { recursive: true });
  const { root, into } = values;
  const installed = names.map((skill) => install(root, into, skill));
  const problems = check(installed);
  stdout.write(`${problems.join('\n') || `installed ${names.join(', ')} into ${into}; every link resolves`}\n`);
  return problems.length ? 1 : 0;
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(argv.slice(2));
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
