/**
 * Fails when a change adds a copy of a function, class or const the repo already has, and warns
 * when it adds a near copy.
 *
 *     workspace-tools symbols check <base> [<head>]
 *     workspace-tools symbols check --all
 *
 * It checks the top-level declarations a change adds or changes since it left `<base>`: those in
 * `<head>`, or in the working tree without one, whose body differs from the same name's in the
 * same file at the merge base. It compares each with every other declaration at the head. So a
 * function moved to another file isn't a copy, and copies already on `<base>` are left alone.
 *
 * An exact copy has the same fingerprint, as `symbols.ts` makes it. A near copy's looser
 * fingerprint is at least 85% alike. A `// CLONE: <why>` comment above a declaration allows
 * it to copy. Tests, types and bodies under 40 nodes are left out.
 *
 * `--all` lists every copy in the working tree, new or not, but those a CLONE comment allows,
 * and always passes.
 *
 * Runs: in CI's static job on a pull request's merge into main, `check HEAD^1 HEAD`, where each copy
 * is an annotation on its line; locally as `check origin/main`.
 * Configure: the thresholds below. Before changing one, replay your last 30 merged pull requests
 * (see the README) and read every copy it reports.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { env } from 'node:process';

import {
  filesAt,
  git,
  indexed,
  likeness,
  repoRoot,
  type SourceSymbol,
  symbolCache,
  workingFiles,
} from './symbols.ts';

// The smallest body that counts: one-line wrappers and getters repeat for good reasons.
const minSize = 40;

// The least a near copy's looser fingerprint is alike, from 0 to 1.
const nearAlike = 0.85;

// A run of tokens more bodies than this share, such as a common call, says little about any of
// them, so it doesn't pick which bodies to compare.
const commonRun = 64;

const comparable = (symbol: SourceSymbol) =>
  !symbol.test && symbol.kind !== 'type' && symbol.size >= minSize;

/** A declaration that copies others exactly, or one nearly. */
export interface Copy {
  readonly exact: boolean;
  readonly copy: SourceSymbol;
  /** Every other declaration with its fingerprint, or the one most like it. */
  readonly of: ReadonlyArray<SourceSymbol>;
  /** How alike their looser fingerprints are, from 0 to 1. */
  readonly alike: number;
}

/** The declarations at a head, as copies are looked up among them. */
interface Index {
  readonly symbols: ReadonlyArray<SourceSymbol>;
  readonly byHash: ReadonlyMap<string, ReadonlyArray<SourceSymbol>>;
  readonly byRun: ReadonlyMap<number, ReadonlyArray<number>>;
}

const indexOf = (all: ReadonlyArray<SourceSymbol>): Index => {
  const symbols = all.filter(comparable);
  const byHash = new Map<string, Array<SourceSymbol>>();
  const byRun = new Map<number, Array<number>>();

  for (const [at, symbol] of symbols.entries()) {
    byHash.set(symbol.hash, [...(byHash.get(symbol.hash) ?? []), symbol]);

    for (const run of symbol.runs) {
      const holders = byRun.get(run);
      if (holders === undefined) byRun.set(run, [at]);
      else holders.push(at);
    }
  }

  return { symbols, byHash, byRun };
};

/** The declarations at least `nearAlike` like `target`, most alike first. */
const nearCopies = (target: SourceSymbol, index: Index) => {
  const counts = new Map<number, number>();
  let common = 0;

  for (const run of target.runs) {
    const holders = index.byRun.get(run) ?? [];

    if (holders.length > commonRun) {
      common += 1;
      continue;
    }

    for (const holder of holders) counts.set(holder, (counts.get(holder) ?? 0) + 1);
  }

  // Two sets at least `nearAlike` alike share that much of each, so a body that shares fewer
  // runs than that, counting every common run as shared, can't be.
  const needed = nearAlike * target.runs.length - common;

  return [...counts]
    .flatMap(([at, count]) => {
      const other = index.symbols[at];
      if (other === undefined || other === target || count < needed) return [];

      const sizes = [other.runs.length, target.runs.length];
      if (Math.min(...sizes) < nearAlike * Math.max(...sizes)) return [];

      const alike = likeness(target.runs, other.runs);

      return alike >= nearAlike ? [{ other, alike }] : [];
    })
    .sort((a, b) => b.alike - a.alike);
};

