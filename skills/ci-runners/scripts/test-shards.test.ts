/**
 * test-shards.test.ts: tests for the shard planner. Run with `node --test test-shards.test.ts`.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  batchSeconds,
  fileStart,
  fixedShare,
  groupsFor,
  keptSamples,
  merged,
  planOf,
  shardCount,
  shardSeconds,
  shardWorkers,
  timesIn,
} from './test-shards.ts';
import { localGrouping, SERVER_DIR } from './test-groups.ts';

/** A path in the heavy harness's folder. */
const server = (rest: string) => `${SERVER_DIR}${rest}`;

const results = (files: Record<string, number>, lastRun = 1) =>
  JSON.stringify({
    version: 1,
    projects: {
      workspace: {
        files: Object.fromEntries(
          Object.entries(files).map(([path, duration]) => [
            path,
            { failed: false, duration, lastRun },
          ]),
        ),
      },
    },
  });

/** Each file a group of its own. */
const alone = (files: ReadonlyArray<string>) => files.map((path) => [path]);

describe('planOf', () => {
  test('gives each shard the slowest files up to its fixed share, and queues the rest in batches', () => {
    const times = timesIn([
      results({
        [server('src/a.test.ts')]: 100_000,
        [server('src/b.test.ts')]: 100_000,
        ...Object.fromEntries(
          [1, 2, 3, 4, 5].map((at) => [`packages/cli/src/q${at}.test.ts`, 30_000 - at]),
        ),
      }),
    ]);

    const plan = planOf(
      alone([
        'packages/cli/src/q5.test.ts',
        'packages/cli/src/q1.test.ts',
        server('src/a.test.ts'),
        'packages/cli/src/q2.test.ts',
        'packages/cli/src/q4.test.ts',
        server('src/b.test.ts'),
        'packages/cli/src/q3.test.ts',
      ]),
      2,
      times,
    );

    // Each shard's fixed share is a quarter of the whole, about 88 s: a 100 s file fills it.
    deepStrictEqual(plan.shards, [[server('src/a.test.ts')], [server('src/b.test.ts')]]);
    // Batches of at least `batchSeconds`, slowest first.
    strictEqual(batchSeconds, 60);
    deepStrictEqual(plan.queue, [
      ['packages/cli/src/q1.test.ts', 'packages/cli/src/q2.test.ts'],
      ['packages/cli/src/q3.test.ts', 'packages/cli/src/q4.test.ts'],
      ['packages/cli/src/q5.test.ts'],
    ]);
  });

  test('fills each shard to its fixed share with smaller files, so the shards end together', () => {
    const times = timesIn([
      results(
        Object.fromEntries(
          Object.entries({ a: 20, b: 20, c: 15, d: 15, e: 10, f: 10, g: 5, h: 5 }).map(
            ([name, time]) => [`packages/cli/src/${name}.test.ts`, time],
          ),
        ),
      ),
    ]);
    const path = (name: string) => `packages/cli/src/${name}.test.ts`;

    const plan = planOf(alone(['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a'].map(path)), 2, times);

    // A fixed share of 0.5 / 2 of the whole, each file's start in it: a and g fill it, as b and h.
    deepStrictEqual([fixedShare, fileStart], [0.5, 440]);
    deepStrictEqual(plan.shards, [['a', 'g'].map(path), ['b', 'h'].map(path)]);
    deepStrictEqual(plan.queue, [['c', 'd', 'e', 'f'].map(path)]);
  });

  test('keeps a file it is asked to in a shard, and a run of one shard has no queue', () => {
    const times = timesIn([
      results({ [server('src/a.test.ts')]: 90, 'packages/cli/src/plugin.test.ts': 30 }),
    ]);
    const files = [server('src/a.test.ts'), 'packages/cli/src/plugin.test.ts'];

    deepStrictEqual(planOf(alone(files), 2, times).queue, []);
    deepStrictEqual(planOf(alone(files), 1, times), { shards: [files], queue: [] });
    deepStrictEqual(
      planOf(
        alone([...files, server('src/b.test.ts')]),
        2,
        timesIn([
          results({
            [server('src/a.test.ts')]: 90,
            [server('src/b.test.ts')]: 90,
            'packages/cli/src/plugin.test.ts': 30,
          }),
        ]),
        new Set(['packages/cli/src/plugin.test.ts']),
      ),
    {
      shards: [
        [server('src/a.test.ts'), 'packages/cli/src/plugin.test.ts'],
        [server('src/b.test.ts')],
      ],
      queue: [],
    });
  });

  test('counts a file no sweep timed as the 90th percentile of the server files, or the median of the rest', () => {
    const times = timesIn([
      results({
        [server('src/a.test.ts')]: 100,
        [server('src/b.test.ts')]: 30,
        [server('src/c.test.ts')]: 20,
        'packages/cli/src/d.test.ts': 5,
        'packages/cli/src/e.test.ts': 3,
        'packages/cli/src/f.test.ts': 1,
      }),
    ]);

    const plan = planOf(
      alone([
        server('src/a.test.ts'),
        server('src/b.test.ts'),
        server('src/c.test.ts'),
        server('src/new.test.ts'),
        'packages/cli/src/d.test.ts',
        'packages/cli/src/e.test.ts',
        'packages/cli/src/f.test.ts',
        'packages/cli/src/new.test.ts',
      ]),
      1,
      times,
    );

    // The new server file counts 100 ms and the new CLI file 3 ms.
    deepStrictEqual(plan.shards, [
      [
        server('src/a.test.ts'),
        server('src/new.test.ts'),
        server('src/b.test.ts'),
        server('src/c.test.ts'),
        'packages/cli/src/d.test.ts',
        'packages/cli/src/e.test.ts',
        'packages/cli/src/new.test.ts',
        'packages/cli/src/f.test.ts',
      ],
    ]);
  });

  test('spreads the files no sweep timed across the shards, as three files split from one big file', () => {
    // An invented example of a shape we met: a few slow server files and many fast ones, and a
    // change that splits three slow files from one big file. Counted at the median, the three
    // sorted together by path into one of the queue's batches, and the shard that claimed it
    // ended long after the others.
    const timed = [90, 60, 50, 48, 40, 30, 20, 12, 10, 8, 7, 7, 6, 5, 4, 3, 2, 2, 1, 1];
    const times = timesIn([
      results(
        Object.fromEntries(
          timed.map((time, at) => [server(`src/t${at}.test.ts`), time * 1000]),
        ),
      ),
    ]);
    const split = ['ceiling', 'reader-lock', 'receive-time'].map(
      (part) => server(`src/git/pack-${part}.test.ts`),
    );

    const plan = planOf(
      alone([...timed.map((_, at) => server(`src/t${at}.test.ts`)), ...split]),
      6,
      times,
    );

    // Each starts in a shard's own files, a shard each.
    deepStrictEqual(plan.queue.flat().filter((path) => split.includes(path)), []);
    deepStrictEqual(
      plan.shards.flatMap((shard) => {
        const held = shard.filter((path) => split.includes(path));

        return held.length === 0 ? [] : [held];
      }),
    split.map((path) => [path]));
  });
});

