/**
 * container-pack.test.ts: tests for packing container test files into jobs, and the sizing rules.
 * Run with `node --test container-pack.test.ts`.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';

import { manualShards, pack, runnerFor } from './container-pack.ts';

test('packs longest first into about 150 s jobs, each onto the least-loaded job', () => {
  const jobs = pack(
    ['t/a.sandbox.test.ts', 't/b.sandbox.test.ts', 't/c.sandbox.test.ts', 't/d.sandbox.test.ts'],
    { a: 120, b: 90, c: 50 },
  );

  // 320 s in all makes 3 jobs; d has no estimate and counts 60 s.
  deepStrictEqual(
    jobs.map(({ name, seconds }) => [name, seconds]),
    [
      ['a', 120],
      ['b', 90],
      ['d, c', 110],
    ],
  );
});

test('packs nothing into no jobs', () => {
  deepStrictEqual(pack([]), []);
});

test('a small run goes on 2 vCPU, and a run by hand gets one to five shards', () => {
  strictEqual(runnerFor(42, 2).workers, 2);
  strictEqual(runnerFor(43, 2).workers, 6);
  strictEqual(manualShards(3, 0), 1);
  strictEqual(manualShards(400, 100), 3);
  strictEqual(manualShards(5000, 1000), 5);
});
