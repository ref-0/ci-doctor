#!/usr/bin/env node
/**
 * test-lanes.ts: runs test files as cached tasks (`test-tasks.ts`) in independent lanes, then claims
 * the shared queue's batches one at a time (`test-claims.ts`) and runs each it owns. A CI test shard
 * runs it with its own files from the plan (`test-shards.ts`); run by hand, it runs what you name.
 *
 *     node scripts/shards/test-lanes.ts [--lanes <n>] [--times <file>] [--no-cache]
 *                                       [--verify-hits <n>] <file or folder>...
 *
 * - `--no-cache` runs every task, reading and writing no cache, local or remote (`vp run
 *   --no-cache` and `VP_REMOTE_CACHE=off`). A sweep run with `full` passes it.
 * - `--verify-hits <n>` runs `n` of the replayed tasks again with no cache once the run has passed,
 *   a sample that changes each day, so over days each cached task is checked. The run fails when one
 *   fails again, or doesn't finish. Main's sweep passes it, so a replay that no longer passes shows
 *   within days. A replay run again here is a check of the cache, never a fresh flake observation.
 * - `--times` writes the files' times of the tasks that ran, for `test-shards.ts --merge`.
 *
 * Where it runs: each CI test shard, and locally. Node's built-in modules, plus `vp` on the PATH or
 * in `node_modules/.bin`.
 *
 * Why lanes: a lane is a `vp run` of one task at a time, and takes the next once its last ends. One
 * `vp run` of many tasks waits for its slowest before the next round, and takes no new task once it
 * starts: a shard's task slots were busy well under half its time in rounds. The lanes share one cache
 * folder, so they share one summary file, which the last to end writes over; a lane reads its task's
 * outcome from what its `vp run` prints instead. Not a cache folder each: Vite reported every
 * `VITE_*` variable to Vite Task as one a test reads, so `VITE_CACHE_PATH` keyed every task, and a
 * whole run replayed nothing.
 *
 * The queue, set from CI's environment (all or none):
 *   TEST_CLAIMS        the claims' key prefix, `<name>-<run id>-<run attempt>`
 *   TEST_QUEUE         the batches' files, as JSON (`test-shards.ts`'s `queue`)
 *   TEST_CLAIMS_FILE   where it writes each batch it owns
 *   TEST_CLAIMED       a rerun's: the batches claimed in the plan's attempt, as JSON, never claimed again
 *   CI_CACHE_URL, CI_CACHE_TOKEN   the Actions cache's address and token (`templates/github/actions/ci-cache/`)
 *
 * With `CI_RECORD=1`, each Vitest appends its record to a file, not its log, since a replay would
 * print it again; this prints the records of the tasks that ran when it ends, and `--times` writes
 * their files' times in Vitest's results' shape, which `test-shards.ts --merge` reads.
 *
 * Left out of this skeleton, which the production runner has: picking tests near a local change
 * (`../local/near-tests.ts` does that), a shared database for the run, a lock between runs on one
 * cache, and rounds that rerun what a failed task stopped (each lane here runs one task at a time,
 * so a failure stops nothing else).
 *
 * Configure: `VP` below, and `test-groups.ts`.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';

import { cacheClaims, claimLine } from './test-claims.ts';
import { alsoMatched, groupsOf, groupsWith, LEFT_OUT, ORDINARY, type TestGroup } from './test-groups.ts';
import { groupTask, taskName } from './test-tasks.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** Vite+'s CLI. */
const VP = existsSync(join(root, 'node_modules/.bin/vp')) ? join(root, 'node_modules/.bin/vp') : 'vp';

/**
 * What happened to a group: replayed from a tier, run and passed, failed, stopped by a signal, or
 * not run. Vite Task stops the tasks still running when one fails, with SIGKILL, so they end with
 * 137, where a Vitest whose test failed ends with 1.
 */
export type Outcome = 'local' | 'remote' | 'passed' | 'failed' | 'stopped' | 'not run';

/**
 * A task's outcome from what its `vp run` printed, for a run of that task alone, which exits with
 * the task's status: Vite Task prints each task's command and how it ran on one line. None when no
 * line is the task's, as when Vite Task failed before it ran a task.
 */
export const printedOutcome = (
  output: string,
  command: string,
  status: number,
): Outcome | undefined => {
  const line = output
    .split('\n')
    .map((text) => stripVTControlCharacters(text))
    .find((text) => text.endsWith(`$ ${command}`) || text.includes(`$ ${command} `));
  if (line === undefined) return undefined;

  if (line.includes('remote cache hit, replaying')) return 'remote';

  if (line.includes('cache hit, replaying')) return 'local';

  if (status === 0) return 'passed';

  return status >= 128 ? 'stopped' : 'failed';
};

