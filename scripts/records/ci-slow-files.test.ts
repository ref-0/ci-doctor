/**
 * ci-slow-files.test.ts: tests for the ranking and the helpers ci-wait-hints.ts shares. Run with
 * `node --test ci-slow-files.test.ts`.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { byFields, type CiRecord, jsonLines, large, median, report } from './ci-slow-files.ts';

const options = { top: 40, testJobPrefix: 'Tests ', fullRunJobs: 10 };

/** One attempt whose one test job ran `files`, as [path, status, ms]. */
const attempt = (
  run: number,
  files: ReadonlyArray<readonly [string, string, number]>,
  extra: Partial<CiRecord> & { failed?: string[][]; flaky?: Array<Array<string | number>> } = {},
): CiRecord => ({
  run,
  attempt: 1,
  event: 'pull_request',
  branch: 'feature',
  sha: `${run}`.padStart(40, 'a'),
  created: '2026-11-02T16:01:50Z',
  plan: null,
  jobs: [{ name: 'Tests 1/2', tests: [{ files, failed: extra.failed ?? [], flaky: extra.flaky ?? [] }] }],
  ...extra,
});

/** The lines of the report's section titled `title`, up to the next blank line. */
const section = (lines: ReadonlyArray<string>, title: string) => {
  const at = lines.findIndex((line) => line.startsWith(title));
  const end = lines.indexOf('', at);
  return lines.slice(at + 1, end === -1 ? undefined : end);
};

describe('report', () => {
  test('times a file by the median of its newest 5 passing runs, ordered by run, not by when created', () => {
    const seconds = [100, 1, 2, 3, 4, 5];
    const records = seconds.map((took, at) => attempt(at + 1, [['a.test.ts', 'passed', took * 1000]], { created: `2026-11-${30 - at}T00:00:00Z` }));
    const lines = report(records, options);

    deepStrictEqual(section(lines, 'Slowest files'), [`     3.0  5    6    1.0  100.0  ${'6'.padStart(40, 'a').slice(0, 8)}  a.test.ts`]);
  });

  test("leaves a run that didn't pass out of the times, and lists its failures with their runs", () => {
    const records = [
      attempt(1, [['a.test.ts', 'passed', 2000]]),
      attempt(2, [['a.test.ts', 'failed', 90_000]], { failed: [['a.test.ts', 'a > fails']], branch: "it's" }),
    ];
    const lines = report(records, options);

    strictEqual(lines[0], "2 run attempts, 1 files timed, 1 file runs that didn't pass left out of the times");
    deepStrictEqual(section(lines, 'Slowest files'), [`     2.0  1    1    2.0    2.0  ${'1'.padStart(40, 'a').slice(0, 8)}  a.test.ts  thin`]);
    deepStrictEqual(section(lines, 'Failed'), ['  1x a.test.ts > a > fails\n      [[2,"pull_request","it\'s","11-02T16:01"]]']);
  });

  test('lists a spread past 20 s in 3 or more runs, widest first', () => {
    const runs = (path: string, seconds: number[]) => seconds.map((took, at) => attempt(at + 1, [[path, 'passed', took * 1000]]));
    const records = [...runs('narrow.test.ts', [30, 31, 32]), ...runs('wide.test.ts', [5, 6, 40]), ...runs('wider.test.ts', [1, 2, 50]), ...runs('two.test.ts', [1, 50])];

    deepStrictEqual(section(report(records, options), 'Widest spread'), [
      '     1.0 ..   50.0  runs   3  wider.test.ts',
      '     5.0 ..   40.0  runs   3  wide.test.ts',
    ]);
  });

  test('keeps only the asked event and commits', () => {
    const records = [attempt(1, [['a.test.ts', 'passed', 1]]), attempt(2, [['b.test.ts', 'passed', 1]], { event: 'push' })];

    strictEqual(report(records, { ...options, event: 'push' })[0], '1 run attempts, 1 files timed, 0 file runs that didn\'t pass left out of the times');
    strictEqual(report(records, { ...options, shas: new Set([records[0]!.sha!]) })[0], '1 run attempts, 1 files timed, 0 file runs that didn\'t pass left out of the times');
  });

  test("totals a large run's fresh seconds and says why it counts as large", () => {
    const everything = attempt(7, [['a.test.ts', 'passed', 1500], ['b.test.ts', 'failed', 1000]], { plan: { packages: null }, attempt: 2 });

    deepStrictEqual(section(report([everything, attempt(8, [['a.test.ts', 'passed', 1]])], options), 'Large runs'), [
      '  11-02T16:01 7/2 pull_request       1 jobs     2 files fresh        3 s  (plan: everything)',
    ]);
  });
});

describe('large', () => {
  test('a plan that selected everything, else the shard count, else not large', () => {
    strictEqual(large(attempt(1, [], { plan: { packages: null } }), 1, 10), 'plan: everything');
    strictEqual(large(attempt(1, [], { plan: { packages: ['a'] } }), 10, 10), 'heuristic: shards');
    strictEqual(large(attempt(1, [], { plan: {} }), 9, 10), null);
  });
});

describe('median', () => {
  test('of an odd and an even count', () => {
    strictEqual(median([3, 1, 2]), 2);
    strictEqual(median([4, 1, 2, 3]), 2.5);
  });
});

describe('byFields', () => {
  test('orders field by field, then the shorter first', () => {
    deepStrictEqual([[2, 'a'], [1, 'b'], [1, 'a', 0], [1, 'a']].sort(byFields), [[1, 'a'], [1, 'a', 0], [1, 'b'], [2, 'a']]);
  });
});

describe('jsonLines', () => {
  test('reads every line of a file larger than a chunk, the last one without a newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-slow-files-'));
    const file = join(dir, 'records.jsonl');
    const lines = Array.from({ length: 3000 }, (_, at) => JSON.stringify({ at, pad: 'é'.repeat(300) }));
    writeFileSync(file, lines.join('\n'));

    try {
      deepStrictEqual([...jsonLines<{ at: number }>(file)].map(({ at }) => at), lines.map((_, at) => at));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
