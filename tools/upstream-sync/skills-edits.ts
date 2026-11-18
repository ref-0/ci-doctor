#!/usr/bin/env node
/**
 * skills-edits.ts: puts back your edits to skills a skills package manager installed, after it
 * installs or updates them, and lists the hand-edited copies it must not overwrite. Running it
 * twice changes nothing.
 *
 *     node skills-edits.ts            # in the repo's root: reapply the edits, print each file changed
 *     node skills-edits.ts --edited   # print each hand-edited copy as: folder<TAB>repo<TAB>path<TAB>baseline
 *
 * The skills CLI's lock (`skills-lock.json`) maps each installed skill's folder to its source and,
 * when renamed, its upstream `skillName`. A rename changes only a skill's folder and frontmatter
 * name, so this:
 *
 * - rewrites each mention of a renamed sibling to its local name, in the `SKILL.md` and
 *   `references/` of the skills from the same source;
 * - deletes the table rows that point at a skill you leave out;
 * - puts back the description you wrote for each skill in `ours`, from git's `HEAD`, so a longer
 *   upstream description can't break the docs budget's 320 characters.
 *
 * Hand-edited copies, such as test-audit, are outside the lock: the package manager must never
 * overwrite them. `edited` records each one's upstream and the commit it was copied from, so the
 * upstream workflow diffs upstream since then for a person to carry over by hand.
 *
 * Runs: in upstream-skills.yml's job, in a throwaway checkout, and locally. Node 24 and `git` only.
 * Tests: `node --test skills-edits.test.ts`.
 * Configure: `adaptations.json` beside this file (see adaptations.example.json).
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { argv, cwd, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

/** Your edits, as adaptations.json holds them. */
export interface Adaptations {
  /** Where installed skills live, from the repo's root. */
  readonly skillsDir: string;
  /** Locked skills whose description is yours, cut to the docs budget. */
  readonly ours: ReadonlyArray<string>;
  /** Upstream skills you don't install, whose table rows in the others go. */
  readonly leftOut: ReadonlyArray<string>;
  /** File names that keep upstream's names, such as a feedback page that files issues upstream. */
  readonly keepsUpstreamNames: ReadonlyArray<string>;
  /** Hand-edited copies outside the lock, and where they came from. */
  readonly edited: ReadonlyArray<{ readonly folder: string; readonly repo: string; readonly path: string; readonly baseline: string }>;
}

interface Lock {
  readonly skills: Readonly<Record<string, { readonly source: string; readonly skillName?: string }>>;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Each renamed skill's upstream name and its local name, for each source, from the lock. */
export const renames = (lock: Lock) => {
  const bySource = new Map<string, Map<string, string>>();

  for (const [name, entry] of Object.entries(lock.skills)) {
    if (entry.skillName === undefined || entry.skillName === name) continue;

    const names = bySource.get(entry.source) ?? new Map<string, string>();
    names.set(entry.skillName, name);
    bySource.set(entry.source, names);
  }

  return bySource;
};

/**
 * One file's text with every mention of a renamed sibling rewritten and the rows pointing at a
 * left-out skill deleted. A name in backticks or a relative link's path is always a skill's; a bare
 * name only when it holds a hyphen, since a one-word name is often also a CLI or a package.
 */
export const rewrite = (text: string, names: ReadonlyMap<string, string>, leftOut: ReadonlyArray<string>) => {
  let next = text;

  for (const [upstream, here] of names) {
    const name = escape(upstream);
    next = next.replace(new RegExp(`\`${name}\``, 'g'), `\`${here}\``).replace(new RegExp(`(\\]\\((?:\\.\\./)+)${name}/`, 'g'), `$1${here}/`);

    if (!upstream.includes('-')) continue;

    next = next.replace(new RegExp(`(?<![\\w./@-])${name}(?![\\w/-]|\\.\\w)`, 'g'), here);
  }

  const rows = leftOut.map((skill) => new RegExp(`^\\|.*${escape(skill)}.*\\n`, 'gm'));

  return rows.reduce((kept, row) => kept.replace(row, ''), next);
};

/** The frontmatter's `description:` line and its indented continuation lines, as line indexes. */
const descriptionLines = (lines: ReadonlyArray<string>) => {
  const start = lines.findIndex((line) => line.startsWith('description:'));
  if (start === -1) return undefined;

  let end = start + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end] ?? '')) end += 1;

  return { start, end };
};

/** `text` with its description taken from `previous`, or unchanged when either has none. */
export const withDescription = (text: string, previous: string) => {
  const lines = text.split('\n');
  const before = previous.split('\n');
  const here = descriptionLines(lines);
  const there = descriptionLines(before);
  if (here === undefined || there === undefined) return text;

  lines.splice(here.start, here.end - here.start, ...before.slice(there.start, there.end));

  return lines.join('\n');
};

/** A skill folder's Markdown that names siblings: its `SKILL.md` and everything in `references/`. */
const markdown = (folder: string, keeps: ReadonlySet<string>) => {
  const references = join(folder, 'references');
  const found = existsSync(references) ? readdirSync(references, { recursive: true, encoding: 'utf8' }).filter((path) => path.endsWith('.md')) : [];

  return [join(folder, 'SKILL.md'), ...found.filter((path) => !keeps.has(path.split('/').at(-1) ?? '')).map((path) => join(references, path))].filter((path) => existsSync(path));
};

/**
 * Applies the edits in the checkout at `root`. `previous` reads a file as you last saved it, or
 * returns `undefined` when there's none. Returns the files it changed.
 */
export const applyEdits = (root: string, edits: Adaptations, previous: (path: string) => string | undefined) => {
  const lock = JSON.parse(readFileSync(join(root, 'skills-lock.json'), 'utf8')) as Lock;
  const bySource = renames(lock);
  const keeps = new Set(edits.keepsUpstreamNames);
  const changed: Array<string> = [];

  for (const [name, entry] of Object.entries(lock.skills)) {
    const folder = join(root, edits.skillsDir, name);
    const names = bySource.get(entry.source) ?? new Map<string, string>();

    for (const path of markdown(folder, keeps)) {
      const text = readFileSync(path, 'utf8');
      let next = rewrite(text, names, edits.leftOut);

      const saved = edits.ours.includes(name) && path.endsWith('SKILL.md') ? previous(path) : undefined;
      if (saved !== undefined) next = withDescription(next, saved);

      if (next === text) continue;

      writeFileSync(path, next);
      changed.push(relative(root, path));
    }
  }

  return changed;
};

/** A file as git's `HEAD` holds it, or `undefined` when it holds none. */
export const atHead = (root: string) => (path: string) => {
  const shown = spawnSync('git', ['show', `HEAD:${relative(root, path)}`], { cwd: root, encoding: 'utf8' });

  return shown.status === 0 ? shown.stdout : undefined;
};

if (argv[1] === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const edits = JSON.parse(readFileSync(join(here, 'adaptations.json'), 'utf8')) as Adaptations;
  const args = argv.slice(2);

  if (args.length === 1 && args[0] === '--edited') {
    for (const copy of edits.edited) console.log([copy.folder, copy.repo, copy.path, copy.baseline].join('\t'));
    exit(0);
  }

  if (args.length > 0) {
    console.error('usage: node skills-edits.ts [--edited]');
    exit(2);
  }

  const root = cwd();
  for (const path of applyEdits(root, edits, atHead(root))) console.log(path);
}
