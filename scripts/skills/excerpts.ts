#!/usr/bin/env node
/**
 * Writes the ci-doctor hub's phase excerpts: the parts of the guide and the reference READMEs that
 * Phases 0–3 need, copied from their sources so a skills-only install can run those phases.
 *
 *     node scripts/skills/excerpts.ts          write skills/ci-doctor/references/excerpts/
 *     node scripts/skills/excerpts.ts --check  fail if any excerpt differs from its sources
 *
 * Each fact keeps one home: edit the source, then run this. The excerpt files say so at the top,
 * and the build checks (`scripts/check.ts`) fail on a stale one. A section is a heading and
 * everything under it, up to the next heading of the same or a higher level. An item is one
 * top-level list item that opens with a bold label, such as `- **Trust:**`, with its nested lines,
 * under a heading of that label. Links are rewritten to resolve from the excerpt, and a bare
 * `#anchor` points back at its source.
 *
 * The techniques index lists each guide page's H2s, each with the `**Applies when:** …
 * **Skip when:** …` line directly under it. A page with no H2 carries that line under its H1, and
 * any page may. A heading the index lists without one fails the build.
 *
 * Runs: from the repo's root. Node 24 only. Tests: `node --test excerpts.test.ts`, from this folder.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, posix, relative } from 'node:path';
import { argv, cwd } from 'node:process';
import { fileURLToPath } from 'node:url';

export const OUT = 'skills/ci-doctor/references/excerpts';

/** A section by its heading's text, or a list item by its bold label. */
export type Piece = string | { readonly item: string };

/** One part of an excerpt: sections or items of a source, a whole source, or a generated index. */
export type Part =
  | { readonly from: string; readonly sections: ReadonlyArray<Piece>; readonly why: string }
  | { readonly from: string; readonly whole: true; readonly why: string }
  | { readonly index: ReadonlyArray<string>; readonly why: string };

export interface Excerpt {
  readonly phase: number;
  readonly title: string;
  readonly parts: ReadonlyArray<Part>;
}

const pages = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i).map((n) => `docs/pages/${String(n).padStart(2, '0')}-`);

