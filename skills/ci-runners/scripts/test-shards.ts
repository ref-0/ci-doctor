#!/usr/bin/env node
/**
 * test-shards.ts: how many shards a run's test files take, and the files each runs, split by how
 * long each file took on the default branch, so the shards end together.
 *
 *     node scripts/shards/test-shards.ts <most> <files> [--keep <file>]... [<results.json>...]
 *     node scripts/shards/test-shards.ts --merge [--through <sha>] [<results.json>...]
 *     node scripts/shards/test-shards.ts --merge --fold <stored.json> [--through <sha>] [<results.json>...]
 *
 * Where it runs: CI's plan job, once, so every shard gets its files from the same split. `--merge`
 * runs after a sweep's shards on the default branch, a full refresh, and `--merge --fold` in the
 * default branch's fold of pull requests' times between sweeps.
 *
 * Inputs and output:
 *   - `<files>` lists the run's test files, one per line, as the plan picked them.
 *   - Each file runs with the rest of its group (`test-groups.ts`), one cached task, so the plan
 *     splits whole groups, formed from every test file in the checkout (`git ls-files`).
 *   - Each `<results.json>` is Vitest's own results shape (`.vitest-results` or the cache's
 *     `results.json`: `{ version, projects: { <name>: { files: { <path>: { duration, lastRun } } } } }`),
 *     or a merge of them, whose `duration` is each file's planned time. A file in several counts its
 *     newest.
 *   - It prints `{ shards, queue }`: `shards` maps each shard's number to its own files, slowest group
 *     first; `queue` is a list of batches the shards claim once their own files are done
 *     (`test-claims.ts`), as `planOf` says.
 *   - `--keep <file>` keeps that file's group out of the queue, for a file that needs what only its
 *     own shard's job sets up.
 *   - `--merge` prints the times the plan reads: for each file its newest `keptSamples` measured
 *     times, and its planned time, their median, so one slow runner doesn't move the split. A run
 *     that times only some files keeps the others' times. It's a sweep's full refresh.
 *   - `--merge --fold <stored.json>` is the fold between sweeps, of the times pull requests' runs
 *     measured: it adds the files `<stored.json>` doesn't hold, which would otherwise run on a
 *     guess, and leaves every stored file as it is, for the next sweep to refresh.
 *   - `--through <sha>` records the newest merge whose times the output holds; without it, the
 *     stored times' own `through` carries over.
 *
 * Why not Vitest's `--shard`: it cuts a list sorted by each path's hash into equal counts. One day
 * that left one shard with about a quarter more seconds of tests than another.
 *
 * Configure: the constants below, measured on your runners, and `SERVER_DIR` in `test-groups.ts`.
 * See docs/pages/07-shards-runners-and-billing.md for the reasoning.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { type Grouping, groupingFor, groupsOf, groupsWith, isServerFile, ORDINARY } from './test-groups.ts';

// ---- Config: measure these on your own runners --------------------------------------------------

/** The test files a shard's runner runs at once. Ours: 6 on 8 vCPU (9 ran slower, and flaked). */
export const shardWorkers = 6;

/**
 * The seconds of tests each shard's files should take, summed and shared among its workers, beside
 * the job's own start (checkout, install, build). An example value: pick it so a shard's tests,
 * which ran a fifth or so over their share, plus that start stay under two billed minutes. Modelled
 * on one day's times, a smaller target split a full run into more, shorter shards for about the
 * same billed vCPU-minutes and a much shorter wait than a larger one. No file may take longer than
 * this, or it sets its shard's end.
 */
export const shardSeconds = 75;

/**
 * The share of each shard's estimated work the plan aims to give it up front: a target, not a
 * limit, since each shard's first group and every untimed or kept group go up front whatever their
 * size (`planOf`). The rest waits in the run's queue,
 * which the shards claim from as they finish (`test-claims.ts`), so a shard on a slow machine takes
 * less of it. One runner ran a shard's files up to 1.6 times as long as the median shard's, so a
 * shard's own files take at most half its share: at 0.7, a slow shard's own files alone ran past
 * the others' whole share, in a model of one day's times.
 */
export const fixedShare = 0.5;

/**
 * The estimated seconds of work in each of the queue's batches: the sum of its files' times and
 * starts, which a shard's workers then share, so not a batch's time on the clock. A batch takes
 * whole groups until its sum reaches this, so one can pass it. An example value. A shard claims a whole batch at once, a claim being a small
 * fraction of a second, and runs it as one task-runner call, whose start costs a little more. So a
 * batch is a short slice of a shard's workers' time, and the shards still end within a batch of
 * each other.
 */
export const batchSeconds = 60;

