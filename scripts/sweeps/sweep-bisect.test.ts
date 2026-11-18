/**
 * sweep-bisect.test.ts: the pure parts of the bisect: which check a run by hand runs, its verdict,
 * the halving, the recorded verdicts that cover files, and the month's bill.
 *
 *     node --test scripts/sweeps/sweep-bisect.test.ts
 *
 * Reference implementation from a production monorepo; adapt to your repo. The job names follow
 * the CONFIG block of sweep-bisect.ts; change both together.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  billOf,
  bisectBudget,
  bisectRecordsIn,
  boundaryFiles,
  botLogin,
  byHandTag,
  checkAt,
  checkOf,
  controllerTitle,
  coveredFiles,
  failedOf,
  halve,
  listingLimit,
  maxSteps,
  mayRun,
  monthStart,
  nextIndex,
  pullIn,
  recordMarker,
  tierOf,
  verdictOf,
  type BisectRecord,
  type Job,
  type Pull,
  wholeListing,
} from './sweep-bisect.ts';

const job = (name: string, conclusion: string | null = 'failure', id = 1): Job => ({ id, name, conclusion });

describe("a failed run's check", () => {
  it("runs a shard's failed test files, at most four, as test_paths", () => {
    const files = ['a.test.ts', 'b.test.ts', 'a.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts'];
    const check = checkOf([job('Tests 3/14')], () => files);

    assert.deepEqual(check?.inputs, { test_paths: 'a.test.ts b.test.ts c.test.ts d.test.ts' });
    assert.deepEqual(check?.files, ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts']);
  });

  it("runs a heavy job's first failed file alone", () => {
    const check = checkOf([job('Heavy publish')], () => ['src/queue.sandbox.test.ts']);

    assert.deepEqual(check?.inputs, { heavy_file: 'src/queue.sandbox.test.ts' });
  });

  it('runs packaging and what tests the package with pack_only', () => {
    for (const name of ['Pack', 'Proof'])
      assert.deepEqual(checkOf([job(name)], () => [])?.inputs, { pack_only: 'true' }, name);
  });

  it('runs a static job beside one quick test, and reads only that job', () => {
    assert.ok(checkOf([job('Build and generated files')], () => []) !== undefined);

    const check = checkOf([job('Format, lint and types')], () => []);
    assert.ok(check !== undefined);

    assert.deepEqual(check.inputs, { test_paths: '<quick-test-file>' });
    assert.equal(verdictOf(check, [job('Format, lint and types', 'success'), job('Tests 1/1')], () => []), 'passed');
    assert.equal(verdictOf(check, [job('Format, lint and types')], () => []), 'failed');
  });

  it('skips a job it reads no file from, and has none for a job no run by hand checks alone', () => {
    assert.equal(
      checkOf([job('Tests 1/2'), job('Heavy x')], () => []),
      undefined,
    );
    assert.equal(
      checkOf([job('Property tests, deeper'), job('CI result')], () => []),
      undefined,
    );
    assert.deepEqual(checkOf([job('Plan'), job('Tests 2/2')], () => ['x.test.ts'])?.files, ['x.test.ts']);
  });
});

describe('a run by hand of the check', () => {
  const check = checkOf([job('Tests 1/3')], () => ['a.test.ts'])!;
  const records = () => ['a.test.ts'];

  it("passes when every job of the check passed, and fails when one's records name its file", () => {
    assert.equal(verdictOf(check, [job('Plan', 'success'), job('Tests 1/1', 'success')], records), 'passed');
    assert.equal(verdictOf(check, [job('Tests 1/2', 'success'), job('Tests 2/2')], records), 'failed');
  });

  it("is unread when the check didn't run, hasn't ended, or failed before its file did", () => {
    assert.equal(verdictOf(check, [job('Plan')], records), 'unread');
    assert.equal(verdictOf(check, [job('Tests 1/1', 'skipped')], records), 'unread');
    assert.equal(verdictOf(check, [job('Tests 1/1', null)], records), 'unread');
    // Its setup failed, or it was cancelled or timed out, before a record named the file.
    assert.equal(verdictOf(check, [job('Tests 1/1')], () => []), 'unread');
    assert.equal(verdictOf(check, [job('Tests 1/1', 'cancelled')], () => ['b.test.ts']), 'unread');
  });

  it('runs only the files a commit holds, and passes where it holds none', () => {
    const two = checkOf([job('Tests 1/3')], () => ['a.test.ts', 'b.test.ts'])!;

    assert.equal(checkAt(two, (path) => path === 'b.test.ts')?.inputs['test_paths'], 'b.test.ts');
    assert.equal(checkAt(two, () => false), undefined);

    const packOnly = checkOf([job('Pack')], () => [])!;
    assert.equal(checkAt(packOnly, () => false), packOnly);
  });
});

describe('the bisect', () => {
  it("builds a sweep on the last passing sweep, and a slice on its pass or a sweep's", () => {
    const sweep = tierOf('CI on main, daily');
    const slice = tierOf('Server tests on main');

    assert.equal(sweep?.passes('CI on main, every 2 hours'), true);
    assert.equal(sweep?.passes('Server tests on main'), false);
    assert.equal(slice?.passes('Server tests on main'), true);
    assert.equal(slice?.passes('CI on main, daily'), true);
    assert.equal(slice?.passes('CI by hand on main'), false);
    assert.equal(tierOf('CI by hand on main'), undefined);
    assert.equal(tierOf('Server tests on fix'), undefined);
  });

  it('halves the merges between the last pass and the first failure until they meet', () => {
    assert.equal(nextIndex(-1, 9), 4);
    assert.equal(nextIndex(4, 9), 6);
    assert.equal(nextIndex(6, 7), undefined);
    assert.equal(nextIndex(-1, 0), undefined);
  });

  it(`splits 64 merges to one in at most ${String(maxSteps)} runs`, () => {
    const broke = 41;
    let good = -1;
    let bad = 63;
    let runs = 0;

    for (let index = nextIndex(good, bad); index !== undefined; index = nextIndex(good, bad)) {
      runs++;

      if (index < broke) good = index;
      else bad = index;
    }

    assert.equal(bad, broke);
    assert.ok(runs <= maxSteps);
  });

  it('names the pull request that merged as the commit, by merge button or squash', () => {
    const pull = (number: number, merged: string | null): Pull => ({
      number,
      merge_commit_sha: merged,
      head: { ref: `fix-${String(number)}` },
      user: { login: 'someone' },
    });
    // A branch's own commit lists the pull request it's on, which merged as another commit.
    const pulls = [pull(12, 'aaaa'), pull(9, 'bbbb'), pull(10, null)];

    assert.deepEqual(pullIn(pulls, 'bbbb'), { number: 9, branch: 'fix-9', author: 'someone' });
    assert.equal(pullIn(pulls, 'cccc'), undefined);
  });

  it('stops at the first unread run by hand, and at no more than maxSteps', async () => {
    const check = checkOf([job('Tests 1/1')], () => ['a.test.ts'])!;
    const merges = Array.from({ length: 200 }, (_, index) => `m${String(index)}`);
    const unread = await halve(check, merges, async () => ({ verdict: 'unread', line: '' }), () => () => true);

    assert.equal(unread.steps.length, 1);

    const failing = await halve(check, merges, async () => ({ verdict: 'failed', line: '' }), () => () => true);
    assert.equal(failing.steps.length, maxSteps);

    const refused = await halve(check, merges, async () => undefined, () => () => true);
    assert.equal(refused.stopped, true);
  });
});

describe("a slice's bisect", () => {
  const a = 'src/a.test.ts';
  const b = 'src/b.test.ts';
  const z = 'src/z.test.ts';

  /** A record of a failed slice made `hour` hours into a day, with what it ran by hand. */
  const record = (hour: number, failed: ReadonlyArray<string>, probed?: BisectRecord['probed'], finished = probed !== undefined): BisectRecord => {
    const seen: BisectRecord = { run: String(1000 + hour), sha: `sha${String(hour)}`, at: `2026-01-09T${String(hour).padStart(2, '0')}:00:00Z`, failed, finished };

    return probed === undefined ? seen : { ...seen, probed };
  };

  const bot = (body: string) => ({ author: botLogin, body });

  it("reads records from the workflow's bot alone, and ignores a forged or broken one", () => {
    const own = record(1, [a], { files: [a], verdict: 'failed' });
    const forged = recordMarker(record(2, [b], { files: [b], verdict: 'failed' }));
    // An old shape, here a negative spend, no longer decodes.
    const credit = '<!-- ci-bisect {"run":"0","sha":"unused","files":[],"at":"2026-01-10T00:00:00Z","vcpuMinutes":-6000} -->';
    const posted = [
      bot('The slice failed on `sha1`.'),
      bot(`Bisected.\n\n${recordMarker(own)}`),
      // Anyone who can read the repository can comment: a reader's marker covers nothing.
      { author: 'someone', body: forged },
      { author: 'someone', body: credit },
      bot(credit),
      bot(forged.replace('"verdict":"failed"', '"verdict":"fine"')),
    ];

    assert.deepEqual(bisectRecordsIn(posted), [own]);
  });

  it('covers only files a run by hand found failing, never those a run only saw fail', () => {
    const records = [record(1, [a], { files: [a], verdict: 'failed' }), record(7, [a, b])];
    assert.deepEqual([...coveredFiles(records, [])], [a]);

    // A failure across every shard, whose run by hand ran a of the three: b and z stay uncovered.
    const allShards = [record(1, [a, b, z], { files: [a], verdict: 'failed' }), record(7, [a, b, z])];
    assert.deepEqual([...coveredFiles(allShards, [])], [a]);
  });

  it('bisects regression B once A is fixed, and retires what a later run or a pass no longer fails', () => {
    const bothFail = [record(1, [a], { files: [a], verdict: 'failed' }), record(7, [a, b])];
    assert.equal(coveredFiles(bothFail, []).has(b), false);

    // A is fixed: the next run fails only B, which retires A, and B is still uncovered.
    const onlyB = [...bothFail, record(13, [b])];
    assert.deepEqual([...coveredFiles(onlyB, [])], []);

    // B's own bisect runs it by hand and covers it, until a slice passes.
    const bisectedB = [...onlyB, record(14, [b], { files: [b], verdict: 'failed' })];
    assert.deepEqual([...coveredFiles(bisectedB, [])], [b]);
    assert.deepEqual([...coveredFiles(bisectedB, ['2026-01-09T20:00:00Z'])], []);
    // A pass made before the record retires nothing.
    assert.deepEqual([...coveredFiles(bisectedB, ['2026-01-09T10:00:00Z'])], [b]);
  });

  it('covers only the files the run by hand saw fail, not every file it ran', () => {
    const check = checkOf([job('Tests 2/14')], () => [a, b])!;
    const ran = [job('Tests 1/1')];
    const seen = failedOf(check, ran, () => [a]);

    assert.equal(verdictOf(check, ran, () => [a]), 'failed');
    assert.deepEqual(seen, [a]);
    assert.deepEqual([...coveredFiles([record(1, [a, b], { files: seen, verdict: 'failed' })], [])], [a]);
  });

  it('covers only the files that failed at the merge it found, so a later regression gets its own', async () => {
    // a breaks at m2 and b at m3; m1 passes, and the run at m4 fails both.
    const merges = ['m1', 'm2', 'm3', 'm4'];
    const brokeAt = new Map([
      [a, 1],
      [b, 2],
    ]);
    const check = checkOf([job('Tests 2/14')], () => [a, b])!;
    const seenAt = new Map<string, ReadonlyArray<string>>([['m4', [a, b]]]);
    const halved = await halve(
      check,
      merges,
      async (there, at) => {
        const seen = [a, b].filter((file) => merges.indexOf(at) >= (brokeAt.get(file) ?? merges.length));
        seenAt.set(at, seen);
        const verdict = verdictOf(there, [job('Tests 1/1')], () => seen);

        return { verdict: seen.length === 0 ? 'passed' : verdict, line: at };
      },
      () => () => true,
    );

    assert.equal(merges[halved.bad], 'm2');
    const covers = boundaryFiles(seenAt, merges, halved.bad, 'm4');
    assert.deepEqual(covers, [a]);

    // The next run fails both: only b is uncovered, so its check is b's.
    const covered = coveredFiles([record(4, [a, b], { files: covers, verdict: 'failed' }), record(10, [a, b])], []);
    assert.deepEqual([...covered], [a]);
    assert.deepEqual(checkOf([job('Tests 2/14')], () => [a, b].filter((file) => !covered.has(file)))?.files, [b]);
  });

  it('covers nothing from a bisect an error cut short, so the next run bisects it again', () => {
    const stopped = record(1, [a], { files: [a], verdict: 'failed' }, false);
    const next = record(7, [a]);

    assert.deepEqual([...coveredFiles([stopped, next], [])], []);
    const done = record(8, [a], { files: [a], verdict: 'failed' }, true);
    assert.deepEqual([...coveredFiles([stopped, next, done], [])], [a]);
  });

  it('covers nothing a run by hand found passing, or never read', () => {
    const records = [record(1, [a], { files: [a], verdict: 'passed' }), record(2, [z], { files: [z], verdict: 'unread' })];

    assert.deepEqual([...coveredFiles(records, [])], []);
  });

  it('refuses a listing GitHub gave short, or one near its 1,000 runs', () => {
    const runs = [1, 2, 3];

    assert.deepEqual(wholeListing({ totalCount: 3, runs }, 'ci.yml on 2026-01-10'), runs);
    assert.throws(() => wholeListing({ totalCount: 5, runs }, 'ci.yml on 2026-01-10'), /GitHub listed 3 of the 5 runs/);
    assert.throws(() => wholeListing({ totalCount: 1203, runs }, 'ci.yml on 2026-01-10'), /GitHub listed 3 of the 1203 runs of ci\.yml on 2026-01-10/);
    assert.throws(
      () => wholeListing({ totalCount: listingLimit, runs: Array.from({ length: listingLimit }) }, 'ci.yml'),
      /this month's spend can't be read whole/,
    );
  });

  it("names its runs so this month's spend finds them", () => {
    assert.equal(controllerTitle('42'), "Bisect main's run 42");
    assert.ok(`CI by hand on abc, tests under ${a}${byHandTag}`.endsWith(byHandTag));
    assert.equal(monthStart(new Date('2026-01-20T12:00:00Z')).toISOString(), '2026-01-01T00:00:00.000Z');
  });
});

