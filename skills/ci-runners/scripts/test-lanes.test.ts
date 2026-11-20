/**
 * test-lanes.test.ts: tests for the lane runner's outcome reading, its no-cache switch and its
 * daily sample of replays to check. Run with `node --test test-lanes.test.ts`.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type Outcome, printedOutcome, verifySample, vpRunOf } from './test-lanes.ts';

describe('printedOutcome', () => {
  test('reads a replay from either tier, and a run from its status', () => {
    strictEqual(printedOutcome('~/repo$ vitest run a (remote cache hit, replaying)', 'vitest run a', 0), 'remote');
    strictEqual(printedOutcome('~/repo$ vitest run a (cache hit, replaying)', 'vitest run a', 0), 'local');
    strictEqual(printedOutcome('~/repo$ vitest run a', 'vitest run a', 0), 'passed');
    strictEqual(printedOutcome('~/repo$ vitest run a', 'vitest run a', 1), 'failed');
    strictEqual(printedOutcome('~/repo$ vitest run a', 'vitest run a', 137), 'stopped');
    strictEqual(printedOutcome('nothing of the task', 'vitest run a', 1), undefined);
  });
});

describe('vpRunOf', () => {
  test('with no cache, turns off both tiers, so it reads and writes neither', () => {
    deepStrictEqual(vpRunOf('t', true), {
      args: ['run', '--concurrency-limit', '1', '--no-cache', 't'],
      env: { VP_REMOTE_CACHE: 'off' },
    });
  });

  test('otherwise, leaves the cache as the environment sets it', () => {
    deepStrictEqual(vpRunOf('t', false), { args: ['run', '--concurrency-limit', '1', 't'], env: {} });
  });
});

describe('verifySample', () => {
  const results = (outcomes: ReadonlyArray<Outcome>) => outcomes.map((outcome, at) => ({ task: `task-${at}`, outcome }));

  test('takes only replays, at most the count asked for', () => {
    const sample = verifySample(results(['local', 'passed', 'remote', 'local', 'passed']), 2, '2026-01-01');

    strictEqual(sample.length, 2);
    for (const { outcome } of sample) strictEqual(outcome === 'local' || outcome === 'remote', true);
  });

  test('takes none when the run failed or left a task unfinished', () => {
    deepStrictEqual(verifySample(results(['local', 'failed']), 3, '2026-01-01'), []);
    deepStrictEqual(verifySample(results(['local', 'not run']), 3, '2026-01-01'), []);
    deepStrictEqual(verifySample(results(['local', 'stopped']), 3, '2026-01-01'), []);
  });

  test('is the same within a day, and changes across days', () => {
    const many = results(Array.from({ length: 40 }, () => 'local' as const));
    const day = (date: string) => verifySample(many, 3, date).map(({ task }) => task);

    deepStrictEqual(day('2026-01-01'), day('2026-01-01'));
    const days = new Set(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'].map((date) => day(date).join()));
    strictEqual(days.size > 1, true);
  });
});
