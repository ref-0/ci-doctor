/**
 * ci-health.test.ts: the health report's rules (two observations, the shard minute, the spend
 * ceiling), the flake close counting, the retries, and disclosing what GitHub didn't answer.
 *
 * Runs: `node --test scripts/budgets/`. No network: GitHub is faked.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { occurred, type Marker } from '../flakes/flake-issues.ts';
import { recordLine } from '../flakes/records.ts';
import { backoff, healthOf, limits, read, reader, type DayRun, type GhApi, type Job } from './ci-health.ts';
import { storedZip } from './zip.ts';

const start = Date.parse('2026-11-05T10:00:00Z');

const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();

/** A job of the first attempt that ran from `from` to `to` seconds after the run's creation. */
const job = (name: string, from: number, to: number, runner = 'blacksmith-2vcpu-ubuntu-2404'): Job => ({
  id: 0,
  name,
  conclusion: 'success',
  created_at: at(from),
  started_at: at(from),
  completed_at: at(to),
  labels: [runner],
  run_attempt: 1,
});

let ids = 0;

const runOf = (rest: Partial<DayRun['run']>): DayRun['run'] => ({
  id: ++ids,
  path: '.github/workflows/ci.yml',
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
  created_at: at(0),
  run_attempt: 1,
  display_title: 'A pull request',
  html_url: `https://github.com/<org>/<repo>/actions/runs/${String(ids)}`,
  ...rest,
});

/** A pull request's run of CI, full or small, whose plan took `plan` s and whose result came at `end`. */
const pullRequest = (full: boolean, end: number, plan = 10, extra: ReadonlyArray<Job> = []): DayRun => ({
  run: runOf({}),
  jobs: [job('Plan', 2, 2 + plan), ...extra, job('CI result', end - 6, end)],
  full,
});

const held = {
  ...limits,
  budgets: [
    { workflow: 'ci.yml', job: 'plan', why: "The fixture's.", legs: [{ runner: 'blacksmith-2vcpu-ubuntu-2404', seconds: 20 }] },
  ],
};

const day = (runs: ReadonlyArray<DayRun>, rest: Partial<Parameters<typeof healthOf>[0]> = {}) => ({
  since: at(-86_400),
  runs,
  slowFiles: [],
  unread: [],
  calls: 0,
  ...rest,
});

const planRecord = {
  kind: 'plan',
  event: 'pull_request',
  pr: 1,
  sha: 'abc',
  base: null,
  changed: ['src/changed.ts'],
  packages: null,
  sandbox: [],
} as const;

