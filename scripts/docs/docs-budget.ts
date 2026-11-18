#!/usr/bin/env node
/**
 * docs-budget.ts: fails when a doc agents load outgrows its budget, so bloat you compacted can't
 * grow back.
 *
 *     node scripts/docs/docs-budget.ts
 *
 * It reads the Markdown the repo tracks, from the root of the checkout it runs in. Root
 * `AGENTS.md` and every skill's description load into every agent session, and a folder's
 * `AGENTS.md` or a `SKILL.md` whenever an agent works there, so each byte costs on each run. The
 * skill list has a budget of its own in some harnesses, and a skill past it loses its description.
 * `GLOSSARY.md` is read and searched often. The default budgets came from what each held after a
 * compaction, with headroom:
 *
 * - Every skill's description, upstream copies too: at most 320 characters. An upkeep run that
 *   updates a copy can bring its source's longer description back, and fails here until it's cut.
 * - The repo's own `SKILL.md`: at most 10 KB. Upstream copies, those `skills-lock.json` names and
 *   those `upstreamPrefixes` match, are left as their source wrote them.
 * - Root `AGENTS.md`: at most 12 KB. Any other `AGENTS.md`: at most 8 KB. A shared rules file every
 *   `AGENTS.md` imports, so it loads beside each one: at most 8 KB.
 * - `GLOSSARY.md`: no tables, since formatters pad each cell to its column's widest, and no entry
 *   over 400 characters.
 * - None of these keeps history, such as "Changed 15 Oct 2026": `git log` holds it.
 *
 * Runs: in CI's static job, and locally before a push. Node 24 and `git` only.
 * Configure: the CONFIG block: budgets, where skills live, the upstream lock and prefixes, and
 * the rules file. See docs/pages/17-keeping-agent-knowledge-from-going-stale.md.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, cwd, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------------------------

export const budgets = {
  description: 320,
  skill: 10_000,
  rootAgents: 12_000,
  agents: 8_000,
  rules: 8_000,
  glossaryEntry: 400,
};

export interface Layout {
  /** A skill's `SKILL.md`, whose first group is the skill's folder name. */
  readonly skillPath: RegExp;
  /** The skills CLI's lock at the root, naming the skills it installed, or undefined for none. */
  readonly upstreamLock: string | undefined;
  /** Folder-name prefixes of skills copied from upstream without the lock, such as a vendor's. */
  readonly upstreamPrefixes: ReadonlyArray<string>;
  /** The shared rules file every `AGENTS.md` imports, or undefined for none. */
  readonly rules: string | undefined;
  readonly glossary: string;
}

export const layout: Layout = {
  skillPath: /^\.agents\/skills\/([^/]+)\/SKILL\.md$/,
  upstreamLock: 'skills-lock.json',
  upstreamPrefixes: [],
  rules: 'RULES.md',
  glossary: 'GLOSSARY.md',
};

// ---------------------------------------------------------------------------------------------

/** A tracked file: its path from the root, and its text. */
export interface Doc {
  readonly path: string;
  readonly text: string;
}

const history = /(?:Changed|Decided|Renamed|Hidden|Dropped|Added) \d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{4}/;

/**
 * A `SKILL.md`'s frontmatter description, as one line: plain, quoted, or a folded `>-` block.
 * `undefined` when it has none.
 */