/** What each phase carries, per the skills plan's "What the hub carries" table. */
export const EXCERPTS: ReadonlyArray<Excerpt> = [
  {
    phase: 0,
    title: 'Phase 0: harnesses and prerequisites',
    parts: [
      { from: 'docs/harnesses.md', whole: true, why: 'Which harness you are, and what it can run: subagents, worktrees and schedules.' },
      { from: 'scripts/local/README.md', sections: ['What the machine needs'], why: 'The conditional prerequisites, for a plan that uses the local scripts.' },
    ],
  },
  {
    phase: 1,
    title: 'Phase 1: the techniques and the planner',
    parts: [
      { index: [...pages(2, 17), ...pages(21, 21)], why: 'Every technique in guide sections 2–17 and 21, by section, each with when it applies and when to skip it. Mark each that applies and bears on the measured limiter, and read its section only then.' },
      { from: 'docs/pages/18-tried-and-dropped.md', whole: true, why: 'What was tried and dropped, and what would have to change before trying again.' },
      { from: 'docs/pages/20-thresholds-cheat-sheet.md', whole: true, why: "The source repo's starting values, as examples, not targets." },
      { from: 'docs/pages/04-run-only-what-a-change-can-reach.md', sections: ['Turborepo and Nx: their own affected runs first'], why: 'Selection with Turborepo or Nx.' },
      { from: 'docs/pages/05-tiers-what-runs-where.md', sections: ['Releasing what the sweep checked'], why: 'The release checklist each shipping path is mapped to, before any PR coverage moves to a sweep.' },
      { from: 'docs/pages/06-reuse-work-by-its-real-inputs.md', sections: ['Task runners and their remote caches', { item: 'Trust' }], why: "Guide section 6's cache table, and the trust policy a shared cache needs." },
      { from: 'docs/pages/14-local-speed-and-many-agents-on-one-machine.md', sections: ['The local runner contract'], why: 'What a local runner of selected tests must do before its green means they ran.' },
      { from: 'templates/plan/README.md', sections: ['The rules, in order', 'Left out of the reference'], why: "The selection planner's inputs and its limits." },
    ],
  },
  {
    phase: 2,
    title: 'Phase 2: collecting the baseline',
    parts: [
      { from: 'docs/pages/13-records-evidence-of-what-ran.md', sections: ['Collecting from the API without losing runs'], why: 'The read-only collection recipe: pagination, attempts and what you couldn\'t read.' },
      { from: 'scripts/records/README.md', sections: ['1. The reporter', 'Python tests'], why: 'Per-file timings: what Vitest needs, and what pytest already writes.' },
      { from: 'docs/pages/12-budgets-health-and-spend.md', sections: [{ item: 'Audit spend over comparable windows' }], why: 'The audit rules for comparing spend across windows.' },
      { from: 'docs/pages/14-local-speed-and-many-agents-on-one-machine.md', sections: ['Sharing one machine'], why: "Test slots on a shared machine: Phase 0's settings and Phase 2's local contention." },
    ],
  },
  {
    phase: 3,
    title: 'Phase 3: the decision tables',
    parts: [
      { from: 'docs/pages/02-runners-blacksmith-and-the-cost-of-getting-fast.md', sections: ['Choosing a provider and runners', 'When jobs wait to start'], why: 'Choosing runners, and telling a queue from slow work. Prices change: check the provider\'s page, and say "unknown" when you can\'t.' },
      { from: 'scripts/shards/README.md', sections: ['Start simple: a fixed split'], why: 'The first shards.' },
      { from: 'docs/pages/06-reuse-work-by-its-real-inputs.md', sections: ['Checking a cache on another task runner'], why: 'Checking a cache before the plan relies on it.' },
      { from: 'docs/pages/16-standing-automations.md', whole: true, why: 'The automations table, for the plan\'s automations step.' },
      { from: 'docs/pages/10-slow-tests-the-method.md', sections: ['Name the wait before changing anything'], why: 'The slow-test fix table, for each file in the inventory.' },
      { from: 'docs/pages/17-keeping-agent-knowledge-from-going-stale.md', whole: true, why: "Where agent knowledge lives and what keeps it fresh, for the plan's agent-knowledge step." },
    ],
  },
];

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const LINK = /(\]\(\s*<?)([^)\s>]+)(>?(?:\s+"[^"]*")?\s*\))/g;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|<)/i;

/** GitHub's heading slug, as scripts/docs/check-links.ts makes it. */
export const slug = (heading: string) =>
  heading
    .replace(/`/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\- _]/gu, '')
    .replace(/ /g, '-');

/** Each line with whether it's inside a code fence. */
const fenced = (lines: ReadonlyArray<string>) => {
  let fence: string | undefined;
  return lines.map((line) => {
    const mark = FENCE.exec(line)?.[1]?.[0];
    if (mark) {
      if (fence === undefined) fence = mark;
      else if (fence === mark) fence = undefined;
      return true;
    }
    return fence !== undefined;
  });
};

/** Point a source's relative links at the same files from the excerpt. */
export const relink = (text: string, source: string, out: string) => {
  const lines = text.split('\n');
  const inside = fenced(lines);
  return lines
    .map((line, i) => {
      if (inside[i]) return line;
      return line
        .split(/(`[^`]*`)/)
        .map((part) =>
          part.startsWith('`')
            ? part
            : part.replace(LINK, (whole, open: string, target: string, close: string) => {
                if (EXTERNAL.test(target)) return whole;
                const hash = target.indexOf('#');
                const path = hash === -1 ? target : target.slice(0, hash);
                const anchor = hash === -1 ? '' : target.slice(hash);
                const resolved = path === '' ? source : normalize(join(dirname(source), path));
                let rel = relative(dirname(out), resolved).split('\\').join('/');
                if (path.endsWith('/') && !rel.endsWith('/')) rel += '/';
                return `${open}${rel}${anchor}${close}`;
              }),
        )
        .join('');
    })
    .join('\n');
};