const pairKey = (a: SourceSymbol, b: SourceSymbol) =>
  [`${a.file}:${a.name}`, `${b.file}:${b.name}`].sort().join(' ');

/**
 * The copies among `changed`: each with every declaration that has its fingerprint, or failing
 * that, the one most like it. Each group of exact copies and each near pair is listed once, and a
 * declaration with a CLONE comment never.
 */
export const copiesIn = (
  symbols: ReadonlyArray<SourceSymbol>,
  changed: ReadonlyArray<SourceSymbol>,
): ReadonlyArray<Copy> => {
  const index = indexOf(symbols);
  const listed = new Set<string>();
  const copies: Array<Copy> = [];

  for (const copy of changed) {
    if (!comparable(copy) || copy.clone !== undefined) continue;

    // An exported declaration is the one to reuse, so it's named first.
    const same = (index.byHash.get(copy.hash) ?? [])
      .filter((other) => other !== copy)
      .sort((a, b) => Number(b.exported) - Number(a.exported) || a.file.localeCompare(b.file));

    if (same.length > 0) {
      if (!listed.has(copy.hash)) copies.push({ exact: true, copy, of: same, alike: 1 });

      listed.add(copy.hash);
      continue;
    }

    const [nearest] = nearCopies(copy, index);
    const pair = nearest === undefined ? undefined : pairKey(copy, nearest.other);
    if (nearest === undefined || pair === undefined || listed.has(pair)) continue;

    listed.add(pair);
    copies.push({ exact: false, copy, of: [nearest.other], alike: nearest.alike });
  }

  return copies;
};

const gitText = (root: string, args: ReadonlyArray<string>) => git(root, args).toString('utf8');

const pathList = (output: string) => output.split('\0').filter((path) => indexed(path));

/** A declaration's file, name and body together, which a change to any of them changes. */
const versionOf = (symbol: SourceSymbol) => `${symbol.file}\0${symbol.name}\0${symbol.hash}`;

/**
 * The declarations at `head`, or in the working tree without one, and those of them the change
 * since it left `base` adds, or whose body it changes.
 */
export const changedSince = (root: string, base: string, head?: string) => {
  const mergeBase = gitText(root, ['merge-base', base, head ?? 'HEAD']).trim();
  const paths = new Set(
    head === undefined
      ? [
          ...pathList(gitText(root, ['diff', '--name-only', '-z', mergeBase])),
          ...pathList(gitText(root, ['ls-files', '-z', '--others', '--exclude-standard'])),
        ]
      : pathList(gitText(root, ['diff', '--name-only', '-z', mergeBase, head])),
  );

  const cache = symbolCache(root);
  const before = new Set(
    filesAt(root, mergeBase, [...paths])
      .flatMap(cache.symbolsOf)
      .map(versionOf),
  );
  const symbols = (head === undefined ? workingFiles(root) : filesAt(root, head)).flatMap(
    cache.symbolsOf,
  );
  const changed = symbols.filter(
    (symbol) => paths.has(symbol.file) && !before.has(versionOf(symbol)),
  );
  cache.save();

  return { symbols, changed };
};

const where = (symbol: SourceSymbol) => `${symbol.file}:${symbol.line}`;

const percent = (alike: number) => `${Math.floor(alike * 100)}%`;

/** The declarations a copy copies, as `joined at a.ts:3, joined at b.ts:9 and 1 more`. */
const named = (symbols: ReadonlyArray<SourceSymbol>) => {
  const shown = symbols.slice(0, 2).map((symbol) => `${symbol.name} at ${where(symbol)}`);
  const more = symbols.length - shown.length;

  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(' and ');
};

