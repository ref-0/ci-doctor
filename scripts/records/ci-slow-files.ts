#!/usr/bin/env node
/**
 * ci-slow-files.ts: ranks CI's test files by time, spread and failures, from ci-records.ts's records.
 *
 * Where it runs: anywhere, by hand, on a file of records. Node 24 or later, no npm dependencies.
 *
 *     node scripts/records/ci-records.ts --since 2026-11-01 --out records.jsonl
 *     gzip -dc <records-dir>/*.jsonl.gz > records.jsonl       or the nightly archive's weeks
 *     node ci-slow-files.ts records.jsonl                       every run's records
 *     node ci-slow-files.ts records.jsonl --event pull_request --top 30
 *
 * It prints, for the files the records time:
 *   - the slowest, by the median of each one's newest 5 passing runs, with how many there were and
 *     their range, flagging a file with fewer than 3 as thin;
 *   - the widest spread, a file whose slowest passing run took at least twice its fastest, past 20 s,
 *     in 3 or more runs: a wait on the clock, the machine or another test, or a race, more often than
 *     work;
 *   - each test that failed or passed only on a retry, with the runs, events and branches it did so;
 *   - the large runs' fresh recorded test-seconds, to compare runs over time.
 *
 * Timing medians take only a file's passing, complete runs: a failed or stopped run's time isn't the
 * file's. Those runs still count in the failure lists. Observations are ordered by run, then attempt,
 * not by when the run was created, and each carries its commit, so you can keep a before/after sample
 * to commits that do or don't contain a fix (`--sha-file`). A thin or mixed-code sample is no
 * demonstrated gain.
 *
 * What a run's numbers are, and aren't. A record replayed from a task cache isn't in these lines, so
 * every time here is a fresh run, and a run's total is its fresh recorded test-seconds, never the
 * whole suite's: a sweep that replays most tasks records few. A run counts as large when its plan
 * record says it selected everything (`packages` null), or else, as a heuristic only, when it had
 * `--full-run-jobs` test jobs or more: a shard count doesn't show the whole inventory ran. Neither
 * proves a whole-suite before/after saving; compare the plan's selected inventory with the eligible
 * inventory at each commit for that. A failure on one branch alone is that branch's, not a flake:
 * read the branch column first.
 *
 * Configure: `--test-job-prefix`, the start of your sharded test jobs' names ("Tests " by default),
 * and `--full-run-jobs`, the shard count the heuristic calls large.
 *
 * Tests: `node --test ci-slow-files.test.ts`. Its helpers for reading records, the median and the
 * command line are shared with ci-wait-hints.ts.
 *
 * See docs/pages/10-slow-tests-the-method.md for how to use the ranking.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import { parseArgs } from 'node:util';

// ---- Records ------------------------------------------------------------------------------------

/** One file a Vitest run ran: its path, its state and its module duration in ms. */
export type FileRun = readonly [path: string, status: string, millis: number];

/** One Vitest run's record, as test-record.ts prints it. Only the fields read here. */
export interface TestsRun {
  readonly files?: ReadonlyArray<FileRun>;
  readonly failed?: ReadonlyArray<ReadonlyArray<string>>;
  readonly flaky?: ReadonlyArray<ReadonlyArray<string | number>>;
}

/** One attempt of one run, as ci-records.ts writes it. Only the fields read here. */
export interface CiRecord {
  readonly run: number;
  readonly attempt?: number;
  readonly event: string;
  readonly branch: string;
  readonly sha?: string;
  readonly created: string;
  readonly plan?: { readonly packages?: unknown } | null;
  readonly jobs: ReadonlyArray<{
    readonly name: string;
    readonly tests?: ReadonlyArray<TestsRun | null> | null;
  }>;
}

/** Each line of a file, read a chunk at a time, so a large archive isn't held in memory at once. */
export function* fileLines(path: string): Generator<string> {
  const fd = openSync(path, 'r');
  const chunk = Buffer.alloc(1 << 20);
  const decoder = new StringDecoder('utf8');
  let partial = '';

  try {
    for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) {
      const lines = (partial + decoder.write(chunk.subarray(0, read))).split('\n');
      partial = lines.pop() ?? '';
      yield* lines;
    }
    partial += decoder.end();
    if (partial) yield partial;
  } finally {
    closeSync(fd);
  }
}

/** Each line of a JSON-lines file, parsed. A blank or broken line throws, naming its line. */
export function* jsonLines<T>(path: string): Generator<T> {
  let number = 0;

  for (const line of fileLines(path)) {
    number += 1;
    try {
      yield JSON.parse(line) as T;
    } catch (error) {
      throw new Error(`${path}:${number}: ${(error as Error).message}`);
    }
  }
}

// ---- Helpers shared with ci-wait-hints.ts --------------------------------------------------------