/**
 * The ms a test file's own process takes to start, which Vitest's times leave out. An example
 * value: fit yours to your shards, as their workers' time beyond the files' own times, per file.
 * Without it, a short batch of files that take a few ms each held hundreds of them, and the shard
 * that took it ended well after the rest.
 */
export const fileStart = 440;

/**
 * The ms a group takes to start, as one task-runner call of one Vitest, beside its files' own, most
 * of it outside Vitest. An example value: measure yours on a shard of many groups.
 */
export const groupStart = 3000;

/** The guess for an untimed server file when no server file is timed. */
const serverFallback = 17_000;

/** The guess for an untimed other file when no other file is timed. */
const otherFallback = 1_000;

/**
 * How many of a file's newest measured times the stored times keep; the plan reads their median, so
 * one run on a slow machine doesn't move a file. An example value: in the source repo a shard's
 * machine ran its files up to 2.2 times their median, and more samples than three lagged the files
 * that were getting faster. A replayed file has no new time, so these are runs that ran it.
 */
export const keptSamples = 3;

// -------------------------------------------------------------------------------------------------

/** A file's time in ms, and when it ran, in ms since the epoch. */
interface Timed {
  readonly duration: number;
  readonly lastRun: number;
}

/**
 * Each file's newest time, by its path from the repo's root, from Vitest's results. A file whose
 * duration isn't a positive number is left untimed, and counts as its kind's guess (`timesOf`).
 */
export const newestIn = (results: ReadonlyArray<string>) => {
  const newest = new Map<string, Timed>();

  for (const text of results) {
    // Vitest's own results.json, version 1, or a merge of them. Each number is checked before it's kept.
    const { projects } = JSON.parse(text) as {
      readonly projects?: Record<
        string,
        {
          readonly files?: Record<
            string,
            { readonly duration?: number; readonly lastRun?: number }
          >;
        }
      >;
    };

    for (const { files = {} } of Object.values(projects ?? {})) {
      for (const [path, { duration = 0, lastRun = 0 }] of Object.entries(files)) {
        if (!Number.isFinite(duration) || duration <= 0) continue;

        const kept = newest.get(path);
        if (kept === undefined || lastRun >= kept.lastRun) newest.set(path, { duration, lastRun });
      }
    }
  }

  return newest;
};

/** Each file's newest time in ms. */
export const timesIn = (results: ReadonlyArray<string>) =>
  new Map([...newestIn(results)].map(([path, { duration }]) => [path, duration]));

/** A measured time: when it ran, in ms since the epoch, and its ms. */
type Sample = readonly [lastRun: number, duration: number];

/** A stored file: the time the plan reads, and the samples it came from, oldest first. */
interface Kept {
  readonly duration: number;
  readonly lastRun: number;
  readonly samples: ReadonlyArray<Sample>;
}

/** The median of some numbers; of an even count, the lower middle, as the planner rounds down. */
const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((one, other) => one - other);

  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
};

/** What a merge did, for the job's log. */
export interface Merge {
  readonly text: string;
  /** Files the stored times didn't hold. */
  readonly added: number;
  /** Stored files whose planned time changed. */
  readonly moved: number;
}

type Entry = {
  readonly duration?: number;
  readonly lastRun?: number;
  readonly samples?: ReadonlyArray<ReadonlyArray<number>>;
};

/**
 * The times the plan reads, in Vitest's results' shape with each file's `samples` beside it, which
 * `newestIn` reads back. Each input is Vitest's results, each file one sample, or a merge of them,
 * whose `samples` carry over. A sample already kept, as when the same results come twice, counts
 * once.
 *
 * - Each file keeps its newest `keptSamples` samples, and its planned time is their median.
 * - With `fold`, the stored times, only files they don't hold take the inputs' samples; every
 *   stored file stays as stored.
 * - `through` names the newest merge the times hold; without it, the stored times' carries over.
 */