describe("a run's bill", () => {
  const now = Date.parse('2026-01-10T12:00:00Z');
  const limits = { jobMinutes: 30, runMinimum: 40 };
  const ran = (started: string | null, completed: string | null, runner = 'blacksmith-2vcpu-ubuntu-2404', conclusion: string | null = 'success'): Job => ({
    id: 1,
    name: 'Tests 1/1',
    conclusion,
    started_at: started === null ? null : `2026-01-10T${started}Z`,
    completed_at: completed === null ? null : `2026-01-10T${completed}Z`,
    labels: [runner],
  });

  it("bills each ended job's started minutes times its runner's vCPUs", () => {
    const jobs = [
      ran('11:00:00', '11:00:48', 'blacksmith-8vcpu-ubuntu-2404'),
      ran('11:00:00', '11:01:33'),
      ran(null, null, 'blacksmith-8vcpu-ubuntu-2404', 'skipped'),
    ];

    assert.equal(billOf(true, jobs, now, limits), 8 + 4);
  });

  it('counts a cancelled run to when it ended, and a running one at its timeout or more', () => {
    assert.equal(billOf(true, [ran('10:00:00', '11:20:00', undefined, 'cancelled')], now, limits), 160);

    // A controller still waiting holds its 120-minute timeout, or what it's run past it.
    const controller = { jobMinutes: 120, runMinimum: 40 };
    assert.equal(billOf(false, [ran('11:50:00', null, undefined, null)], now, controller), 240);
    assert.equal(billOf(false, [ran('09:00:00', null, undefined, null)], now, controller), 360);
    // A run by hand still queued, with no job yet, holds a run's estimate.
    assert.equal(billOf(false, [], now, limits), 40);
    assert.equal(billOf(false, [ran('11:58:00', null, 'blacksmith-8vcpu-ubuntu-2404', null)], now, limits), 240);
  });

  it("stops before the run by hand that would pass the month's allowance", () => {
    const budget = { ...bisectBudget, monthlyVcpuMinutes: 6000 };
    const { monthlyVcpuMinutes: allowed, nextRunVcpuMinutes: next } = budget;

    // With the allowance left at its default of 0, nothing runs by hand.
    assert.equal(mayRun(0, { ...bisectBudget, monthlyVcpuMinutes: 0 }), false);
    assert.equal(mayRun(0, budget), true);
    assert.equal(mayRun(allowed - next, budget), true);
    assert.equal(mayRun(allowed - next + 1, budget), false);

    // A controller cancelled after 80 minutes and its child still queued are counted too.
    const others = allowed - next - 100;
    const cancelled = billOf(true, [ran('10:00:00', '11:20:00', undefined, 'cancelled')], 0, { jobMinutes: 120, runMinimum: next });
    const child = billOf(false, [], 0, { jobMinutes: 30, runMinimum: next });
    assert.equal(cancelled + child, 200);
    assert.equal(mayRun(others, budget), true);
    assert.equal(mayRun(others + cancelled + child, budget), false);
  });
});