/** The median: the middle value, or the mean of the middle two. */
export const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;

  if (sorted.length === 0) throw new Error('no median of no values');
  if (sorted.length % 2) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** Orders two rows field by field, then the shorter first, so ties break the same way every run. */
export const byFields = (a: ReadonlyArray<number | string>, b: ReadonlyArray<number | string>) => {
  for (let at = 0; at < Math.min(a.length, b.length); at += 1) {
    if (a[at]! < b[at]!) return -1;
    if (a[at]! > b[at]!) return 1;
  }

  return a.length - b.length;
};

// ---- Command line -------------------------------------------------------------------------------

/** One flag: its name, its value's kind and its value when it isn't given. */
export interface Flag {
  readonly name: string;
  readonly kind: 'string' | 'integer' | 'number';
  readonly fallback?: string | number;
}

/**
 * Reads one positional and `flags`, keyed in camel case. `-h` or `--help` prints `help` and exits 0;
 * a missing positional, an unknown flag or a bad number prints the error and the usage, and exits 2.
 */
export const parseCli = (args: ReadonlyArray<string>, help: string, positional: string, flags: ReadonlyArray<Flag>) => {
  const fail = (message: string): never => {
    stderr.write(`error: ${message}\n${help.split('\n')[0]}\n`);
    exit(2);
  };
  if (args.includes('-h') || args.includes('--help')) {
    stdout.write(help);
    exit(0);
  }

  const options = Object.fromEntries(flags.map((flag) => [flag.name, { type: 'string' } as const]));
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (error) {
    return fail((error as Error).message);
  }
  const [first, ...extra] = parsed.positionals;
  if (first === undefined) fail(`<${positional}> is required`);
  if (extra.length) fail(`unexpected arguments: ${extra.join(' ')}`);

  const values: Record<string, string | number | undefined> = { [positional]: first };
  for (const flag of flags) {
    const given = parsed.values[flag.name] as string | undefined;
    const key = flag.name.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
    if (given === undefined || flag.kind === 'string') {
      values[key] = given ?? flag.fallback;
      continue;
    }

    const number = flag.kind === 'integer' ? (/^[-+]?\d+$/.test(given) ? Number(given) : NaN) : given.trim() ? Number(given) : NaN;
    if (!Number.isFinite(number)) fail(`--${flag.name} takes ${flag.kind === 'integer' ? 'an integer' : 'a number'}, not '${given}'`);
    values[key] = number;
  }

  return values;
};

// ---- The ranking --------------------------------------------------------------------------------

export interface Options {
  readonly event?: string;
  readonly top: number;
  readonly testJobPrefix: string;
  readonly fullRunJobs: number;
  /** Keep only runs of these commits, when set. */
  readonly shas?: ReadonlySet<string>;
}

/** Why a run counts as large: its plan selected everything, or, as a heuristic, its shard count. */
export const large = (record: CiRecord, testJobs: number, fullRunJobs: number) => {
  const plan = record.plan ?? {};

  if ('packages' in plan && plan.packages === null) return 'plan: everything';
  if (testJobs >= fullRunJobs) return 'heuristic: shards';
  return null;
};

type Where = readonly [run: number, event: string, branch: string, when: string];
type Total = readonly [string, number, number, string, number, number, number, string];

