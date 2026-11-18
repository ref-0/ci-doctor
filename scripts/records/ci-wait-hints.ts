#!/usr/bin/env node
/**
 * ci-wait-hints.ts: lists every test file past a time in CI, with hints of what it waits on, in
 * batches by area to review.
 *
 * Where it runs: anywhere, by hand, in a checkout, on a file of ci-records.ts's records. Node 24 or
 * later, no npm dependencies.
 *
 *     node ci-wait-hints.ts records.jsonl                       files past 10 s, one table
 *     node ci-wait-hints.ts records.jsonl --over 10 --out dir   and one TSV a batch, by area, in dir
 *
 * An area is a file's folder one level below its package's `src` (`--depth`). Areas of fewer than
 * `--min-batch` files share one batch, `other`. Hand each batch to one reader, such as one agent.
 *
 * A file's time is the median of its newest 5 passing runs. Its hints count lines that match each kind
 * of wait: a sleep, a long timeout, a poll, a retry, a fake clock, a literal period. They point a reader
 * at where to look, and prove nothing: read the code. A file the records time that is gone from the
 * checkout, split or deleted since, is listed apart.
 *
 * Configure: HINTS and TEST below, for your test framework's words (they cover Vitest and Effect's
 * test helpers); `--repo`, the checkout the paths are read from.
 *
 * Tests: `node --test ci-wait-hints.test.ts`. It reads records, takes medians and parses its
 * command line with ci-slow-files.ts's helpers.
 *
 * See docs/pages/10-slow-tests-the-method.md ("Name the wait before changing anything").
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, stdout } from 'node:process';

import { byFields, type CiRecord, jsonLines, median, parseCli } from './ci-slow-files.ts';

// ---- Config -------------------------------------------------------------------------------------

/** Each kind of wait, and what a line that hints at it matches. */
export const HINTS = {
  sleep: /\b(setTimeout|sleep|Effect\.sleep|delay|pause)\s*\(/gm,
  timeout: /\btimeout\s*:\s*[\d_]{4,}|,\s*[\d_]{5,}\s*\)\s*;?\s*$/gm,
  poll: /waitFor|until[A-Z]\w*\(|\bpoll|\binterval/gm,
  retry: /retr(y|ies)|attempt/gm,
  fakeclock: /useFakeTimers|advanceTimers|TestClock|clock\.(tick|step)/gm,
  period: /'\d+ (seconds?|millis)'|\b\d{4,}\s*\)|\b[1-9]\d?_000\b/gm,
} as const satisfies Record<string, RegExp>;