/** A source's lines, its title (its first H1), and the body below the title. */
const read = (root: string, path: string) => {
  const full = join(root, path);
  if (!existsSync(full)) throw new Error(`${path}: no such source`);
  const lines = readFileSync(full, 'utf8').replace(/\r\n?/g, '\n').split('\n');
  const inside = fenced(lines);
  const h1 = lines.findIndex((line, i) => !inside[i] && /^# /.test(line));
  const title = h1 === -1 ? path : (HEADING.exec(lines[h1] ?? '')?.[2] ?? path);
  return { lines, inside, h1, title };
};

/** Shift a block's headings so its top one is level `top`. */
const shift = (lines: ReadonlyArray<string>, inside: ReadonlyArray<boolean>, from: number, top: number) =>
  lines.map((line, i) => {
    const m = inside[i] ? null : HEADING.exec(line);
    if (!m) return line;
    const level = Math.min(6, Math.max(1, (m[1]?.length ?? 1) - from + top));
    return `${'#'.repeat(level)} ${m[2]}`;
  });

/** One section of a source: its heading's block, with the heading shifted to level 3. */
export const section = (root: string, path: string, heading: string) => {
  const { lines, inside } = read(root, path);
  const start = lines.findIndex((line, i) => !inside[i] && HEADING.exec(line)?.[2] === heading);
  if (start === -1) throw new Error(`${path}: no heading "${heading}"`);
  const level = HEADING.exec(lines[start] ?? '')?.[1]?.length ?? 2;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = inside[i] ? null : HEADING.exec(lines[i] ?? '');
    if (m && (m[1]?.length ?? 7) <= level) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start, end);
  return { level, block: shift(block, inside.slice(start, end), level, 3).join('\n').trim() };
};

/** One top-level list item that opens with `**<label>:**` or `**<label>.**`, under a level-3 heading of the label. */
export const item = (root: string, path: string, label: string) => {
  const { lines, inside } = read(root, path);
  const opens = (line: string) => line.startsWith(`- **${label}:**`) || line.startsWith(`- **${label}.**`);
  const starts = lines.flatMap((line, i) => (!inside[i] && opens(line) ? [i] : []));
  if (starts.length !== 1) throw new Error(`${path}: ${starts.length} items labelled "${label}", not 1`);
  const start = starts[0] ?? 0;
  let end = start + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end] ?? '')) end++;
  return [`### ${label}`, '', ...lines.slice(start, end)].join('\n');
};

/** The `**Applies when:**` line directly under the heading on line `at`, if it has one. */
const appliesUnder = (lines: ReadonlyArray<string>, at: number) => {
  const next = lines.slice(at + 1).find((line) => line.trim() !== '') ?? '';
  return /^\*\*Applies when:\*\* .+ \*\*Skip when:\*\* .+\.$/.test(next) ? next : undefined;
};

/** A whole source below its title, its headings shifted under level 2. */
const whole = (root: string, path: string) => {
  const { lines, inside, h1 } = read(root, path);
  const body = lines.slice(h1 + 1);
  return shift(body, inside.slice(h1 + 1), 2, 3).join('\n').trim();
};