export const merged = (
  results: ReadonlyArray<string>,
  { fold, through }: { readonly fold?: string; readonly through?: string } = {},
): Merge => {
  const stored = new Map<string, { samples: Array<Sample>; duration: number }>();
  const measured = new Map<string, Array<Sample>>();
  let kept: string | undefined;

  const valid = (pairs: ReadonlyArray<ReadonlyArray<number>>) =>
    pairs.flatMap(([at = 0, ms = 0]) => (Number.isFinite(ms) && ms > 0 && Number.isFinite(at) ? [[at, ms] as const] : []));
  const add = (list: Array<Sample>, more: ReadonlyArray<Sample>) => {
    for (const sample of more) if (!list.some(([at, ms]) => at === sample[0] && ms === sample[1])) list.push(sample);
  };

  const inputs = fold === undefined ? results.map((text) => ({ text, base: true })) : [{ text: fold, base: true }, ...results.map((text) => ({ text, base: false }))];

  for (const { text, base } of inputs) {
    const parsed = JSON.parse(text) as {
      readonly through?: unknown;
      readonly projects?: Record<string, { readonly files?: Record<string, Entry> }>;
    };
    if (base && kept === undefined && typeof parsed.through === 'string') kept = parsed.through;

    for (const { files = {} } of Object.values(parsed.projects ?? {})) {
      for (const [path, { duration = 0, lastRun = 0, samples }] of Object.entries(files)) {
        const pairs = valid(samples ?? [[lastRun, duration]]);
        if (base && samples !== undefined) {
          const entry = stored.get(path) ?? { samples: [], duration };
          add(entry.samples, pairs);
          stored.set(path, entry);
        } else {
          const list = measured.get(path) ?? [];
          add(list, pairs);
          measured.set(path, list);
        }
      }
    }
  }

  let added = 0;
  let moved = 0;
  const files = new Map<string, Kept>();
  const keep = (path: string, list: ReadonlyArray<Sample>) => {
    const newest = list.toSorted((one, other) => one[0] - other[0]).slice(-keptSamples);
    if (newest.length === 0) return undefined;

    const entry = { duration: median(newest.map(([, ms]) => ms)), lastRun: newest.at(-1)?.[0] ?? 0, samples: newest };
    files.set(path, entry);
    return entry;
  };

  for (const [path, entry] of stored) {
    if (fold !== undefined) {
      files.set(path, { duration: entry.duration, lastRun: entry.samples.at(-1)?.[0] ?? 0, samples: entry.samples });
      continue;
    }
    const all = [...entry.samples];
    add(all, measured.get(path) ?? []);
    const now = keep(path, all);
    if (now !== undefined && now.duration !== entry.duration) moved += 1;
  }
  for (const [path, list] of measured) {
    if (stored.has(path)) continue;
    if (keep(path, list) !== undefined) added += 1;
  }

  const record = through ?? kept;

  return {
    text: JSON.stringify({
      version: 1,
      ...(record === undefined ? {} : { through: record }),
      projects: { workspace: { files: Object.fromEntries(files) } },
    }),
    added,
    moved,
  };
};

/** The value `share` of the way up `values`, sorted: 0.5 is the median. */
const percentile = (values: ReadonlyArray<number>, share: number) => {
  const sorted = values.toSorted((one, other) => one - other);

  return sorted.length === 0 ? undefined : sorted[Math.floor(sorted.length * share)];
};

/**
 * Each file's time in ms: its newest, or for a file no record times, a guess for its kind. A server
 * file's guess is the 90th percentile of the timed server files, not their median: three files split
 * from one big file each took several times the median, and the plan, guessing the median, left
 * them for the queue's last batches, which ended their shard long after the median shard. Guessing high only
 * starts a fast file early.
 */
const timesOf = (files: ReadonlyArray<string>, times: ReadonlyMap<string, number>) => {
  const known = (server: boolean) =>
    files.flatMap((path) => {
      const time = times.get(path);

      return isServerFile(path) === server && time !== undefined ? [time] : [];
    });
  const guess = {
    server: percentile(known(true), 0.9) ?? serverFallback,
    other: percentile(known(false), 0.5) ?? otherFallback,
  };

  return (path: string) => times.get(path) ?? (isServerFile(path) ? guess.server : guess.other);
};

/** How many shards `files` take: enough for about `shardSeconds` each, from one to `most`. */
export const shardCount = (
  files: ReadonlyArray<string>,
  most: number,
  times: ReadonlyMap<string, number>,
) => {
  const unique = [...new Set(files)];
  const timeOf = timesOf(unique, times);
  const total = unique.reduce((sum, path) => sum + timeOf(path), 0);

  return Math.min(most, Math.max(1, Math.ceil(total / 1000 / (shardWorkers * shardSeconds))));
};

