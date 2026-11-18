#!/usr/bin/env node
/**
 * container-pack.ts: packs slow test files that each need their own container (a sandbox, a real
 * service) into CI jobs of about `JOB_SECONDS` each (an example target), longest first, each onto
 * the job with the least so far. And the plan job's two other sizing rules: how big a runner the
 * ordinary tests get, and how many shards a run by hand with named paths gets.
 *
 *     node scripts/shards/container-pack.ts [--estimates <file.json>] < files.txt > jobs.json
 *
 * Where it runs: the CI plan job; its output is a job matrix. Node's built-in modules only.
 *
 * Input: one test file per line. Estimates: a JSON object of a file's name, its basename without
 * `SUFFIX`, to seconds. Output: `[{ "file": "<space-separated files>", "name": "<names>" }, ...]`.
 *
 * Why these numbers: estimates were each file's printed test times plus an equal share of its job's
 * unexplained Vitest duration, from one full run on 2 vCPU. Only estimates off by more than 20%
 * are worth changing, since a job's minutes bill whole. A file with no estimate counts as
 * `DEFAULT_SECONDS`. Checkout and setup add a fixed cost per job, so jobs much shorter than the
 * target pay mostly setup.
 *
 * Record each file's whole elapsed time for packing, collection, imports, setup and hooks
 * included. A sum of the printed per-test durations leaves those out, so it is only a lower bound:
 * a sum above an estimate proves the estimate low, but a sum below one proves nothing. Never
 * replace an estimate with a case sum, and a skipped file has no time at all.
 *
 * Configure: `JOB_SECONDS`, `DEFAULT_SECONDS`, `SUFFIX`, and your estimates file.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { readFileSync } from 'node:fs';
import { argv, stdin } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// ---- Config -------------------------------------------------------------------------------------

/** About how long each job's tests should take, in seconds. */
export const JOB_SECONDS = 150;

/** What a file with no estimate counts as, in seconds. */
export const DEFAULT_SECONDS = 60;

/** What a container test file's name ends with; its name is its basename without it. */
export const SUFFIX = '.sandbox.test.ts';

// -------------------------------------------------------------------------------------------------

export interface PackedJob {
  readonly file: string;
  readonly name: string;
  readonly seconds: number;
}

/** A file's name, as the estimates key it. */
export const nameOf = (file: string) => (file.split('/').pop() ?? file).replace(SUFFIX, '');

/**
 * `files` in `ceil(total / JOB_SECONDS)` jobs, longest first (ties by path), each onto the job with
 * the least so far.
 */
export const pack = (
  files: ReadonlyArray<string>,
  estimates: Readonly<Record<string, number>> = {},
): Array<PackedJob> => {
  const sized = files
    .map((file) => ({ file, name: nameOf(file), seconds: estimates[nameOf(file)] ?? DEFAULT_SECONDS }))
    .toSorted((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file));
  const total = sized.reduce((sum, { seconds }) => sum + seconds, 0);
  const jobs = Array.from({ length: Math.ceil(total / JOB_SECONDS) }, () => ({
    files: new Array<string>(),
    names: new Array<string>(),
    seconds: 0,
  }));

  for (const file of sized) {
    const job = jobs.reduce((least, next) => (next.seconds < least.seconds ? next : least));
    job.files.push(file.file);
    job.names.push(file.name);
    job.seconds += file.seconds;
  }

  return jobs.map(({ files, names, seconds }) => ({ file: files.join(' '), name: names.join(', '), seconds }));
};

/**
 * The runner for the ordinary tests: a run of at most six heavy-harness files, each other file a
 * tenth of one, goes on 2 vCPU running two at once; the rest on 8 vCPU running six. Most one-shard
 * runs (28 of 40 over two days) were that small, their jobs well inside one minute: Blacksmith
 * bills each job at least a whole minute of every vCPU, so 8 vCPU cost four times as much for the
 * same run. Six at once on 8 vCPU, not nine: nine ran the CPU near its limit, took over half as long
 * again, and a timing test failed.
 */
export const runnerFor = (files: number, serverFiles: number) =>
  serverFiles + (files - serverFiles) / 10 <= 6
    ? { runner: 'blacksmith-2vcpu-ubuntu-2404', workers: 2 }
    : { runner: 'blacksmith-8vcpu-ubuntu-2404', workers: 6 };

/**
 * Shards for a run by hand with named paths, which keeps Vitest's `--shard` because Vitest matches
 * its paths as parts of a file's path, so the plan can't know the files: one per 60 heavy-harness
 * files, each other file a tenth of one, from one to five.
 */
export const manualShards = (files: number, serverFiles: number) =>
  Math.max(1, Math.min(5, Math.ceil((serverFiles + (files - serverFiles) / 10) / 60)));

const main = () => {
  const { values } = parseArgs({ options: { estimates: { type: 'string' } } });
  const estimates: Record<string, number> =
    values.estimates === undefined ? {} : JSON.parse(readFileSync(values.estimates, 'utf8'));
  const files = readFileSync(stdin.fd, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  process.stdout.write(`${JSON.stringify(pack([...new Set(files)], estimates).map(({ file, name }) => ({ file, name })))}\n`);
};

if (argv[1] === fileURLToPath(import.meta.url)) main();