describe("CI's health", () => {
  it('ranks PR plans by selected tests per changed file and shows the top reasons', () => {
    const broad = pullRequest(true, 100);
    const largeDiff = pullRequest(false, 100);
    const legacy = pullRequest(true, 100);
    const emptyDiff = pullRequest(true, 100);
    const noTests = pullRequest(false, 100);
    const testSelection = {
      'src/a.test.ts': 'fallback-everything',
      'src/b.test.ts': 'fallback-everything',
      'src/c.test.ts': 'coverage-declaration',
    };
    const { markdown } = healthOf(day([
      { ...largeDiff, plan: {
        ...planRecord,
        changed: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        test_selection: { ...testSelection, 'src/d.test.ts': 'edited' },
      } },
      { ...legacy, plan: planRecord },
      { ...broad, plan: { ...planRecord, test_selection: testSelection } },
      { ...emptyDiff, plan: { ...planRecord, changed: [], test_selection: testSelection } },
      { ...noTests, plan: { ...planRecord, test_selection: {} } },
    ]), held);

    const rows = markdown.split('### Test selection\n')[1]?.split('\n### ')[0]?.split('\n')
      .filter((line) => line.startsWith('| ['));
    assert.deepEqual(rows, [
      `| [${broad.run.id}](${broad.run.html_url}) | 1 | 3 | 3.00 | fallback-everything (2), coverage-declaration (1) |`,
      `| [${largeDiff.run.id}](${largeDiff.run.html_url}) | 3 | 4 | 1.33 | fallback-everything (2), coverage-declaration (1), edited (1) |`,
    ]);
  });

  it('reports nearest-rank queue times per label using each job attempt and links the longest waits', () => {
    const run = runOf({ run_attempt: 2 });
    const jobs = [
      { ...job('Fast', 20, 60, 'runner-a'), created_at: at(20) },
      { ...job('Middle', 30, 60, 'runner-a'), created_at: at(27) },
      { ...job('Slow', 90, 120, 'runner-a'), created_at: at(75), run_attempt: 2 },
      { ...job('Other', 20, 60, 'runner-b'), created_at: at(14) },
      { ...job('Skipped', 80, 90, 'runner-a'), created_at: at(0), conclusion: 'skipped' },
      { ...job('Missing', 80, 90, 'runner-a'), created_at: null },
      { ...job('Invalid', 25, 30, 'runner-b'), created_at: at(26) },
      { ...job('Never started', 90, 120, 'runner-a'), started_at: null, conclusion: 'cancelled' },
    ];
    const { markdown } = healthOf(day([{ run, jobs }]), held);
    const link = `[${run.id}](${run.html_url})`;

    assert.ok(markdown.includes(`| runner-a | 3 | 3 s | 15 s | 15 s in ${link} (Slow, attempt 2), 3 s in ${link} (Middle, attempt 1), 0 s in ${link} (Fast, attempt 1) |`));
    assert.ok(markdown.includes(`| runner-b | 1 | 6 s | 6 s | 6 s in ${link} (Other, attempt 1) |`));
    assert.ok(markdown.includes('Jobs without usable queue timestamps: 3.'));
  });

  it('is over where a p95 and two runs pass a limit, a file passes 90 s or the spend its ceiling', () => {
    const { over } = healthOf(
      day(
        [
          // One full run past 300 s isn't enough.
          pullRequest(true, 200),
          pullRequest(true, 250),
          pullRequest(true, 400),
          // Two small runs past 180 s are.
          pullRequest(false, 100),
          pullRequest(false, 200, 30),
          // A 61 s job on 8 vCPU bills two minutes of 8, $0.032, beside each run's two jobs of
          // one minute on 2 vCPU, $0.004 each: $0.08 a day, $2.44 over a month at list price.
          pullRequest(false, 210, 30, [job('Tests 1/1', 20, 81, 'blacksmith-8vcpu-ubuntu-2404')]),
        ],
        {
          slowFiles: [
            { path: 'src/slow.test.ts', seconds: 95, where: 'in a sweep' },
            { path: 'src/quick.test.ts', seconds: 60, where: 'in a sweep' },
          ],
        },
      ),
      { ...held, ceiling: 0.5 },
    );

    // Job budgets match jobs by the names the repo's workflows give them, so with no workflows
    // beside this file, no job is held to `plan`'s budget here; ci-budgets.test.ts covers names.
    assert.deepEqual(
      over,
      ["small pull request runs' p95 is 210 s, past 180 s", 'src/slow.test.ts took 95 s, past 90 s', "the month's spend projects to $2.44, past its $0.50 ceiling"],
    );
  });

  it("is over when the test shards' p95 nears the minute each would bill next", () => {
    const shards = (...times: ReadonlyArray<number>) =>
      times.map((time, index) => job(`Tests ${String(index + 1)}/${String(times.length)}`, 20, 20 + time, 'blacksmith-8vcpu-ubuntu-2404'));
    const { over } = healthOf(
      day([
        pullRequest(true, 200, 10, shards(112, 113)),
        pullRequest(true, 200, 10, shards(100, 100)),
        // One run of one shard isn't a run of shards.
        pullRequest(false, 150, 10, shards(119)),
      ]),
      held,
    );

    assert.deepEqual(over, ["test shards' p95 is 113 s, past 110 s, near the 120 s where each bills another minute"]);
  });

  it('is under when one run of each passes its limit, and says when no ceiling is set', () => {
    const { over, markdown } = healthOf(day([pullRequest(true, 400, 30), pullRequest(true, 200), pullRequest(false, 300)]), {
      ...held,
      ceiling: undefined,
    });

    assert.deepEqual(over, []);
    assert.ok(markdown.includes('Everything is under its budget.'));
    assert.ok(markdown.includes('no ceiling (set `spendCeiling`'));
  });

  it('counts main sweep failures on their first attempt and after a rerun', () => {
    const mainRun = (title: string, first: string, last = first): DayRun => ({
      run: runOf({ event: 'workflow_dispatch', conclusion: last, run_attempt: first === last ? 1 : 2, display_title: title }),
      jobs: [{ ...job('Tests 1/2', 20, 80), conclusion: first }, ...(first === last ? [] : [{ ...job('Tests 1/2', 200, 260), run_attempt: 2 }])],
    });
    const { markdown } = healthOf(
      day([mainRun('CI on main, daily', 'failure', 'success'), mainRun('CI on main, daily', 'failure'), mainRun('CI by hand on main', 'failure')]),
      held,
    );
    const row = markdown.split('\n').find((line) => line.startsWith('| The sweep '));

    assert.deepEqual(row?.split(' | ').slice(0, 4), ['| The sweep', '2', '2', '1']);
  });
});