/** The report's lines, from the records. */
export const report = (records: Iterable<CiRecord>, options: Options): string[] => {
  const out: string[] = [];
  const times = new Map<string, Array<readonly [order: readonly [number, number], sha: string, seconds: number]>>();
  const failed = new Map<string, Where[]>();
  const flaky = new Map<string, Where[]>();
  const add = <T>(map: Map<string, T[]>, key: string, value: T) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  const totals: Total[] = [];
  let runs = 0;
  let leftOut = 0;

  for (const record of records) {
    if (options.event !== undefined && record.event !== options.event) continue;
    if (options.shas !== undefined && !options.shas.has(record.sha as string)) continue;
    runs += 1;
    const where: Where = [record.run, record.event, record.branch.slice(0, 40), record.created.slice(5, 16)];
    const order = [record.run, record.attempt ?? 1] as const;
    let testJobs = 0;
    let seconds = 0;
    let files = 0;

    for (const job of record.jobs) {
      testJobs += job.name.startsWith(options.testJobPrefix) ? 1 : 0;
      for (const vitest of job.tests ?? []) {
        for (const [path, status, ms] of vitest!.files ?? []) {
          seconds += ms / 1000;
          files += 1;
          // Only a passing, complete run times the file; the rest stay in the failures.
          if (status === 'passed') add(times, path, [order, (record.sha ?? '').slice(0, 8), ms / 1000] as const);
          else leftOut += 1;
        }
        for (const test of vitest!.failed ?? []) add(failed, test.slice(0, 2).join(' > '), where);
        // A flaky entry is its file, its name and how many times it ran again.
        for (const test of vitest!.flaky ?? []) add(flaky, test.slice(0, 2).join(' > '), where);
      }
    }

    const why = large(record, testJobs, options.fullRunJobs);
    if (why) {
      totals.push([record.created.slice(5, 16), record.run, record.attempt ?? 1, record.event, testJobs, files, seconds, why]);
    }
  }

  out.push(`${runs} run attempts, ${times.size} files timed, ${leftOut} file runs that didn't pass left out of the times`);

  const rows: Array<readonly [number, number, number, number, number, string, string]> = [];
  for (const [path, runsOf] of times) {
    runsOf.sort((a, b) => byFields([...a[0], a[1], a[2]], [...b[0], b[1], b[2]]));
    const newest = runsOf.slice(-5).map(([, , took]) => took);
    const every = runsOf.map(([, , took]) => took);
    rows.push([median(newest), newest.length, every.length, every.reduce((a, b) => Math.min(a, b)), every.reduce((a, b) => Math.max(a, b)), runsOf.at(-1)![1], path]);
  }
  rows.sort((a, b) => byFields(b, a));

  out.push('', 'Slowest files, median of the newest 5 passing runs, in seconds: sampled, runs, fastest, slowest, newest commit');
  for (const [mid, sampled, count, low, high, sha, path] of rows.slice(0, options.top)) {
    const thin = sampled < 3 ? '  thin' : '';
    out.push(`  ${mid.toFixed(1).padStart(6)} ${String(sampled).padStart(2)} ${String(count).padStart(4)} ${low.toFixed(1).padStart(6)} ${high.toFixed(1).padStart(6)}  ${sha}  ${path}${thin}`);
  }

  out.push('', 'Widest spread: slowest passing run at least twice the fastest, past 20 s, in 3 or more runs');
  for (const [, , count, low, high, , path] of [...rows].sort((a, b) => a[3] - a[4] - (b[3] - b[4]))) {
    if (count >= 3 && high >= 20 && high >= 2 * Math.max(low, 0.1)) {
      out.push(`  ${low.toFixed(1).padStart(6)} .. ${high.toFixed(1).padStart(6)}  runs ${String(count).padStart(3)}  ${path}`);
    }
  }

  for (const [title, found] of [['Failed', failed], ['Passed only on a retry', flaky]] as const) {
    out.push('', `${title}: times, then the first runs as [run, event, branch, when]`);
    for (const [test, where] of [...found].sort((a, b) => b[1].length - a[1].length)) {
      out.push(`  ${where.length}x ${test}\n      ${JSON.stringify(where.slice(0, 4))}`);
    }
  }

  out.push('', "Large runs' fresh recorded test-seconds (replays aren't recorded; not the whole suite's time)");
  for (const [when, run, attempt, event, jobs, files, seconds, why] of totals.sort(byFields)) {
    out.push(`  ${when} ${run}/${attempt} ${event.padEnd(17)} ${String(jobs).padStart(2)} jobs ${String(files).padStart(5)} files fresh ${seconds.toFixed(0).padStart(8)} s  (${why})`);
  }

  return out;
};

const HELP = `usage: node ci-slow-files.ts <records> [options]

  <records>                  a JSON-lines file of ci-records.ts's records
  --event <event>            keep only runs of this event: pull_request, push or workflow_dispatch
  --top <n>                  how many of the slowest files to list (default 40)
  --test-job-prefix <text>   your sharded test jobs' names start with this (default "Tests ")
  --full-run-jobs <n>        the heuristic: a run with this many test jobs is large (default 10)
  --sha-file <file>          keep only runs of the commits listed in this file, one a line
                             (e.g. \`git rev-list A..B\`)
  -h, --help                 print this help
`;

const main = (args: ReadonlyArray<string>) => {
  const values = parseCli(args, HELP, 'records', [
    { name: 'event', kind: 'string' },
    { name: 'top', kind: 'integer', fallback: 40 },
    { name: 'test-job-prefix', kind: 'string', fallback: 'Tests ' },
    { name: 'full-run-jobs', kind: 'integer', fallback: 10 },
    { name: 'sha-file', kind: 'string' },
  ]);

  const shaFile = values.shaFile as string | undefined;
  const shas = shaFile === undefined ? undefined : new Set(readFileSync(shaFile, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean));
  const lines = report(jsonLines<CiRecord>(values.records as string), {
    event: values.event as string | undefined,
    top: values.top as number,
    testJobPrefix: values.testJobPrefix as string,
    fullRunJobs: values.fullRunJobs as number,
    shas,
  });

  stdout.write(lines.map((line) => `${line}\n`).join(''));
};

if (import.meta.main) main(argv.slice(2));