/** One line for a copy: a GitHub annotation on its line in CI, or plain text. */
const reported = (copy: Copy, github: boolean) => {
  const original = copy.of[0]?.name ?? '';
  const what = copy.exact
    ? `${copy.copy.name} has the same body as ${named(copy.of)}`
    : copy.alike === 1
      ? `${copy.copy.name} is ${named(copy.of)} with other names in it`
      : `${copy.copy.name} is ${percent(copy.alike)} like ${named(copy.of)}`;
  const advice = copy.exact
    ? `Reuse ${original}, or say why not in a "// CLONE: <why>" comment above ${copy.copy.name}.`
    : `If they do the same job, reuse ${original}.`;
  if (!github) return `${copy.exact ? 'copy' : 'near copy'}: ${where(copy.copy)} ${what}`;

  const level = copy.exact ? 'error' : 'warning';
  const title = `${copy.exact ? 'Copy' : 'Near copy'} of ${original}`;

  return `::${level} file=${copy.copy.file},line=${copy.copy.line},title=${title}::${what}. ${advice}`;
};

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * Every copy in the working tree but those a CLONE comment allows, largest first: the exact
 * groups, then the near pairs.
 */
const reportAll = (root: string) => {
  const cache = symbolCache(root);
  const symbols = workingFiles(root)
    .flatMap(cache.symbolsOf)
    .filter((symbol) => symbol.clone === undefined);
  cache.save();
  const exact = [...indexOf(symbols).byHash.values()]
    .filter((group) => group.length > 1)
    .sort((a, b) => (b[0]?.size ?? 0) - (a[0]?.size ?? 0));
  const near = copiesIn(symbols, symbols.filter(comparable)).filter((copy) => !copy.exact);

  console.log(`Exact copies, ${count(exact.length, 'group')}:`);

  for (const group of exact) {
    console.log(
      `  ${group[0]?.size} nodes: ${group.map((s) => `${s.name} ${where(s)}`).join(', ')}`,
    );
  }

  console.log(`\nNear copies, ${count(near.length, 'pair')}:`);

  for (const copy of near.sort((a, b) => b.copy.size - a.copy.size)) {
    console.log(
      `  ${percent(copy.alike)}: ${copy.copy.name} ${where(copy.copy)}, ${named(copy.of)}`,
    );
  }
};

export const checkUsage = [
  'usage: workspace-tools symbols check <base> [<head>]',
  '       workspace-tools symbols check --all',
].join('\n');

/** Checks the repo `from` is in, as `args` ask, and answers the exit code. */
export const symbolsCheck = (args: ReadonlyArray<string>, from: string) => {
  const root = repoRoot(from);
  const [base, head, ...rest] = args.filter((arg) => arg !== '--all');

  if (args.includes('--all')) {
    if (base !== undefined) {
      console.error(checkUsage);

      return 2;
    }

    reportAll(root);

    return 0;
  }

  if (base === undefined || rest.length > 0 || base.startsWith('-')) {
    console.error(checkUsage);

    return 2;
  }

  const { symbols, changed } = changedSince(root, base, head);
  const copies = copiesIn(symbols, changed);
  const exact = copies.filter((copy) => copy.exact).length;
  const github = env['GITHUB_ACTIONS'] === 'true';

  for (const copy of copies) console.log(reported(copy, github));

  if (exact > 0 && !github) {
    console.log(
      'Reuse the existing one, or say why not in a "// CLONE: <why>" comment above the copy.',
    );
  }

  console.log(
    `symbols: ${count(changed.length, 'new or changed declaration')}, of ${count(symbols.length, 'declaration')} in all: ${count(exact, 'copy', 'copies')}, ${count(copies.length - exact, 'near copy', 'near copies')}`,
  );

  return exact > 0 ? 1 : 0;
};