/**
 * Each file's time from Vitest's records, in Vitest's results' shape, as `test-shards.ts` reads
 * them: Vitest's module duration, collection not included, of the files that ran and passed. A
 * failed or skipped file's time says nothing of a normal run. The ones replayed kept their times on
 * the runs that ran them.
 */
export const timesOf = (
  records: ReadonlyArray<{ readonly files: ReadonlyArray<readonly [string, string, number]> }>,
  lastRun: number,
) =>
  JSON.stringify({
    version: 1,
    projects: {
      workspace: {
        files: Object.fromEntries(
          records.flatMap((record) =>
            record.files.flatMap(([file, state, duration]) =>
              state === 'passed' ? [[file, { duration, lastRun }] as const] : [],
            ),
          ),
        ),
      },
    },
  });

/** The records in a file of record lines, as `../records/test-record.ts` writes them. */
const recordsIn = (text: string) =>
  text.split('\n').flatMap((line) => {
    if (!line.startsWith('ci-record ')) return [];

    try {
      const record = JSON.parse(line.slice('ci-record '.length)) as { kind?: unknown; files?: unknown };

      return record.kind === 'tests' && Array.isArray(record.files)
        ? [record as { files: Array<[string, string, number]> }]
        : [];
    } catch {
      return [];
    }
  });

const jsonOf = <T>(raw: string, check: (value: unknown) => boolean, name: string): T => {
  const value: unknown = JSON.parse(raw);
  if (!check(value)) throw new Error(`${name} isn't what it should be`);

  return value as T;
};

/** The queue's claims, from the environment, or none when `TEST_CLAIMS` isn't set. */
export const queueOf = (from: NodeJS.ProcessEnv) => {
  const prefix = from['TEST_CLAIMS'] ?? '';
  if (prefix === '') return undefined;

  const queue = from['TEST_QUEUE'] ?? '';
  const file = from['TEST_CLAIMS_FILE'] ?? '';
  const url = from['CI_CACHE_URL'] ?? '';
  const token = from['CI_CACHE_TOKEN'] ?? '';
  if ([queue, file, url, token].includes('')) {
    throw new Error('TEST_CLAIMS needs TEST_QUEUE, TEST_CLAIMS_FILE, CI_CACHE_URL and CI_CACHE_TOKEN');
  }

  return {
    batches: jsonOf<Array<Array<string>>>(
      queue,
      (value) =>
        Array.isArray(value) &&
        value.every((batch) => Array.isArray(batch) && batch.every((f) => typeof f === 'string')),
      'TEST_QUEUE',
    ),
    claimed: new Set(
      jsonOf<Array<number>>(
        from['TEST_CLAIMED'] || '[]',
        (value) => Array.isArray(value) && value.every(Number.isSafeInteger),
        'TEST_CLAIMED',
      ),
    ),
    claim: cacheClaims({ url, token, prefix }),
    file,
  };
};

/**
 * `vp run`'s arguments and environment for one task. With no cache, it neither reads nor writes
 * either tier: `--no-cache` for the local one, `VP_REMOTE_CACHE=off` for the remote one, since a
 * fresh pass written back would be as good as any other, but a run asked to use no cache must not
 * leave one.
 */
export const vpRunOf = (task: string, noCache: boolean) => ({
  args: ['run', '--concurrency-limit', '1', ...(noCache ? ['--no-cache'] : []), task],
  env: noCache ? ({ VP_REMOTE_CACHE: 'off' } as NodeJS.ProcessEnv) : ({} as NodeJS.ProcessEnv),
});

/**
 * The replayed tasks to run again with no cache: `count` of them, ranked by a hash of the day and
 * the task, so the sample changes each day and over days covers each task. None when the run
 * failed or didn't finish: a run that fails already says enough, and its replays aren't the doubt.
 */
export const verifySample = <T extends { readonly task: string; readonly outcome: Outcome }>(
  results: ReadonlyArray<T>,
  count: number,
  day: string,
) => {
  const clean = results.every(({ outcome }) => outcome === 'local' || outcome === 'remote' || outcome === 'passed');
  if (!clean) return [];

  const rank = (task: string) => createHash('sha256').update(`${day}:${task}`).digest('hex');

  return results
    .filter(({ outcome }) => outcome === 'local' || outcome === 'remote')
    .toSorted((one, other) => rank(one.task).localeCompare(rank(other.task)))
    .slice(0, count);
};