test('keeps a group together, in a shard or in one batch', () => {
  const times = timesIn([
    results({
      [server('src/a.test.ts')]: 100_000,
      [server('src/b.test.ts')]: 100_000,
      'packages/cli/src/c.test.ts': 1_000,
      'packages/cli/src/d.test.ts': 1_000,
    }),
  ]);

  const plan = planOf(
    [
      [server('src/a.test.ts')],
      [server('src/b.test.ts')],
      ['packages/cli/src/c.test.ts', 'packages/cli/src/d.test.ts'],
    ],
    2,
    times,
  );

  deepStrictEqual(plan, {
    shards: [[server('src/a.test.ts')], [server('src/b.test.ts')]],
    queue: [['packages/cli/src/c.test.ts', 'packages/cli/src/d.test.ts']],
  });
});

test("runs a file with its whole group, formed from every ordinary file, as the cached tasks are", () => {
  const every = [
    'packages/model/src/a.test.ts',
    'packages/model/src/b.test.ts',
    'packages/model/src/c.test.ts',
    'packages/model/src/d.test.ts',
    'packages/model/src/e.test.ts',
    'packages/model/src/x.sandbox.test.ts',
    'packages/model/src/a.ts',
  ];

  deepStrictEqual(
    groupsFor(
      ['packages/model/src/b.test.ts', 'packages/model/src/e.test.ts'],
      every,
      localGrouping,
    ),
  [
    [
      'packages/model/src/a.test.ts',
      'packages/model/src/b.test.ts',
      'packages/model/src/c.test.ts',
      'packages/model/src/d.test.ts',
    ],
    ['packages/model/src/e.test.ts'],
  ]);
  deepStrictEqual(groupsFor(['apps/x/new.test.ts'], every, localGrouping), [['apps/x/new.test.ts']]);
});