describe("the flakes' issues", () => {
  const file = 'src/merge/handovers.test.ts';
  const test = 'a handover > finishes one cut short';
  const flake = { kind: 'test', file, test, excerpt: '', how: '' } as const;
  // Last seen 7 days before the day's end, with 45 runs counted since.
  const seen = { ...occurred(undefined, flake, new Date(start - 7 * 86_400_000)), clean: 45 };

  const ciRun = (seconds: number, { event = 'pull_request', title = 'A pull request', ...rest }: Partial<DayRun> & { event?: string; title?: string }): DayRun => ({
    jobs: [job('Tests 1/2', 20, 80), job('Tests 2/2', 20, 80)],
    ...rest,
    run: runOf({ event, created_at: at(seconds), display_title: title }),
  });

  const plan = (packages: ReadonlyArray<string> | null, sandbox: ReadonlyArray<string> = []) => ({
    kind: 'plan' as const,
    event: 'pull_request',
    pr: 1,
    sha: 'abc',
    base: null,
    changed: [],
    packages,
    sandbox,
  });

  const records = (times = 1, recurred: ReadonlyArray<string> = [], path = file) => ({
    passed: new Map([[path, times]]),
    recurred: new Set(recurred),
  });

  const sweep = (seconds: number, recurred: ReadonlyArray<string> = []) =>
    ciRun(seconds, { event: 'schedule', title: 'CI on main, daily', records: records(1, recurred) });

  const updates = (runs: ReadonlyArray<DayRun>, marker: Marker = seen) =>
    healthOf(day(runs, { flakes: [{ number: 7, title: `Flaky: ${file} › ${test}`, marker }] }), held).flakes;

  it('counts the runs since its last occurrence that ran its file without it, and closes at 50', () => {
    const [update] = updates([
      // Sweeps whose records say the file passed, with no retry of the test: count.
      ...[-3600, -3000, -2900].map((seconds) => sweep(seconds)),
      // Pull requests whose records say the file ran and passed, in two attempts or one: count once.
      ciRun(-2800, { records: records(2) }),
      ciRun(-2700, { records: records() }),
      // Pull requests that chose the file without records, which may have replayed a cached pass: don't.
      ciRun(-2600, { plan: plan(['src/']) }),
      ciRun(-2500, { plan: plan(null) }),
      // A sweep that retried the test: doesn't.
      sweep(-2300, [`${file} › ${test}`]),
      // A run by hand with no records, and a pull request's run with no plan read: don't.
      ciRun(-2200, { event: 'workflow_dispatch', title: 'CI by hand on main', plan: plan(null) }),
      ciRun(-2100, {}),
    ]);

    assert.equal(update?.added, 5);
    assert.equal(update?.closes, true);
    assert.equal(update?.marker.clean, 50);
  });

  it('counts each repetition of a run by hand at main, and none of one that failed or ran elsewhere', () => {
    const byHand = (title: string, recurred: ReadonlyArray<string> = []) =>
      ciRun(-3600, { event: 'workflow_dispatch', title, records: records(50, recurred) });
    const [update] = updates([
      byHand(`CI by hand on main, tests under ${file}, 50 times`),
      byHand(`CI by hand on fix/x, tests under ${file}, 50 times`),
      byHand(`CI by hand on main, tests under ${file}, 50 times`, [`${file} › ${test}`]),
    ]);

    assert.equal(update?.added, 50);
    assert.equal(update?.marker.clean, 95);
  });

  it("doesn't close one seen in the last 7 days, however many runs passed", () => {
    const recent = { ...occurred(undefined, flake, new Date(start - 86_400_000)), clean: 400 };
    const [update] = updates([sweep(0)], recent);

    assert.equal(update?.closes, false);
    assert.equal(update?.marker.clean, 401);
  });
});