/**
 * Runs one group's task with `vp run`, from the root, in a process group of its own, and ends
 * whatever the group still runs once it exits: a Vitest worker of a stopped task sometimes lived on,
 * idle, for an hour, holding its machine-wide test slot.
 */
const runGroup = async (group: TestGroup, request: string, extra: NodeJS.ProcessEnv, noCache: boolean) => {
  const run = vpRunOf(taskName(group.files), noCache);
  const child = spawn(VP, run.args, {
    cwd: root,
    stdio: ['inherit', 'pipe', 'pipe'],
    detached: true,
    // Named even when it's the system's, as each task keys on `TZ`.
    env: {
      ...env,
      TZ: env['TZ'] ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...extra,
      ...run.env,
      TEST_TASKS: request,
    },
  });
  const printed = new Array<Buffer>();
  const keep = (to: NodeJS.WriteStream) => (chunk: Buffer) => {
    to.write(chunk);
    printed.push(chunk);
  };
  child.stdout?.on('data', keep(process.stdout));
  child.stderr?.on('data', keep(process.stderr));

  // `close`, not `exit`, so the output is all read.
  const status = await new Promise<number>((settle) =>
    child.once('close', (code, signal) => settle(code ?? (signal === null ? 1 : 128))),
  );

  // Throws when nothing in the group is left, which is what it's for.
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  } catch {}

  return printedOutcome(Buffer.concat(printed).toString('utf8'), groupTask(group).command, status) ?? 'failed';
};

