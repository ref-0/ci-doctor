/**
 * flake-issues.test.ts: the flake filer's pure parts: which flakes an attempt finds, the marker's
 * round trip, the P1 bump, the close rule, and the text it posts.
 *
 * Runs: `node --test scripts/flakes/`. Needs nothing but Node 24.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  bodyOf,
  closes,
  codeSpan,
  commentOf,
  excerptLimit,
  excerptOf,
  fenced,
  flakesOf,
  isHot,
  jobTestsLimit,
  linesIn,
  markerIn,
  occurred,
  proofOf,
  titleOf,
  type Flake,
  type FlakesLine,
  type Marker,
  type RunFacts,
} from './flake-issues.ts';
import { decodeRecord, recordLine, recordsIn } from './records.ts';

const day = 24 * 60 * 60 * 1000;

const now = new Date('2026-11-05T12:00:00Z');

const daysAgo = (days: number) => new Date(now.getTime() - days * day);

const flake: Flake = {
  kind: 'test',
  file: 'src/merge/handovers.test.ts',
  test: 'a handover > finishes a handover cut short when its job runs again',
  excerpt: 'AssertionError: expected 1 to be 2',
  how: 'It failed, then passed when it ran again in the same job.',
};

const run: RunFacts = {
  url: 'https://github.com/<org>/<repo>/actions/runs/1001/attempts/1',
  id: '1001',
  attempt: 1,
  event: 'pull_request',
  sweep: false,
  pr: '12',
  branch: 'fix/flake-issues',
  sha: `4cdabfd48d${'0'.repeat(30)}`,
  changed: new Set(),
};

const line = (
  attempt: number,
  job: string,
  failed: FlakesLine['failed'],
  flaky: FlakesLine['flaky'] = [],
): FlakesLine => ({ attempt, job, failed, flaky });

describe('flakesOf', () => {
  it('files each test that passed only on its retry in this attempt, once', () => {
    const lines = [
      line(1, 'Tests 1/3', [], [[flake.file, flake.test, 1, flake.excerpt]]),
      line(1, 'Tests 2/3', [], [[flake.file, flake.test, 1, flake.excerpt]]),
      // An earlier attempt's retry was that attempt's to file.
      line(0, 'Tests 3/3', [], [['src/a.test.ts', 'b', 1, '']]),
    ];

    assert.deepEqual(flakesOf(lines, 1, []).map(titleOf), [`Flaky: ${flake.file} › ${flake.test}`]);
  });

  it("files each test a job's failed attempt named, when it passed on this one", () => {
    const lines = [line(1, 'Heavy queue', [['src/merge/queue.sandbox.test.ts', 'turns', 'boom']])];
    const jobs = [
      { name: 'Heavy queue', conclusion: 'failure', run_attempt: 1 },
      { name: 'Heavy queue', conclusion: 'success', run_attempt: 2 },
      // The result job reruns for reasons of its own, so it's never a flake.
      { name: 'CI result', conclusion: 'failure', run_attempt: 1 },
      { name: 'CI result', conclusion: 'success', run_attempt: 2 },
    ];

    assert.deepEqual(flakesOf(lines, 2, jobs), [
      {
        kind: 'test',
        file: 'src/merge/queue.sandbox.test.ts',
        test: 'turns',
        excerpt: 'boom',
        how: 'Its job, `Heavy queue`, failed on attempt 1 and passed on attempt 2.',
      },
    ]);
  });

  it('files the job when its failed attempt named no test, or more than a few', () => {
    const many = Array.from({ length: jobTestsLimit + 1 }, (_, index) => [`src/${String(index)}.test.ts`, 'a', ''] as const);
    const jobs = [
      { name: 'Build', conclusion: 'failure', run_attempt: 1 },
      { name: 'Build', conclusion: 'success', run_attempt: 2 },
      { name: 'Tests 1/2', conclusion: 'failure', run_attempt: 1 },
      { name: 'Tests 1/2', conclusion: 'success', run_attempt: 2 },
      // Failed and not yet passed: not a flake.
      { name: 'Tests 2/2', conclusion: 'failure', run_attempt: 1 },
      { name: 'Tests 2/2', conclusion: 'failure', run_attempt: 2 },
    ];

    assert.deepEqual(flakesOf([line(1, 'Tests 1/2', many)], 2, jobs).map(titleOf), ['Flaky job: Build', 'Flaky job: Tests 1/2']);
  });

  it('files a failure once, on the attempt that first passed after it', () => {
    const lines = [line(1, 'Tests 1/1', [['a.test.ts', 'b', '']])];
    const jobs = [1, 2, 3].map((attempt) => ({
      name: 'Tests 1/1',
      conclusion: attempt === 1 ? 'failure' : 'success',
      run_attempt: attempt,
    }));

    assert.deepEqual(flakesOf(lines, 2, jobs).map(titleOf), ['Flaky: a.test.ts › b']);
    assert.deepEqual(flakesOf(lines, 3, jobs), []);
  });
});

describe('the marker', () => {
  it('reads back what the body wrote, whatever a test name holds', () => {
    const named: Flake = { ...flake, test: 'ends --> <b>here</b> & `there`' };
    const marker = occurred(undefined, named, now);
    const body = bodyOf(marker, now);

    assert.deepEqual(markerIn(body), marker);
    // The marker's comment ends only where it should, whatever the name; the name shows as code above.
    const markerLine = body.split('\n').at(-1) ?? '';
    assert.equal(markerLine.indexOf('-->'), markerLine.length - 3);
    assert.ok(!markerLine.includes('<b>'));
    assert.ok(body.includes('`` ends --> <b>here</b> & `there` ``'));
    assert.equal(markerIn('A body someone wrote by hand.'), undefined);
    assert.equal(markerIn('<!-- ci-flake {"kind":"test"} -->'), undefined);
  });

  it('counts each occurrence, starts the clean runs again and keeps the first seen', () => {
    const first = occurred(undefined, flake, daysAgo(3));
    const counted: Marker = { ...first, clean: 12 };
    const second = occurred(counted, flake, now);

    assert.equal(second.count, 2);
    assert.equal(second.first, daysAgo(3).toISOString());
    assert.equal(second.clean, 0);
    assert.deepEqual(second.seen, [daysAgo(3).toISOString(), now.toISOString()]);
  });

  it('is hot at three occurrences in seven days', () => {
    const twice = occurred(occurred(undefined, flake, daysAgo(8)), flake, daysAgo(2));

    assert.equal(isHot(occurred(twice, flake, now), now), false);
    assert.equal(isHot(occurred(occurred(twice, flake, daysAgo(1)), flake, now), now), true);
  });

  it('closes after seven quiet days and fifty clean runs, not one without the other', () => {
    const quiet = { ...occurred(undefined, flake, daysAgo(7)), clean: 50 };

    assert.equal(closes(quiet, now), true);
    assert.equal(closes({ ...quiet, clean: 49 }, now), false);
    assert.equal(closes({ ...occurred(undefined, flake, daysAgo(6)), clean: 500 }, now), false);
  });

  it("closes a sweep-only file's or a job's after seven clean runs, a week of daily sweeps", () => {
    for (const marker of [
      { ...occurred(undefined, flake, daysAgo(7)), file: 'src/merge/queue.sandbox.test.ts' },
      { ...occurred(undefined, flake, daysAgo(7)), file: 'src/replay/a.proof.test.ts' },
      { ...occurred(undefined, flake, daysAgo(7)), kind: 'job' as const, job: 'Tests 1/3' },
    ]) {
      assert.equal(closes({ ...marker, clean: 7 }, now), true);
      assert.equal(closes({ ...marker, clean: 6 }, now), false);
    }
  });
});

describe('the text', () => {
  it('bounds an excerpt and strips its colours', () => {
    const excerpt = excerptOf([{ message: '\u001b[31mred\u001b[39m', stack: 'x'.repeat(5000) }]);

    assert.ok(excerpt.startsWith('red\n'));
    assert.equal(excerpt.length, excerptLimit);
    assert.equal(excerptOf(undefined), '');
    assert.equal(
      excerptOf(
        [
          {
            message: 'boom',
            stack: [
              'Error: boom',
              '    at /runner/work/repo/scripts/a.test.ts:8:17',
              '    at file:///runner/work/repo/node_modules/vitest/dist/run.js:1632:35',
              '    at new Promise (<anonymous>)',
              '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
            ].join('\n'),
          },
        ],
        '/runner/work/repo',
      ),
      'Error: boom\n    at scripts/a.test.ts:8:17',
    );
  });

  it('fences code longer than any backticks inside, so nothing escapes it', () => {
    assert.equal(codeSpan('a `b` c'), '``a `b` c``');
    assert.equal(codeSpan('`a`'), '`` `a` ``');
    assert.equal(fenced('```\n@someone'), '````text\n```\n@someone\n````');
  });

  it('says the pull request changes the file, when it does', () => {
    const own = commentOf(flake, { ...run, changed: new Set([flake.file]) });

    assert.ok(own.includes("Likely this pull request's own"));
    assert.ok(own.includes('#12 from `fix/flake-issues`'));
    assert.ok(!commentOf(flake, run).includes("Likely this pull request's own"));
  });

  it('gives each kind of file a proof run', () => {
    assert.ok(proofOf('src/zip.test.ts').includes('-f test_paths=src/zip.test.ts -f repeat=50'));
    assert.ok(proofOf('src/queue.sandbox.test.ts').includes('-f repeat=20'));
  });
});

describe('linesIn', () => {
  it('reads every line of every flakes file restored into the folder, and skips what it can’t', () => {
    const folder = mkdtempSync(join(tmpdir(), 'flake-issues-'));

    try {
      writeFileSync(
        join(folder, 'flakes-7-1-tests-1.jsonl'),
        `${JSON.stringify(line(1, 'Tests 1/1', [['a.test.ts', 'b', 'c']]))}\nnot json\n{"attempt":1}\n`,
      );

      assert.deepEqual(linesIn(folder), [line(1, 'Tests 1/1', [['a.test.ts', 'b', 'c']])]);
      assert.deepEqual(linesIn(join(folder, 'none')), []);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('records', () => {
  it('reads records back from a log, past the step that printed them and lines it can’t read', () => {
    const tests = { kind: 'tests', files: [['a.test.ts', 'passed', 12]], failed: [], flaky: [], errors: 0 } as const;
    const log = [
      "2026-11-05T03:33:09.9Z \u001b[36;1m}' | sed 's/^/ci-record /'\u001b[0m",
      `2026-11-05T03:33:10.1Z ${recordLine(tests).trim()}\r`,
      '2026-11-05T03:33:10.2Z ci-record {"kind":"tests"}',
    ].join('\n');

    assert.deepEqual(recordsIn(log), [tests]);
    assert.equal(decodeRecord('{"kind":"plan","sha":"HEAD"}'), undefined);
  });
});