describe('shardCount', () => {
  // A shard's share of tests: its workers each running for its seconds, in ms.
  const shard = shardWorkers * shardSeconds * 1000;

  test('takes enough shards for each to run its share of the tests, and no more than the most', () => {
    const times = timesIn([
      results({ [server('src/a.test.ts')]: shard, [server('src/b.test.ts')]: shard + 1 }),
    ]);
    const files = [server('src/a.test.ts'), server('src/b.test.ts')];

    strictEqual(shardCount(files, 12, times), 3);
    strictEqual(shardCount(files, 2, times), 2);
    strictEqual(shardCount([server('src/a.test.ts')], 12, times), 1);
  });

  test('counts a server file no sweep timed as the 90th percentile of the timed ones', () => {
    const times = timesIn([results({ [server('src/a.test.ts')]: shard })]);

    strictEqual(
      shardCount([server('src/a.test.ts'), server('src/new.test.ts')], 12, times),
    2);
  });
});

describe('merged', () => {
  const a = server('src/a.test.ts');
  const b = server('src/b.test.ts');
  /** Stored times: each file's planned time and its samples, as `merged` writes them. */
  const stored = (files: Record<string, [number, ReadonlyArray<number>]>, through?: string) =>
    JSON.stringify({
      version: 1,
      ...(through === undefined ? {} : { through }),
      projects: {
        workspace: {
          files: Object.fromEntries(
            Object.entries(files).map(([path, [duration, times]]) => [
              path,
              { duration, lastRun: times.length, samples: times.map((ms, at) => [at + 1, ms]) },
            ]),
          ),
        },
      },
    });
  const read = (text: string) => JSON.parse(text).projects.workspace.files;

  test('keeps the times of files a run didn’t time, and a sweep’s run times the rest', () => {
    const before = results({ [a]: 90, [b]: 60 }, 1);
    const sweep = results({ [a]: 30 }, 2);

    deepStrictEqual(
      timesIn([merged([sweep, before]).text]),
      new Map([
        [a, 30],
        [b, 60],
      ]),
    );
  });

  test('plans from the median of the newest samples, so one slow runner moves nothing', () => {
    const before = stored({ [a]: [10_000, [10_000, 10_500]] });
    const slow = results({ [a]: 22_000 }, 9);

    strictEqual(timesIn([merged([slow, before]).text]).get(a), 10_500);
  });

  test(`keeps only each file’s newest ${keptSamples} samples`, () => {
    const before = stored({ [a]: [1_000, [1_000, 1_000, 1_000]] });
    const after = [10, 11, 12].map((at) => results({ [a]: 5_000 }, at));
    const { text, moved } = merged([...after, before]);

    strictEqual(read(text)[a].samples.length, keptSamples);
    strictEqual(timesIn([text]).get(a), 5_000);
    strictEqual(moved, 1);
  });

  test('a fold adds the files the stored times lack, and leaves stored files for a sweep', () => {
    const before = stored({ [a]: [10_000, [10_000, 10_000, 10_000]] });
    const fresh = server('src/new.test.ts');
    const prs = [4, 5].map((at) => results({ [a]: 40_000, [fresh]: 7_000 + at }, at));

    const fold = merged(prs, { fold: before });
    deepStrictEqual([fold.added, fold.moved], [1, 0]);
    // A pull request's run hands over a merge of its shards, samples and all: still measurements.
    deepStrictEqual(read(merged([merged(prs).text], { fold: before }).text)[a], read(before)[a]);
    deepStrictEqual(read(fold.text)[a], read(before)[a]);
    strictEqual(timesIn([fold.text]).get(fresh), 7_004);

    // A sweep's refresh then takes the slower file's new times.
    strictEqual(timesIn([merged([...prs, fold.text]).text]).get(a), 40_000);
  });

  test('counts a sample once when the same results come twice', () => {
    const fresh = server('src/new.test.ts');
    const pr = results({ [fresh]: 40_000 }, 3);
    const once = merged([pr]).text;

    deepStrictEqual(read(merged([pr, once]).text)[fresh].samples, [[3, 40_000]]);
  });

  test('carries the newest merge it holds, unless told a newer one', () => {
    const before = stored({ [a]: [10_000, [10_000]] }, 'abc');

    strictEqual(JSON.parse(merged([before]).text).through, 'abc');
    strictEqual(JSON.parse(merged([before], { through: 'def' }).text).through, 'def');
  });
});