export const description = (text: string) => {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
  const lines = frontmatter?.split('\n') ?? [];
  const start = lines.findIndex((line) => line.startsWith('description:'));
  if (start === -1) return undefined;

  const first = (lines[start] ?? '').slice('description:'.length).trim();
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => !line.startsWith(' '));
  const folded = (end === -1 ? rest : rest.slice(0, end)).map((line) => line.trim());

  const value = /^[>|]-?$/.test(first) ? folded.join(' ') : first;

  return value.replace(/^(["'])([\s\S]*)\1$/, '$2');
};

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

const kb = (size: number) => `${(size / 1000).toFixed(1)} KB`;

/** What the docs break, one line each, with what to do about it. */
export const problems = (docs: ReadonlyArray<Doc>, upstream: ReadonlySet<string>, shape = layout, limits = budgets) => {
  const found: Array<string> = [];

  for (const { path, text } of docs) {
    const skill = shape.skillPath.exec(path)?.[1];
    const agents = path === 'AGENTS.md' || path.endsWith('/AGENTS.md');
    const rules = shape.rules !== undefined && path === shape.rules;
    const glossary = path === shape.glossary;
    if (skill === undefined && !agents && !rules && !glossary) continue;

    const ours = skill === undefined || !(upstream.has(skill) || shape.upstreamPrefixes.some((prefix) => skill.startsWith(prefix)));
    const said = history.exec(text)?.[0];

    if (ours && said !== undefined) found.push(`${path}: "${said}" is history; leave it to git log and say what holds now.`);

    if (skill !== undefined) {
      const about = description(text) ?? '';

      if (about.length > limits.description)
        found.push(
          `${path}: its description is ${String(about.length)} characters, over ${String(limits.description)}. Say what it does, when to use it and which sibling to use instead; cut the method.`,
        );

      if (ours && bytes(text) > limits.skill)
        found.push(`${path}: ${kb(bytes(text))}, over ${kb(limits.skill)}. Move what one step or case needs to references/, and point to code instead of restating it.`);
    }

    if (agents || rules) {
      const limit = rules ? limits.rules : path === 'AGENTS.md' ? limits.rootAgents : limits.agents;

      if (bytes(text) > limit)
        found.push(`${path}: ${kb(bytes(text))}, over ${kb(limit)}. Keep each rule in one place, link the skill or script that owns the detail, and point to code for values.`);
    }

    if (glossary) {
      const lines = text.split('\n');

      if (lines.some((line) => line.startsWith('|'))) found.push(`${path}: has a table. Write each term as \`**Term**: meaning\`, since formatters pad table cells.`);

      for (const entry of lines.filter((line) => line.startsWith('**'))) {
        if (entry.length <= limits.glossaryEntry) continue;

        const term = /^\*\*(.+?)\*\*/.exec(entry)?.[1] ?? entry.slice(0, 40);
        found.push(
          `${path}: ${term} is ${String(entry.length)} characters, over ${String(limits.glossaryEntry)}. Keep its meaning, the word to use and where it lives in code; the code says how it behaves.`,
        );
      }
    }
  }

  return found;
};

/** The skills the skills CLI installed, by folder name, from the lock at `root`: none without one. */
export const upstreamSkills = (root: string, shape = layout): ReadonlySet<string> => {
  if (shape.upstreamLock === undefined) return new Set();

  const path = join(root, shape.upstreamLock);
  if (!existsSync(path)) return new Set();

  // The lock's `skills` maps each locked skill's folder name to its source; only the names are read.
  const lock = JSON.parse(readFileSync(path, 'utf8')) as { readonly skills?: Readonly<Record<string, unknown>> };

  return new Set(Object.keys(lock.skills ?? {}));
};

/** The Markdown the checkout at `root` tracks, each by its path from the root, with its text. */
export const trackedDocs = (root: string): ReadonlyArray<Doc> =>
  execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path !== '')
    .map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));

/** The checkout `from` is in: its root, its tracked docs, and what they break. */
export const docsBudget = (from: string, shape = layout) => {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: from, encoding: 'utf8' }).trim();
  const docs = trackedDocs(root);

  return { root, docs, problems: problems(docs, upstreamSkills(root, shape), shape) };
};

if (argv[1] === fileURLToPath(import.meta.url)) {
  if (argv.length > 2) {
    console.error('usage: node scripts/docs/docs-budget.ts');
    exit(2);
  }

  const { docs, problems: found } = docsBudget(cwd());

  for (const line of found) console.error(line);

  if (found.length > 0) exit(1);

  console.error(`docs-budget: ${String(docs.length)} Markdown files within budget`);
}
