/**
 * ci-wait-hints.test.ts: tests for the hints, the areas and the batches. Run with
 * `node --test ci-wait-hints.test.ts`.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { CiRecord } from './ci-slow-files.ts';
import { area, batches, hintsIn, line, passingTimes, pastTheTime, type Row } from './ci-wait-hints.ts';

const record = (created: string, files: ReadonlyArray<readonly [string, string, number]>): CiRecord => ({
  run: 1,
  event: 'push',
  branch: 'main',
  created,
  jobs: [{ name: 'Tests 1/1', tests: [{ files }, null] }, { name: 'Plan', tests: null }],
});

const none = { sleep: 0, timeout: 0, poll: 0, retry: 0, fakeclock: 0, period: 0 };

describe('hintsIn', () => {
  test('counts the tests and each kind of wait', () => {
    const text = [
      "it('waits', async () => {",
      '  await sleep(10);',
      '  await waitFor(() => ready, { timeout: 30_000 });',
      '});',
      "it.effect('retries', () => Effect.retry(work, Schedule.spaced('5 seconds')));",
      "test.each([1, 2])('ticks', () => { vi.useFakeTimers(); vi.advanceTimersByTime(1000) });",
    ].join('\n');

    deepStrictEqual(hintsIn(text), {
      tests: 3,
      hints: { sleep: 1, timeout: 1, poll: 1, retry: 2, fakeclock: 2, period: 3 },
    });
  });

  test('a file with no waits has no hints', () => {
    deepStrictEqual(hintsIn("test('adds', () => expect(1 + 1).toBe(2));\n"), { tests: 1, hints: none });
  });
});

describe('area', () => {
  test("is the folder `depth` below the package's src, or the package", () => {
    strictEqual(area('packages/a/src/git/pack/read.test.ts', 1), 'packages/a/src/git');
    strictEqual(area('packages/a/src/git/pack/read.test.ts', 2), 'packages/a/src/git/pack');
    strictEqual(area('packages/a/src/read.test.ts', 1), 'packages/a/src');
    strictEqual(area('apps/web/e2e/sign-in.test.ts', 1), 'apps/web');
  });
});

describe('pastTheTime', () => {
  const times = passingTimes([
    ...[3, 30, 31, 32, 33, 34].map((took, at) => record(`2026-11-0${at + 1}`, [['slow.test.ts', 'passed', took * 1000]])),
    record('2026-11-01', [['slow.test.ts', 'failed', 900_000], ['fast.test.ts', 'passed', 2000], ['gone.test.ts', 'passed', 60_000]]),
  ]);
  const read = (path: string) => (path === 'repo/slow.test.ts' ? "it('a', () => sleep(1))\nit('b', () => {})\n" : undefined);

  test("times a file by its newest 5 passing runs, reads its hints, and lists apart one that's gone", () => {
    const { rows, gone } = pastTheTime(times, 10, 'repo', read);

    deepStrictEqual(rows, [[32, 'slow.test.ts', 6, 3, 34, 2, { ...none, sleep: 1 }]]);
    deepStrictEqual(gone, [[60, 'gone.test.ts']]);
    strictEqual(line(rows[0]!), '32.0\tslow.test.ts\t6\t3.0\t34.0\t2\t16.0\t1\t0\t0\t0\t0\t0');
  });

  test('a file at the time, not past it, is left out', () => {
    deepStrictEqual(pastTheTime(times, 60, 'repo', read), { rows: [], gone: [] });
  });
});

describe('batches', () => {
  const row = (path: string, median: number): Row => [median, path, 5, median, median, 1, none];

  test('small areas share `other`, and the batch with the most seconds comes first', () => {
    const rows = [row('p/src/a/1.test.ts', 50), row('p/src/b/1.test.ts', 40), row('p/src/b/2.test.ts', 40), row('p/src/c/1.test.ts', 5)];

    deepStrictEqual(
      batches(rows, 1, 2).map(([name, batch]) => [name, batch.map((r) => r[1])]),
      [
        ['p/src/b', ['p/src/b/1.test.ts', 'p/src/b/2.test.ts']],
        ['other', ['p/src/a/1.test.ts', 'p/src/c/1.test.ts']],
      ],
    );
  });
});