/** Each page's title and its H2 headings, linked, each with when it applies: the techniques it holds. */
const index = (root: string, prefixes: ReadonlyArray<string>, out: string) => {
  const files = prefixes.map((prefix) => {
    const dir = dirname(prefix);
    const name = readdirNames(root, dir).find((f) => `${dir}/${f}`.startsWith(prefix));
    if (!name) throw new Error(`${prefix}*: no such page`);
    return `${dir}/${name}`;
  });
  return files
    .map((path) => {
      const { lines, inside, h1, title } = read(root, path);
      const link = posix.relative(dirname(out), path);
      const heads = lines.flatMap((line, i) => (!inside[i] && /^## /.test(line) ? [i] : []));
      const top = appliesUnder(lines, h1);
      if (heads.length === 0 && top === undefined) throw new Error(`${path}: no "**Applies when:** … **Skip when:** …" line under its title, and no H2s`);
      const rows = heads.map((i) => {
        const heading = HEADING.exec(lines[i] ?? '')?.[2] ?? '';
        const applies = appliesUnder(lines, i);
        if (applies === undefined) throw new Error(`${path}: no "**Applies when:** … **Skip when:** …" line under "${heading}"`);
        return `  - [${heading}](${link}#${slug(heading)}): ${applies}`;
      });
      return [`- **[${title}](${link})**${top ? `: ${top}` : ''}`, ...rows].join('\n');
    })
    .join('\n');
};

/** A folder's file names, sorted, so the index keeps the guide's order. */
const readdirNames = (root: string, dir: string) => readdirSync(join(root, dir)).sort();

/** A phase's page in the hub, by its number. */
const phaseFile = (root: string, phase: number) => {
  const name = readdirNames(root, 'skills/ci-doctor/references/phases').find((f) => f.startsWith(`phase-${phase}-`));
  if (!name) throw new Error(`no page for Phase ${phase}`);
  return name;
};

/** The text of one excerpt file. */
export const render = (root: string, excerpt: Excerpt) => {
  const out = `${OUT}/phase-${excerpt.phase}.md`;
  const sources = excerpt.parts.flatMap((p) => ('from' in p ? [p.from] : p.index.map((x) => `${x}*`)));
  const head = [
    `<!-- Generated by scripts/skills/excerpts.ts from ${[...new Set(sources)].join(', ')}. Edit those, then run it; never edit this file. -->`,
    '',
    `# ${excerpt.title}`,
    '',
    `Part of the [\`ci-doctor\`](../../SKILL.md) hub. What [Phase ${excerpt.phase}](../phases/${phaseFile(root, excerpt.phase)}) needs from the guide and the reference READMEs, copied from them so the phase runs where only the skills are installed. Each part links its source.`,
  ];
  const body = excerpt.parts.map((part) => {
    if ('index' in part) return [`## The techniques`, '', part.why, '', index(root, part.index, out)].join('\n');
    const { title } = read(root, part.from);
    const link = posix.relative(dirname(out), part.from);
    const piece = (p: Piece) => (typeof p === 'string' ? section(root, part.from, p).block : item(root, part.from, p.item));
    const text = 'whole' in part ? whole(root, part.from) : part.sections.map(piece).join('\n\n');
    return [`## ${title}`, '', `From [${part.from}](${link}). ${part.why}`, '', relink(text, part.from, out)].join('\n');
  });
  return `${[...head, '', ...body.flatMap((b) => [b, ''])].join('\n').trimEnd()}\n`;
};

/** Every excerpt file: [path from the root, its text]. */
export const build = (root: string): [string, string][] =>
  EXCERPTS.map((excerpt) => [`${OUT}/phase-${excerpt.phase}.md`, render(root, excerpt)]);

/** The excerpt files that differ from what their sources make now. */
export const stale = (root: string) =>
  build(root).filter(([path, text]) => !existsSync(join(root, path)) || readFileSync(join(root, path), 'utf8') !== text).map(([path]) => path);

if (argv[1] === fileURLToPath(import.meta.url)) {
  const root = cwd();
  if (argv.includes('--check')) {
    const old = stale(root);
    for (const path of old) console.log(`${path}: stale; run node scripts/skills/excerpts.ts`);
    console.log(old.length === 0 ? `excerpts: ${EXCERPTS.length} files match their sources` : `excerpts: ${old.length} stale`);
    process.exitCode = old.length === 0 ? 0 : 1;
  } else {
    for (const [path, text] of build(root)) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), text);
      console.log(`wrote ${path}`);
    }
  }
}