describe('reading GitHub', () => {
  /** A `gh api` that fails as each of `failures` says, in turn, and then answers `ok`. */
  const flaky = (failures: ReadonlyArray<string>) => {
    const asked: Array<ReadonlyArray<string>> = [];
    const gh: GhApi = async (args) => {
      asked.push(args);
      const failure = failures[asked.length - 1];
      if (failure !== undefined) throw new Error(`Command failed: gh api ${args.join(' ')}\n${failure}`);

      return Buffer.from('ok');
    };

    return { gh, asked };
  };

  const waited = () => {
    const waits: Array<number> = [];

    return { waits, pause: async (ms: number) => void waits.push(ms) };
  };

  it('tries a call again after a 502, and counts both tries against the hour', async () => {
    const { gh, asked } = flaky(['gh: Server Error (HTTP 502)']);
    const { waits, pause } = waited();
    const { api, calls, left } = reader(10, gh, pause);

    assert.equal(await api(['repos/o/r/actions/runs/1/jobs']), 'ok');
    assert.deepEqual({ asked: asked.length, calls: calls(), left: left(), waits }, { asked: 2, calls: 2, left: 8, waits: [2_000] });
  });

  it('gives up after the last wait', async () => {
    const { gh, asked } = flaky(Array.from({ length: backoff.length + 1 }, () => 'gh: Server Error (HTTP 503)'));
    const { waits, pause } = waited();

    await assert.rejects(reader(10, gh, pause).api(['rate_limit']), /HTTP 503/);
    assert.deepEqual({ asked: asked.length, waits }, { asked: backoff.length + 1, waits: backoff });
  });

  it("doesn't try again what a moment won't cure, or a new comment, which could double", async () => {
    const { gh: missing, asked: askedMissing } = flaky(['gh: Not Found (HTTP 404)']);
    await assert.rejects(reader(10, missing, waited().pause).api(['repos/x/y']), /404/);

    const { gh: commenting, asked: askedComment } = flaky(['gh: Server Error (HTTP 502)']);
    await assert.rejects(reader(10, commenting, waited().pause).api(['-X', 'POST', 'repos/x/y/issues/1/comments']), /502/);

    assert.deepEqual([askedMissing.length, askedComment.length], [1, 1]);
  });

  it("says what GitHub didn't answer for apart from what the rate limit left out", () => {
    const { markdown } = healthOf(day([pullRequest(true, 200)], { unanswered: ["run 7's jobs"] }), limits);

    assert.ok(markdown.includes("Not read, as GitHub didn't answer: run 7's jobs."));
    assert.ok(!markdown.includes('rate limit'));
  });

  const listedRun = (id: number, rest: Record<string, unknown> = {}) =>
    JSON.stringify({ ...runOf({ id, event: 'push', display_title: 'Merge' }), ...rest });

  it('reads the first plan and the job creation time through the API', async () => {
    process.env['GITHUB_REPOSITORY'] = 'o/r';
    const record = { ...planRecord, test_selection: { 'src/check.test.ts': 'edited' } };
    const gh: GhApi = async (args) => {
      const path = args.find((arg) => !arg.startsWith('-')) ?? '';
      if (path === 'rate_limit') return Buffer.from('5000\n');

      if (path.startsWith('repos/o/r/actions/runs?')) return Buffer.from(listedRun(1, { event: 'pull_request' }));

      if (path.includes('/runs/1/jobs')) {
        assert.match(args.at(-1) ?? '', /\bcreated_at\b/);
        return Buffer.from(JSON.stringify({ ...job('Plan', 5, 10), id: 11, created_at: at(2) }));
      }

      if (path.endsWith('/jobs/11/logs')) return Buffer.from(recordLine(record));

      return Buffer.from('');
    };
    const { day: report } = await read(new Date(start), undefined, gh, async () => {});
    assert.deepEqual(report.runs[0]?.plan, record);
    assert.equal(report.runs[0]?.jobs[0]?.created_at, at(2));
  });

  it("leaves out a run whose jobs GitHub never answers for, and reads the day's others", async () => {
    process.env['GITHUB_REPOSITORY'] = 'o/r';
    const gh: GhApi = async (args) => {
      const path = args.find((arg) => !arg.startsWith('-')) ?? '';
      if (path === 'rate_limit') return Buffer.from('5000\n');

      if (path.startsWith('repos/o/r/actions/runs?')) return Buffer.from(`${listedRun(1)}\n${listedRun(2)}\n`);

      if (path.includes('/runs/1/jobs')) throw new Error('gh: Server Error (HTTP 502)');

      if (path.includes('/runs/2/jobs')) return Buffer.from(`${JSON.stringify(job('Plan', 0, 10))}\n`);

      return Buffer.from('');
    };

    const { day: read1 } = await read(new Date(start), undefined, gh, async () => {});

    assert.deepEqual(
      { runs: read1.runs.map((each) => each.run.id), unanswered: read1.unanswered, unread: read1.unread },
      { runs: [2], unanswered: ["run 1's jobs"], unread: [] },
    );
  });

  it("reads a re-run sweep's records from the attempt its tests ran in, not only its last", async () => {
    process.env['GITHUB_REPOSITORY'] = 'o/r';
    const file = 'src/client/call.test.ts';
    const tests = recordLine({ kind: 'tests', files: [[file, 'passed', 9_947]], failed: [], flaky: [], errors: 0 });
    const logs = new Map([
      [1, storedZip([['4_Tests 7_16.txt', `2026-11-07T12:20:00Z ${tests}`]])],
      [2, storedZip([['0_CI result.txt', 'passed']])],
    ]);
    const asked: Array<string> = [];
    const gh: GhApi = async (args) => {
      const path = args.find((arg) => !arg.startsWith('-')) ?? '';
      asked.push(path);

      if (path === 'rate_limit') return Buffer.from('5000\n');

      if (path.startsWith('repos/o/r/actions/runs?'))
        return Buffer.from(`${listedRun(3, { event: 'schedule', display_title: 'CI on main, daily', run_attempt: 2 })}\n`);

      if (path.includes('/runs/3/jobs'))
        return Buffer.from(
          [job('Tests 7/16', 20, 80), { ...job('CI result', 90, 95), run_attempt: 2 }].map((each) => `${JSON.stringify(each)}\n`).join(''),
        );

      const attempt = /\/attempts\/(\d+)\/logs$/.exec(path)?.[1];

      return attempt === undefined ? Buffer.from('') : (logs.get(Number(attempt)) ?? Buffer.from(''));
    };

    const { day: read3 } = await read(new Date(start), undefined, gh, async () => {});

    assert.deepEqual(
      asked.filter((path) => path.endsWith('/logs')),
      ['repos/o/r/actions/runs/3/attempts/1/logs'],
    );
    assert.deepEqual(read3.runs[0]?.records, { passed: new Map([[file, 1]]), recurred: new Set() });
    assert.deepEqual(read3.slowFiles.map((each) => [each.path, each.seconds]), [[file, 9.947]]);
  });
});