const main = async () => {
  const { values, positionals } = parseArgs({
    args: argv.slice(2).filter((arg) => arg !== '--'),
    allowPositionals: true,
    options: {
      lanes: { type: 'string', default: '1' },
      times: { type: 'string' },
      'no-cache': { type: 'boolean', default: false },
      'verify-hits': { type: 'string', default: '0' },
    },
  });
  const lanes = Number(values.lanes);
  if (!Number.isSafeInteger(lanes) || lanes < 1) throw new Error('--lanes takes a whole number above 0');

  const noCache = values['no-cache'];
  const verifyHits = Number(values['verify-hits']);
  if (!Number.isSafeInteger(verifyHits) || verifyHits < 0) throw new Error('--verify-hits takes a whole number');

  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .stdout.split('\0')
    .filter((file) => file !== '' && existsSync(join(root, file)));
  const filters = positionals.map((path) => relative(root, resolve(path)));
  const under = (file: string) =>
    filters.some((filter) => filter === '' || file === filter || file.startsWith(`${filter}/`));
  const queue = queueOf(env);

  // Every group, from every ordinary file, so each task's name is the same in every run, and the
  // groups that hold a file asked for.
  const everyOrdinary = listed.filter(ORDINARY);
  const everyGroup = groupsOf(everyOrdinary);
  const groups = groupsWith(everyGroup, everyOrdinary.filter(under));
  const leftOut = listed.filter((file) => LEFT_OUT(file) && under(file));
  if (groups.length === 0 && queue === undefined) {
    console.error(`No ordinary test file under ${filters.join(', ') || 'nothing named'}.`);
    exit(1);
  }

  const ambiguous = [...groups.flatMap((group) => group.files), ...(queue?.batches.flat() ?? [])].flatMap(
    (file) => alsoMatched(file, everyOrdinary).map((other) => `${file} also runs ${other}`),
  );
  if (ambiguous.length > 0) {
    console.error(`Vitest takes a path as part of a path, so:\n${ambiguous.join('\n')}`);
    exit(1);
  }

  console.log(
    `test-lanes: ${groups.length} tasks in ${lanes} lanes, ${leftOut.length} files left out` +
      (queue === undefined ? '' : `; then the queue's ${queue.batches.length} batches`) +
      (noCache ? '; no cache' : ''),
  );

  const started = performance.now();
  const scratch = join(root, 'node_modules/.cache/test-lanes');
  const records = join(scratch, `records-${process.pid}.txt`);
  mkdirSync(scratch, { recursive: true });
  rmSync(records, { force: true });

  // Every task the run may ask for, so a lane's `vp run` finds whichever it names.
  const request = JSON.stringify({ groups: everyGroup });
  const extra: NodeJS.ProcessEnv = env['CI_RECORD'] === '1' ? { TEST_RECORDS: records } : {};
  const ran = new Map<string, readonly [TestGroup, Outcome]>();
  const waiting = [...groups];
  let nextBatch = 0;
  let claiming = Promise.resolve();

  // A batch of the queue, claimed: its groups not already run here, or none when another shard owns
  // it. An unsure claim runs too: duplicate work beats a lost batch.
  const claimBatch = async (batch: number) => {
    if (queue === undefined || queue.claimed.has(batch)) return [];

    const claim = await queue.claim(batch);
    if (claim === 'lost') return [];

    appendFileSync(queue.file, claimLine(batch, claim));
    const known = new Set([...ran.keys(), ...waiting.map((group) => taskName(group.files))]);
    const batchGroups = groupsWith(everyGroup, queue.batches[batch] ?? []).filter(
      (group) => !known.has(taskName(group.files)),
    );
    console.log(`test-lanes: batch ${batch} of the queue is this shard's, ${batchGroups.length} tasks`);

    return batchGroups;
  };

  // The shard's own groups first, then the queue's batches, claimed one at a time, serially, as a
  // lane runs out.
  const nextGroup = async (): Promise<TestGroup | undefined> => {
    for (;;) {
      const group = waiting.shift();
      if (group !== undefined) return group;

      if (nextBatch >= (queue?.batches.length ?? 0)) return undefined;

      claiming = claiming.then(async () => {
        if (nextBatch >= (queue?.batches.length ?? 0)) return;

        const batch = nextBatch;
        nextBatch += 1;
        waiting.push(...(await claimBatch(batch)));
      });
      await claiming;
    }
  };

  const lane = async () => {
    for (let group = await nextGroup(); group !== undefined; group = await nextGroup()) {
      ran.set(taskName(group.files), [group, 'not run']);
      ran.set(taskName(group.files), [group, await runGroup(group, request, extra, noCache)]);
    }
  };

  await Promise.all(Array.from({ length: lanes }, lane));

  // The replayed tasks to check, run again with no cache, in the same lanes. Their records are
  // left out of `--times`: what they print is a check of the cache, not the run's own time.
  const sample = verifySample(
    [...ran.entries()].map(([task, [group, outcome]]) => ({ task, group, outcome })),
    verifyHits,
    new Date().toISOString().slice(0, 10),
  );
  const verified = new Map<string, Outcome>();
  if (sample.length > 0) {
    console.log(`test-lanes: running ${sample.length} replayed tasks again, with no cache`);

    const checks = [...sample];
    const verify = async () => {
      for (let check = checks.shift(); check !== undefined; check = checks.shift()) {
        verified.set(check.task, 'not run');
        verified.set(check.task, await runGroup(check.group, request, {}, true));
      }
    };
    await Promise.all(Array.from({ length: Math.min(lanes, sample.length) }, verify));
  }
  const falseHits = sample.filter(({ task }) => verified.get(task) === 'failed');
  const unverified = sample.filter(({ task }) => verified.get(task) !== 'passed');

  const recorded = existsSync(records) ? readFileSync(records, 'utf8') : '';
  process.stdout.write(recorded);
  rmSync(records, { force: true });

  if (values.times !== undefined) {
    mkdirSync(dirname(resolve(values.times)), { recursive: true });
    writeFileSync(values.times, `${timesOf(recordsIn(recorded), Date.now())}\n`);
  }

  const count = (pick: (outcome: Outcome) => boolean) =>
    [...ran.values()].filter(([, outcome]) => pick(outcome)).reduce((sum, [group]) => sum + group.files.length, 0);
  const failed = count((outcome) => outcome !== 'local' && outcome !== 'remote' && outcome !== 'passed');
  console.log(
    `test-lanes: ${count((o) => o === 'local' || o === 'remote')} files replayed ` +
      `(${count((o) => o === 'remote')} remote), ${count((o) => o === 'passed')} ran and passed, ` +
      `${failed} failed or didn't finish` +
      (sample.length > 0 ? `; ${sample.length} hits run again, ${falseHits.length} failed` : '') +
      `, in ${Math.round((performance.now() - started) / 1000)} s.`,
  );

  for (const { group } of falseHits) {
    console.error(`test-lanes: ${group.files.join(' ')} replayed a pass, and fails run again.`);
  }
  if (unverified.length > falseHits.length) {
    console.error("test-lanes: a replayed task run again with no cache didn't finish.");
  }

  exit(failed > 0 || unverified.length > 0 ? 1 : 0);
};

if (argv[1] === fileURLToPath(import.meta.url)) await main();