/** One test: Vitest's `it(` and `test(` and their modifiers, and Effect's `it.effect(` and kin. */
export const TEST = /^\s*(it|test)(\.\w+)*\s*\(|\bit\.(effect|live|scoped|prop)\w*\s*\(/gm;

// -------------------------------------------------------------------------------------------------

export type Kind = keyof typeof HINTS;
const KINDS = Object.keys(HINTS) as Kind[];

/** A file past the time: its median, path, passing runs, fastest, slowest, tests and hints. */
export type Row = readonly [median: number, path: string, runs: number, low: number, high: number, tests: number, hints: Readonly<Record<Kind, number>>];

const matches = (rx: RegExp, text: string) => text.match(rx)?.length ?? 0;

/** How many tests the file holds, and how many matches of each kind of wait. */
export const hintsIn = (text: string) => ({
  tests: matches(TEST, text),
  hints: Object.fromEntries(KINDS.map((kind) => [kind, matches(HINTS[kind], text)])) as Record<Kind, number>,
});

/** A batch: the file's folder, `depth` levels below the package's `src`, or its package. */
export const area = (path: string, depth: number) => {
  const parts = path.split('/');
  const at = parts.indexOf('src');

  if (at >= 0) return parts.slice(0, Math.min(at + 1 + depth, parts.length - 1)).join('/');
  return parts.slice(0, 2).join('/');
};

/** Each file's passing runs, as when its run was created and how many seconds it took. */
export const passingTimes = (records: Iterable<CiRecord>) => {
  const times = new Map<string, Array<readonly [created: string, seconds: number]>>();

  for (const record of records) {
    for (const job of record.jobs ?? []) {
      for (const run of job.tests ?? []) {
        for (const [path, status, millis] of run?.files ?? []) {
          if (status !== 'passed') continue;
          const timed = times.get(path) ?? [];
          timed.push([record.created, millis / 1000]);
          times.set(path, timed);
        }
      }
    }
  }

  return times;
};

/**
 * The files whose median passes `over` seconds, slowest first, with what `read` finds in each, and
 * apart, the ones gone from the checkout, as `[median, path]`.
 */
export const pastTheTime = (
  times: ReadonlyMap<string, Array<readonly [string, number]>>,
  over: number,
  repo: string,
  read: (path: string) => string | undefined = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
) => {
  const rows: Row[] = [];
  const gone: Array<readonly [number, string]> = [];

  for (const [path, timed] of times) {
    timed.sort(byFields);
    const mid = median(timed.slice(-5).map(([, seconds]) => seconds));
    if (mid <= over) continue;

    const text = read(join(repo, path));
    if (text === undefined) {
      gone.push([mid, path]);
      continue;
    }

    const { tests, hints } = hintsIn(text);
    const seconds = timed.map(([, took]) => took);
    const low = seconds.reduce((a, b) => Math.min(a, b));
    const high = seconds.reduce((a, b) => Math.max(a, b));
    rows.push([mid, path, timed.length, low, high, tests, hints]);
  }

  rows.sort((a, b) => byFields(b.slice(0, 6) as Array<number | string>, a.slice(0, 6) as Array<number | string>));
  return { rows, gone };
};

export const HEADER = ['median_s', 'file', 'runs', 'min', 'max', 'tests', 's_per_test', ...KINDS];

/** One row as a TSV line. */
export const line = ([mid, path, runs, low, high, tests, hints]: Row) => {
  const each = tests ? mid / tests : 0;
  const cells = [mid.toFixed(1), path, runs, low.toFixed(1), high.toFixed(1), tests, each.toFixed(1)];

  return [...cells, ...KINDS.map((kind) => hints[kind])].join('\t');
};

const total = (rows: ReadonlyArray<Row>) => rows.reduce((sum, row) => sum + row[0], 0);

/** The rows by area, an area of fewer than `minBatch` files in `other`, the most seconds first. */
export const batches = (rows: ReadonlyArray<Row>, depth: number, minBatch: number) => {
  const by = new Map<string, Row[]>();
  const into = (name: string, moved: ReadonlyArray<Row>) => by.set(name, [...(by.get(name) ?? []), ...moved]);

  for (const row of rows) into(area(row[1], depth), [row]);
  for (const [name, batch] of [...by].filter(([, batch]) => batch.length < minBatch)) {
    by.delete(name);
    into('other', batch);
  }

  return [...by].sort((a, b) => total(b[1]) - total(a[1]));
};

const HELP = `usage: node ci-wait-hints.ts <records> [options]

  <records>            a JSON-lines file of ci-records.ts's records
  --over <seconds>     list files whose median passes this (default 10)
  --repo <dir>         the checkout the paths are read from (default .)
  --depth <n>          folder levels below src a batch spans (default 1)
  --out <dir>          a folder to write one TSV a batch into
  --min-batch <n>      smaller areas join one batch, other (default 8)
  -h, --help           print this help
`;

const main = (args: ReadonlyArray<string>) => {
  const values = parseCli(args, HELP, 'records', [
    { name: 'over', kind: 'number', fallback: 10 },
    { name: 'repo', kind: 'string', fallback: '.' },
    { name: 'depth', kind: 'integer', fallback: 1 },
    { name: 'out', kind: 'string' },
    { name: 'min-batch', kind: 'integer', fallback: 8 },
  ]);
  const over = values.over as number;
  const out = values.out as string | undefined;
  const print = (text: string) => stdout.write(`${text}\n`);

  const times = passingTimes(jsonLines<CiRecord>(values.records as string));
  const { rows, gone } = pastTheTime(times, over, values.repo as string);

  print(HEADER.join('\t'));
  for (const row of rows) print(line(row));

  print(`\n${rows.length} files past ${over} s, ${total(rows).toFixed(0)} s of tests`);
  if (gone.length) print(`${gone.length} timed files no longer in the checkout: ${gone.map(([, path]) => path).join(', ')}`);

  if (out) {
    mkdirSync(out, { recursive: true });
    for (const [name, batch] of batches(rows, values.depth as number, values.minBatch as number)) {
      const file = join(out, `${name.replaceAll('/', '-')}.tsv`);
      writeFileSync(file, [HEADER.join('\t'), ...batch.map(line)].map((text) => `${text}\n`).join(''));
      print(`${file}: ${batch.length} files, ${total(batch).toFixed(0)} s`);
    }
  }
};

if (import.meta.main) main(argv.slice(2));