/** What each shard runs: its own files, and the queue's batches, which the shards claim. */
export interface Plan {
  readonly shards: ReadonlyArray<ReadonlyArray<string>>;
  readonly queue: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * `groups` split into `count` shards and a queue.
 *
 * - A group's time is its files' times, plus `fileStart` for each, plus `groupStart`: estimated
 *   work, summed across workers.
 * - Slowest first, each group goes to the shard with the least time so far, while that shard holds
 *   less than `fixedShare` of its share, or no group yet, so a first group can pass the target.
 *   Otherwise it goes to the queue.
 * - A group with a file in `keep` goes to a shard all the same. So does a group with a file no
 *   record times: its time is a guess, and the queue's batches, claimed last, are only for times
 *   the plan knows. Untimed groups each go to the next least-loaded shard, not into one batch.
 * - Each shard's groups stay slowest first. The queue's groups are cut into batches of about
 *   `batchSeconds`, slowest first. A run of one shard has no queue.
 */
export const planOf = (
  groups: ReadonlyArray<ReadonlyArray<string>>,
  count: number,
  times: ReadonlyMap<string, number>,
  keep: ReadonlySet<string> = new Set(),
): Plan => {
  const sweepTimeOf = timesOf(
    groups.flatMap((group) => group),
    times,
  );
  const timeOf = (group: ReadonlyArray<string>) =>
    group.reduce((sum, path) => sum + sweepTimeOf(path) + fileStart, groupStart);
  const fixed =
    count === 1
      ? Infinity
      : (fixedShare * groups.reduce((sum, group) => sum + timeOf(group), 0)) / count;

  const shards = Array.from({ length: count }, () => ({ time: 0, files: new Array<string>() }));
  const queued = new Array<ReadonlyArray<string>>();
  const slowestFirst = groups.toSorted(
    (one, other) => timeOf(other) - timeOf(one) || ((one[0] ?? '') < (other[0] ?? '') ? -1 : 1),
  );

  for (const group of slowestFirst) {
    const least = shards.reduce((best, shard) => (shard.time < best.time ? shard : best));
    const fits =
      least.time + timeOf(group) <= fixed ||
      least.files.length === 0 ||
      group.some((path) => keep.has(path) || !times.has(path));

    if (!fits) {
      queued.push(group);
      continue;
    }

    least.time += timeOf(group);
    least.files.push(...group);
  }

  const queue = new Array<Array<string>>();
  let time = Infinity;

  for (const group of queued) {
    if (time >= batchSeconds * 1000) {
      queue.push([]);
      time = 0;
    }

    queue.at(-1)?.push(...group);
    time += timeOf(group);
  }

  return { shards: shards.map((shard) => shard.files), queue };
};

/**
 * The groups `files` run in, by `grouping`: each whole group of every ordinary file in `everyFile`
 * that holds one of them, and any other of `files` alone.
 */
export const groupsFor = (
  files: ReadonlyArray<string>,
  everyFile: ReadonlyArray<string>,
  grouping: Grouping = groupingFor(process.env),
) => {
  const groups = groupsWith(groupsOf(everyFile.filter(ORDINARY), grouping), files).map(
    (group) => group.files,
  );
  const grouped = new Set(groups.flat());

  return [...groups, ...[...new Set(files)].flatMap((path) => (grouped.has(path) ? [] : [[path]]))];
};

const readAll = (paths: ReadonlyArray<string>) =>
  paths.flatMap((path) => (existsSync(path) ? [readFileSync(path, 'utf8')] : []));

// Run as a script, not when imported by its test.
const isMain = argv[1] === fileURLToPath(import.meta.url);

if (isMain && argv[2] === '--merge') {
  const { values, positionals } = parseArgs({
    args: argv.slice(3),
    options: { fold: { type: 'string' }, through: { type: 'string' } },
    allowPositionals: true,
  });
  const [stored] = values.fold === undefined ? [] : readAll([values.fold]);
  if (values.fold !== undefined && stored === undefined) {
    console.error(`--fold ${values.fold}: no such file`);
    exit(2);
  }
  const { text, added, moved } = merged(readAll(positionals), { fold: stored, through: values.through });

  console.log(text);
  console.error(
    values.fold !== undefined
      ? `${added} new files timed; stored files left for the next sweep`
      : `${added} new files timed, ${moved} files' planned time moved to the median of their newest ${keptSamples}`,
  );
} else if (isMain) {
  const { values, positionals } = parseArgs({
    args: argv.slice(2),
    options: { keep: { type: 'string', multiple: true } },
    allowPositionals: true,
  });
  const [most, list, ...results] = positionals;

  if (most === undefined || list === undefined || !/^[1-9][0-9]*$/.test(most)) {
    console.error(
      'Usage: node test-shards.ts <most> <files> [--keep <file>]... [<results.json>...] | --merge [--fold <stored.json>] [--through <sha>] [<results.json>...]',
    );
    exit(2);
  }

  const listed = readFileSync(list, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
  const everyFile = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((path) => path !== '');
  const groups = groupsFor(listed, everyFile);
  const times = timesIn(readAll(results));

  const { shards, queue } = planOf(
    groups,
    shardCount(groups.flat(), Number(most), times),
    times,
    new Set(values.keep),
  );

  console.log(
    JSON.stringify({
      shards: Object.fromEntries(shards.map((shard, at) => [String(at + 1), shard])),
      queue,
    }),
  );
}
