#!/usr/bin/env node
/**
 * sweep-bisect.ts: what to do with a failed run of main's sweep, or of a slice of main's tests that
 * runs between sweeps: rerun first, then bisect the merges since the last pass, with a budget.
 *
 *     node scripts/sweeps/sweep-bisect.ts <run id>
 *
 * Runs: in a small controller workflow (`templates/github/workflows/sweep-bisect.yml`) that the CI
 * workflow's report job dispatches on the failed run's first attempt, with `GH_TOKEN` (`actions: write`,
 * `issues: write`), a full-history checkout of main, and `run-name` set to `controllerTitle(run)`.
 * Configure: the CONFIG block below: workflow files, run titles, the job names and the manual
 * inputs a run by hand takes, and the monthly vCPU-minute allowance (0 until you set it).
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * The rules (docs/pages/05-tiers-what-runs-where.md):
 * - Rerun before bisecting. A sweep's failed jobs run again at the same commit. When they pass,
 *   the failure was a flake: this says so on the one "main failed" issue and bisects nothing.
 *   A slice's failed shards aren't rerun, as a failure across all its shards would rerun them all:
 *   its failed test files, at most four, run by hand once at the run's own commit instead, and a
 *   pass there is the flake. Each flaky test's own issue comes from CI's records, not from here.
 * - Bisect. When they fail again, it takes the first failed check it can run alone (`checkOf`) and
 *   runs it by hand at the merges since the run's base (the last passing sweep, or for a slice the
 *   newest commit a slice or sweep passed), halving each time, at most `maxSteps` runs: enough for
 *   64 merges. It names the first merge it fails at, its pull request, branch and author, on the
 *   issue. A check it can't repeat alone, such as property tests seeded from the run's ID, gets no
 *   bisect, and says so. When no run by hand fails, it runs the check at the run's own commit too,
 *   and names no merge unless that fails: a run by hand can check less than the run did.
 * - Recorded verdicts. A slice's bisect keeps one comment on the issue with its record in a marker:
 *   every file the run saw fail and, once it ran some by hand, those files and their verdict. Only
 *   the workflow bot's records count, and only files a finished bisect saw fail by hand cover
 *   anything (`coveredFiles`), until a later slice passes or no longer fails them. A run whose
 *   failed files are all covered is left alone: a regression stays on main until its fix merges,
 *   and each slice would otherwise pay to rediscover it.
 * - Bounded spend. The month's spend comes from GitHub, not the comments: every controller and run
 *   by hand of a bisect, found by their run names, cancelled and in-flight ones too, billed by
 *   `billOf`, read a day at a time so no listing nears GitHub's 1,000-run cap, and refused
 *   (`wholeListing`) when a listing comes back short. A job not yet ended holds its vCPUs times its
 *   timeout, so in-flight work is reserved. No run by hand starts that would pass the allowance.
 *
 * No dependencies: Node 24, `gh` and `git`.
 */
import { execFileSync } from 'node:child_process';
import { argv, env, exit } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { runnerOf } from '../budgets/ci-jobs.ts';
import { gh, issueNumberOf, repo, say } from '../budgets/github.ts';
import { recordsIn } from '../flakes/records.ts';

// ---------------------------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------------------------

/** The CI workflow a run by hand starts, and the controller workflow that runs this. */
const ciWorkflow = 'ci.yml';

const controllerWorkflow = 'sweep-bisect.yml';

/** The one issue for a red main. The CI workflow's report job opens it; a passing sweep closes it. */
const issueTitle = 'CI on main failed';

/** Run names (`run-name:` in the CI workflow). */
const isSweepTitle = (title: string) => title.startsWith('CI on main, ');

/** A slice of main's tests between sweeps, such as every 6 hours. Use `undefined` if you have none. */
const sliceTitle: string | undefined = 'Server tests on main';

/**
 * A run by hand's name must start with `CI by hand on <sha>` so `start` can find it, and end with
 * `byHandTag` when a bisect starts it, so the month's spend counts it.
 */
const handRunPrefix = (sha: string) => `CI by hand on ${sha}`;

export const byHandTag = ', for a bisect';

/** The controller's run name, which the month's spend finds it by. */
export const controllerTitle = (run: string) => `Bisect main's run ${run}`;

/**
 * What a run by hand can check alone, and the inputs it takes (`workflow_dispatch` inputs of the
 * CI workflow). `ref` is always passed, as the commit to check. These match
 * `templates/github/workflows/ci.yml`'s job names and inputs: every input named here must be one
 * that workflow declares, or GitHub refuses the dispatch.
 */
const checks = {
  /** Test shards: the failed files, at most four, through `testPaths`. */
  shard: /^Tests \d+\/\d+$/,
  testPaths: 'test_paths',
  /**
   * Inputs that turn off what a test-only run doesn't need. The template's `test_paths` already
   * skips static, pack and Rust, so none. Add yours, such as `heavy: 'false'`, only when your CI
   * workflow declares them.
   */
  testOnly: {} as Readonly<Record<string, string>>,
  /**
   * Jobs that run one heavy file each (container tests), through `heavyFile`. The template has no
   * such job or input, so this never matches there; declare `heavy_file` when you add them.
   */
  heavy: /^Heavy /,
  heavyFile: 'heavy_file',
  isHeavyFile: (path: string) => /\.sandbox\.test\.[cm]?[jt]sx?$/.test(path),
  /** Jobs a run by hand with `packOnly` runs: packaging and what tests the package. */
  packed: /^(Pack|Proof)$/,
  packOnly: { pack_only: 'true' } as Readonly<Record<string, string>>,
  /** Static jobs, which every run by hand runs, checked beside one quick test file. */
  statics: /^(Build and generated files|Format, lint and types)$/,
  quickTests: '<quick-test-file>',
};

/** The input that tags a run by hand as a bisect's (so its run name ends with `byHandTag`). */
const bisectInput = { bisect: 'true' } as Readonly<Record<string, string>>;

/**
 * What a month of bisects may spend, in vCPU-minutes, and how this counts it. `monthlyVcpuMinutes`
 * is `<bisect-vcpu-minute-allowance>`: 0 starts no run by hand until you set it. `nextRunVcpuMinutes`
 * is your measured cost of one run by hand (plan, static jobs and the tests it selects).
 */
export const bisectBudget = {
  monthlyVcpuMinutes: 0,
  nextRunVcpuMinutes: 40,
  /** The longest a run by hand's jobs take, which an unended job holds. */
  jobMinutes: 30,
  /** The controller's timeout, which an unended controller holds. */
  controllerMinutes: 120,
};

/** The login a workflow's `GITHUB_TOKEN` posts as: the only author whose records count. */
export const botLogin = 'github-actions[bot]';

// ---------------------------------------------------------------------------------------------

/** The most runs by hand one bisect starts: enough to split 64 merges to one. */
export const maxSteps = 6;

/** What a failed run of main's is: what the issue calls it, and the runs whose pass is its base. */
export interface Tier {
  /** A slice, whose bisect runs the failed files by hand rather than rerun them. */
  readonly slice: boolean;
  readonly what: string;
  readonly since: string;
  readonly none: string;
  readonly passes: (title: string) => boolean;
}

/** The tier of the run named `title`, or undefined for any other run. */
export const tierOf = (title: string): Tier | undefined => {
  if (sliceTitle !== undefined && title === sliceTitle)
    return {
      slice: true,
      what: `Main's run "${sliceTitle}"`,
      since: 'since it or a sweep last passed',
      none: 'no run passed it before',
      passes: (each) => each === sliceTitle || isSweepTitle(each),
    };

  if (isSweepTitle(title))
    return {
      slice: false,
      what: "Main's sweep",
      since: 'since the last passing sweep',
      none: 'no sweep passed before it',
      passes: isSweepTitle,
    };

  return undefined;
};

/** A job of a run, as GitHub lists it. */
export interface Job {
  readonly id: number;
  readonly name: string;
  readonly conclusion: string | null;
  readonly started_at?: string | null;
  readonly completed_at?: string | null;
  readonly labels?: ReadonlyArray<string>;
}

/** One failed check, as a run by hand runs it alone, and the jobs whose results say if it passed. */
export interface Check {
  readonly name: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly jobs: RegExp;
  /** The test files it runs, for a check of tests. */
  readonly files?: ReadonlyArray<string>;
}

/**
 * The first failed job's check, as a run by hand runs it alone: a shard's failed test files, at
 * most four; a heavy job's first failed file; packaging with `packOnly`; a static job beside one
 * quick test. `failedFiles` reads a job's failed test files from its log. Undefined when no failed
 * job is one of these.
 */
export const checkOf = (failed: ReadonlyArray<Job>, failedFiles: (job: Job) => ReadonlyArray<string>): Check | undefined => {
  for (const job of failed) {
    if (checks.shard.test(job.name)) {
      const files = [...new Set(failedFiles(job))].slice(0, 4);
      if (files.length === 0) continue;

      return { name: `the tests in ${files.join(', ')}`, inputs: { ...checks.testOnly, [checks.testPaths]: files.join(' ') }, jobs: checks.shard, files };
    }

    if (checks.heavy.test(job.name)) {
      const [file] = failedFiles(job).filter(checks.isHeavyFile);
      if (file === undefined) continue;

      return { name: `the heavy file ${file}`, inputs: { [checks.heavyFile]: file }, jobs: checks.heavy, files: [file] };
    }

    if (checks.packed.test(job.name)) return { name: `"${job.name}"`, inputs: checks.packOnly, jobs: checks.packed };

    if (checks.statics.test(job.name)) {
      return {
        name: `"${job.name}"`,
        inputs: { ...checks.testOnly, [checks.testPaths]: checks.quickTests },
        jobs: new RegExp(`^${job.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      };
    }
  }

  return undefined;
};

/**
 * `check` at a commit where only the files `exists` says are there: a check of tests runs those it
 * finds, and is undefined, so passes there, when it finds none, as the merge that adds a failing
 * file comes after.
 */
export const checkAt = (check: Check, exists: (path: string) => boolean): Check | undefined => {
  if (check.files === undefined) return check;

  const files = check.files.filter(exists);
  if (files.length === 0) return undefined;

  return checks.heavyFile in check.inputs ? check : { ...check, inputs: { ...check.inputs, [checks.testPaths]: files.join(' ') }, files };
};

/** A run by hand's verdict on a check. */
export type Verdict = 'passed' | 'failed' | 'unread';

/**
 * Whether a run by hand passed `check`: `passed`, `failed`, or `unread` when it didn't run it. A
 * check of tests fails only where a failed job's records name one of its files, so a job that
 * failed in its setup, or was cancelled or timed out first, is unread, not the check's failure.
 */
export const verdictOf = (check: Check, jobs: ReadonlyArray<Job>, failedFiles: (job: Job) => ReadonlyArray<string>): Verdict => {
  const ran = jobs.filter((job) => check.jobs.test(job.name) && job.conclusion !== 'skipped');
  if (ran.length === 0 || ran.some((job) => job.conclusion === null)) return 'unread';

  const failed = ran.filter((job) => job.conclusion !== 'success');
  if (failed.length === 0) return 'passed';

  const files = check.files;
  if (files === undefined) return 'failed';

  return failed.some((job) => failedFiles(job).some((file) => files.includes(file))) ? 'failed' : 'unread';
};

/**
 * The next merge to run, by its index in `merges`, oldest first, when the last passing index is
 * `good` (-1 for the base's own commit, the last pass) and the first failing is `bad`. Undefined
 * once they're next to each other.
 */
export const nextIndex = (good: number, bad: number) => (bad - good > 1 ? Math.floor((good + bad) / 2) : undefined);

/** A pull request a commit belongs to, as GitHub's commit-to-pull-request listing gives it. */
export interface Pull {
  readonly number: number;
  readonly merge_commit_sha: string | null;
  readonly head: { readonly ref: string };
  readonly user: { readonly login: string };
}

/**
 * The pull request that merged as `commit`, by merge button or squash, from the pull requests
 * GitHub lists for it: a branch's own commits list theirs too, which didn't merge as it.
 */
export const pullIn = (pulls: ReadonlyArray<Pull>, commit: string) => {
  const pull = pulls.find((each) => each.merge_commit_sha === commit);

  return pull === undefined ? undefined : { number: pull.number, branch: pull.head.ref, author: pull.user.login };
};

/**
 * What a slice's bisect keeps in its comment's marker: the failed run, its commit and when it was
 * made, every file it saw fail, and, once a run by hand ran, the files it ran and their verdict.
 * Only `probed` is evidence that a file was looked at.
 */
export interface BisectRecord {
  readonly run: string;
  readonly sha: string;
  readonly at: string;
  readonly failed: ReadonlyArray<string>;
  readonly probed?: { readonly files: ReadonlyArray<string>; readonly verdict: Verdict };
  readonly finished: boolean;
}

const isTexts = (value: unknown): value is ReadonlyArray<string> => Array.isArray(value) && value.every((each) => typeof each === 'string');

const decodeBisectRecord = (text: string): BisectRecord | undefined => {
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null;
    if (value === null || typeof value !== 'object') return undefined;

    const probed = value['probed'] as Record<string, unknown> | undefined;
    const ok =
      typeof value['run'] === 'string' &&
      typeof value['sha'] === 'string' &&
      typeof value['at'] === 'string' &&
      isTexts(value['failed']) &&
      typeof value['finished'] === 'boolean' &&
      (probed === undefined ||
        (typeof probed === 'object' && probed !== null && isTexts(probed['files']) && ['passed', 'failed', 'unread'].includes(String(probed['verdict']))));

    return ok ? (value as unknown as BisectRecord) : undefined;
  } catch {
    return undefined;
  }
};

const markerPattern = /<!-- ci-bisect (\{.*?\}) -->/g;

/** The marker a bisect keeps its record in, at the end of its comment. */
export const recordMarker = (record: BisectRecord) => `<!-- ci-bisect ${JSON.stringify(record)} -->`;

/** A comment on the issue, with its author's login. */
export interface Posted {
  readonly author: string;
  readonly body: string;
}

/**
 * Every bisect's record in `posted`, from comments the workflow's bot wrote alone. Anyone who can
 * read the repository can comment, so a reader's marker covers nothing.
 */
export const bisectRecordsIn = (posted: ReadonlyArray<Posted>) =>
  posted
    .filter((each) => each.author === botLogin)
    .flatMap(({ body }) =>
      [...body.matchAll(markerPattern)].flatMap((match) => {
        const record = decodeBisectRecord(match[1] ?? '');

        return record === undefined ? [] : [record];
      }),
    );

/**
 * The files an earlier run by hand found failing and that nothing since retired: each later record
 * saw the file fail again, and no slice passed after the record's run, `passes` being when each
 * passing one was made. A file a run saw fail but never ran by hand covers nothing, so a regression
 * that fails beside another still gets its own bisect.
 */
export const coveredFiles = (records: ReadonlyArray<BisectRecord>, passes: ReadonlyArray<string>) => {
  const covered = new Set<string>();

  for (const record of records) {
    if (!record.finished || record.probed?.verdict !== 'failed') continue;

    const at = Date.parse(record.at);
    if (passes.some((pass) => Date.parse(pass) > at)) continue;

    const since = records.filter((each) => Date.parse(each.at) > at);

    for (const file of record.probed.files) if (since.every((each) => each.failed.includes(file))) covered.add(file);
  }

  return covered;
};

/** The files of `check` that a failed job's records in `jobs` name: what a run by hand saw fail. */
export const failedOf = (check: Check, jobs: ReadonlyArray<Job>, failedFiles: (job: Job) => ReadonlyArray<string>) => {
  const files = check.files ?? [];

  return [
    ...new Set(
      jobs
        .filter((job) => check.jobs.test(job.name) && job.conclusion === 'failure')
        .flatMap(failedFiles)
        .filter((file) => files.includes(file)),
    ),
  ];
};

/**
 * The most runs one listing may hold and be trusted whole: GitHub's runs listing with `created`
 * returns at most 1,000, so one near that may have lost some.
 */
export const listingLimit = 900;

/** One day's runs of a workflow, as GitHub counts them and as its pages gave them. */
export interface Listing<A> {
  readonly totalCount: number;
  readonly runs: ReadonlyArray<A>;
}

/** A listing's runs, or a refusal when GitHub gave fewer than it counts, or nears its limit. */
export const wholeListing = <A>(listing: Listing<A>, what: string) => {
  if (listing.totalCount >= listingLimit || listing.runs.length < listing.totalCount)
    throw new Error(
      `GitHub listed ${String(listing.runs.length)} of the ${String(listing.totalCount)} runs of ${what}, so this month's spend can't be read whole, and no run by hand starts`,
    );

  return listing.runs;
};

/**
 * What a finished bisect covers: the files the run by hand at the failing end of what it found,
 * `merges[bad]` or the run's own commit `sha`, saw fail. A file that failed at the run's own commit
 * but not there broke at a later merge, so it stays uncovered for a bisect of its own.
 */
export const boundaryFiles = (seenAt: ReadonlyMap<string, ReadonlyArray<string>>, merges: ReadonlyArray<string>, bad: number, sha: string) =>
  seenAt.get(merges[bad] ?? sha) ?? [];

/** The first instant of `now`'s month, in UTC. */
export const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/**
 * The vCPU-minutes a bisect's run bills, as far as GitHub says at `now`: each ended job's started
 * minutes times its runner's vCPUs, and each job not ended at its runner's vCPUs (8 when it names
 * none) times its elapsed minutes or `jobMinutes`, its timeout, whichever is more. A run not ended
 * bills at least `runMinimum`, for the jobs it hasn't made yet. A cancelled run's jobs end when it
 * does, so they bill to then.
 */
export const billOf = (
  ended: boolean,
  jobs: ReadonlyArray<Job>,
  now: number,
  { jobMinutes, runMinimum }: { readonly jobMinutes: number; readonly runMinimum: number },
) => {
  const billed = jobs.reduce((sum, job) => {
    if (job.conclusion === 'skipped') return sum;

    const vcpus = runnerOf(job.labels?.[0] ?? '')?.vcpu ?? 8;
    const started = job.started_at == null ? now : Date.parse(job.started_at);
    if (job.completed_at == null) return sum + vcpus * Math.max(Math.ceil((now - started) / 60_000), jobMinutes);

    return sum + vcpus * Math.max(1, Math.ceil((Date.parse(job.completed_at) - started) / 60_000));
  }, 0);

  return ended ? billed : Math.max(billed, runMinimum);
};

/**
 * Whether one more run by hand fits the month's allowance: what the month's bisects billed or
 * hold, `spent`, and one more run at its estimate stay within it.
 */
export const mayRun = (spent: number, budget = bisectBudget) => spent + budget.nextRunVcpuMinutes <= budget.monthlyVcpuMinutes;

/**
 * Halves `merges` between the last pass, -1, and the first failure, the last merge, running
 * `check` at each midpoint through `probe`, which gives its verdict and the step's line, or
 * undefined when it may run no more. At most `maxSteps` runs; it stops at the first unread one.
 */
export const halve = async (
  check: Check,
  merges: ReadonlyArray<string>,
  probe: (check: Check, at: string) => Promise<{ verdict: Verdict; line: string } | undefined>,
  exists: (at: string) => (path: string) => boolean = holds,
) => {
  const steps: Array<string> = [];
  const verdicts: Array<Verdict> = [];
  let good = -1;
  let bad = merges.length - 1;
  let stopped = false;

  for (let index = nextIndex(good, bad); index !== undefined && steps.length < maxSteps; index = nextIndex(good, bad)) {
    const at = merges[index] ?? '';
    const there = checkAt(check, exists(at));
    let verdict: Verdict = 'passed';

    if (there === undefined) {
      steps.push(`- \`${at.slice(0, 8)}\`: passed, as it holds none of the files`);
    } else {
      const probed = await probe(there, at);

      if (probed === undefined) {
        stopped = true;
        break;
      }

      verdict = probed.verdict;
      verdicts.push(verdict);
      steps.push(probed.line);
    }

    if (verdict === 'unread') break;

    if (verdict === 'passed') good = index;
    else bad = index;
  }

  return { steps, verdicts, good, bad, stopped };
};

// ---------------------------------------------------------------------------------------------
// GitHub and git
// ---------------------------------------------------------------------------------------------

const api = (path: string, jq: string) => gh(['api', path, '--jq', jq]);

const lines = (text: string) => text.split('\n').filter((line) => line !== '');

/** Git, in the checkout the workflow made, which holds main's whole history. */
const git = (...args: ReadonlyArray<string>) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Whether `git` finds `path` at commit `at`. */
function holds(at: string) {
  return (path: string) => {
    try {
      git('cat-file', '-e', `${at}:${path}`);

      return true;
    } catch {
      return false;
    }
  };
}

/** A run's jobs, of one attempt or its latest. */
const jobsOf = (run: string, attempt?: number) =>
  JSON.parse(
    api(
      `repos/${repo()}/actions/runs/${run}${attempt === undefined ? '' : `/attempts/${String(attempt)}`}/jobs?per_page=100`,
      '[.jobs[] | {id, name, conclusion, started_at, completed_at, labels}]',
    ),
  ) as ReadonlyArray<Job>;

/** Waits for a run to end, its attempt `attempt` when given, and gives its conclusion. */
const ended = async (run: string, attempt?: number) => {
  for (let waited = 0; waited < 90; waited++) {
    const [status = '', conclusion = '', at = ''] = api(`repos/${repo()}/actions/runs/${run}`, '"\\(.status) \\(.conclusion) \\(.run_attempt)"').split(' ');
    if (status === 'completed' && (attempt === undefined || Number(at) >= attempt)) return conclusion;

    await sleep(60_000);
  }

  throw new Error(`run ${run} didn't end within 90 minutes`);
};

/** Starts `check` by hand at `sha`, and gives its run's ID once GitHub lists it. */
const start = async (check: Check, sha: string) => {
  const since = new Date(Date.now() - 60_000).toISOString();
  const inputs = Object.entries({ ...check.inputs, ref: sha }).flatMap(([key, value]) => ['-f', `${key}=${value}`]);
  gh(['workflow', 'run', ciWorkflow, '--repo', repo(), '--ref', 'main', ...inputs]);

  for (let tries = 0; tries < 10; tries++) {
    await sleep(15_000);

    const run = api(
      `repos/${repo()}/actions/workflows/${ciWorkflow}/runs?event=workflow_dispatch&created=%3E%3D${since}&per_page=50`,
      `[.workflow_runs[] | select(.display_title | startswith(${JSON.stringify(handRunPrefix(sha))})) | .id] | first // empty`,
    );
    if (run !== '') return run;
  }

  throw new Error(`no run by hand on ${sha} started`);
};

/** The issue's number: the open one, else the newest of that title, else a new one. */
const issue = () => {
  const found = api(
    `repos/${repo()}/issues?state=all&per_page=100`,
    `[.[] | select(.pull_request == null and .title == ${JSON.stringify(issueTitle)})] | sort_by(.state != "open") | .[0].number // empty`,
  );
  if (found !== '') return found;

  return issueNumberOf(gh(['issue', 'create', '--repo', repo(), '--title', issueTitle, '--body', "Main's sweep or a slice of its tests failed."]));
};

const runUrl = (run: string) => `https://github.com/${repo()}/actions/runs/${run}`;

const tell = (body: string) => {
  say(body);
  gh(['issue', 'comment', issue(), '--repo', repo(), '--body', body]);
};

/** The newest commit before `sha` that a run the tier builds on passed. */
const lastPassing = (tier: Tier, sha: string) => {
  const passed = api(
    `repos/${repo()}/actions/workflows/${ciWorkflow}/runs?branch=main&status=success&per_page=100`,
    '.workflow_runs[] | "\\(.head_sha) \\(.display_title)"',
  )
    .split('\n')
    .flatMap((line) => {
      const [commit = '', ...title] = line.split(' ');

      return tier.passes(title.join(' ')) ? [commit] : [];
    });

  return passed.find((commit) => {
    try {
      git('merge-base', '--is-ancestor', commit, sha);

      return commit !== sha;
    } catch {
      return false;
    }
  });
};

/** A job's failed test files, from CI's records in its log, which holds the terminal's colours. */
const failedFiles = (job: Job) =>
  recordsIn(gh(['api', `repos/${repo()}/actions/jobs/${String(job.id)}/logs`, '--allow-escape-sequences'])).flatMap((record) =>
    record.kind === 'tests' ? record.failed.map(([file]) => file) : [],
  );

/** What the halving found, in a sentence. */
const foundIn = (merges: ReadonlyArray<string>, base: string, sha: string, { steps, good, bad }: { steps: ReadonlyArray<string>; good: number; bad: number }) => {
  const first = merges[bad] ?? sha;
  if (nextIndex(good, bad) !== undefined)
    return `It stopped at ${String(steps.length)} runs with the break between \`${(merges[good] ?? base).slice(0, 8)}\` and \`${first.slice(0, 8)}\`.`;

  const pull = pullIn(JSON.parse(api(`repos/${repo()}/commits/${first}/pulls`, '.')) as ReadonlyArray<Pull>, first);

  return pull === undefined
    ? `It first fails at \`${first.slice(0, 8)}\`, which merged no pull request.`
    : `It first fails at #${String(pull.number)}'s merge, \`${first.slice(0, 8)}\`, from \`${pull.branch}\` by \`${pull.author}\`.`;
};

/** Runs `check` by hand at `at`, waits for it, and gives its verdict, its run and its jobs. */
const runByHand = async (check: Check, at: string) => {
  const tried = await start(check, at);
  await ended(tried);

  const jobs = jobsOf(tried);

  return { tried, jobs, verdict: verdictOf(check, jobs, failedFiles), failed: failedOf(check, jobs, failedFiles) };
};

const sweepBisect = async (run: string, sha: string, tier: Tier) => {
  gh(['run', 'rerun', run, '--failed', '--repo', repo()]);

  if ((await ended(run, 2)) === 'success') {
    tell(
      `${tier.what} ${runUrl(run)}, on \`${sha.slice(0, 8)}\`: its failed jobs passed on their rerun at the same commit, so it was a flake, and nothing is bisected. CI's records name each test that passed only on a retry.`,
    );

    return;
  }

  const failed = jobsOf(run, 2).filter((job) => job.conclusion === 'failure');
  const check = checkOf(failed, failedFiles);

  if (check === undefined) {
    tell(
      `${tier.what} ${runUrl(run)}, on \`${sha.slice(0, 8)}\`, failed again on its rerun, in ${failed.map((job) => `"${job.name}"`).join(', ')}, which no run by hand checks alone, so nothing is bisected.`,
    );

    return;
  }

  const base = lastPassing(tier, sha);

  if (base === undefined) {
    tell(`${tier.what} ${runUrl(run)}, on \`${sha.slice(0, 8)}\`, failed again on its rerun, in ${check.name}, and ${tier.none}, so nothing is bisected.`);

    return;
  }

  // Each run by hand of a sweep's bisect counts against the same allowance as a slice's.
  const merges = git('rev-list', '--first-parent', '--reverse', `${base}..${sha}`).split('\n');
  const tagged = { ...check, inputs: { ...check.inputs, ...bisectInput } };
  const halved = await halve(tagged, merges, async (there, at) => {
    if (!mayRun(monthSpend(new Date()))) return undefined;

    const { tried, verdict } = await runByHand(there, at);

    return { verdict, line: `- \`${at.slice(0, 8)}\`: ${verdict}, ${runUrl(tried)}` };
  });

  // A check that never failed by hand blames the last merge only once it fails by hand at the
  // run's own commit too: a run by hand checks less than the run can, and passes there.
  let reproduced = true;

  if (!halved.stopped && halved.verdicts.every((verdict) => verdict !== 'failed') && nextIndex(halved.good, halved.bad) === undefined) {
    if (mayRun(monthSpend(new Date()))) {
      const { tried, verdict } = await runByHand(tagged, sha);
      halved.steps.push(`- \`${sha.slice(0, 8)}\`, the run's own: ${verdict}, ${runUrl(tried)}`);

      if (verdict !== 'failed') reproduced = false;
    } else reproduced = false;
  }

  const found = reproduced
    ? foundIn(merges, base, sha, halved)
    : "A run by hand didn't fail it at the run's own commit, so nothing is named: read the run's failed jobs.";
  const stop = halved.stopped ? ` It stopped at the month's vCPU-minute allowance (\`bisectBudget\` in \`scripts/sweeps/sweep-bisect.ts\`).` : '';
  tell(
    [
      `${tier.what} ${runUrl(run)}, on \`${sha.slice(0, 8)}\`, failed again on its rerun, so it bisected ${check.name} over the ${String(merges.length)} merges ${tier.since}, \`${base.slice(0, 8)}\`. ${found}${stop}`,
      '',
      ...halved.steps,
    ].join('\n'),
  );
};

interface Listed {
  readonly id: number;
  readonly status: string | null;
  readonly display_title: string;
}

/** The days before today's that were read whole, whose runs no new run joins. */
const pastDays = new Map<string, ReadonlyArray<Listed>>();

/** Every `workflow_dispatch` run of `workflow` made on `day`, in UTC, or a refusal. */
const dayRuns = (workflow: string, day: string, today: string) => {
  const kept = pastDays.get(`${workflow} ${day}`);
  if (kept !== undefined) return kept;

  const runs: Array<Listed> = [];
  let total = 0;

  for (let page = 1; page <= 10; page++) {
    const read = JSON.parse(
      api(
        `repos/${repo()}/actions/workflows/${workflow}/runs?event=workflow_dispatch&created=${day}&per_page=100&page=${String(page)}`,
        '{total: .total_count, runs: [.workflow_runs[] | {id, status, display_title}]}',
      ),
    ) as { total: number; runs: ReadonlyArray<Listed> };
    total = read.total;
    runs.push(...read.runs);

    if (read.runs.length === 0 || runs.length >= total) break;
  }

  const whole = wholeListing({ totalCount: total, runs }, `${workflow} on ${day}`);
  if (day < today) pastDays.set(`${workflow} ${day}`, whole);

  return whole;
};

/** The bills of ended runs, which no longer change, kept for the rest of the process. */
const endedBills = new Map<number, number>();

/**
 * What this month's bisects billed, or hold while they run, from GitHub: every controller and
 * every run by hand they started, by the names they're given, cancelled and running ones too. A
 * call GitHub fails throws, so the bisect starts nothing it can't count.
 */
const monthSpend = (now: Date) => {
  const today = now.toISOString().slice(0, 10);
  const days: Array<string> = [];

  for (let day = monthStart(now).getTime(); ; day += 86_400_000) {
    const date = new Date(day).toISOString().slice(0, 10);
    if (date > today) break;

    days.push(date);
  }

  const listed = (workflow: string, tagged: (title: string) => boolean, jobMinutes: number) =>
    days.flatMap((day) => dayRuns(workflow, day, today).flatMap((run) => (tagged(run.display_title) ? [{ ...run, jobMinutes }] : [])));
  const runs = [
    ...listed(ciWorkflow, (title) => title.endsWith(byHandTag), bisectBudget.jobMinutes),
    ...listed(controllerWorkflow, (title) => title.startsWith(controllerTitle('')), bisectBudget.controllerMinutes),
  ];

  return runs.reduce((sum, run) => {
    const kept = endedBills.get(run.id);
    if (kept !== undefined) return sum + kept;

    const jobs = lines(
      gh([
        'api',
        '--paginate',
        `repos/${repo()}/actions/runs/${String(run.id)}/jobs?filter=all&per_page=100`,
        '--jq',
        '.jobs[] | {id, name, conclusion, started_at, completed_at, labels} | @json',
      ]),
    ).map((line) => JSON.parse(line) as Job);
    const done = run.status === 'completed';
    const bill = billOf(done, jobs, Date.now(), { jobMinutes: run.jobMinutes, runMinimum: bisectBudget.nextRunVcpuMinutes });
    if (done) endedBills.set(run.id, bill);

    return sum + bill;
  }, 0);
};

/** When each passing slice was made, the newest 100. */
const slicePasses = () =>
  lines(
    api(
      `repos/${repo()}/actions/workflows/${ciWorkflow}/runs?branch=main&status=success&per_page=100`,
      `.workflow_runs[] | select(.display_title == ${JSON.stringify(sliceTitle ?? '')}) | .created_at`,
    ),
  );

/** The open issue's comments, with their authors, or none when no issue is open. */
const postedOnOpen = (): ReadonlyArray<Posted> => {
  const open = lines(
    gh([
      'api',
      '--paginate',
      `repos/${repo()}/issues?state=open&per_page=100`,
      '--jq',
      `.[] | select(.pull_request == null and .title == ${JSON.stringify(issueTitle)}) | .number`,
    ]),
  )[0];
  if (open === undefined) return [];

  return lines(
    gh(['api', '--paginate', `repos/${repo()}/issues/${open}/comments?per_page=100`, '--jq', '.[] | {author: .user.login, body: (.body // "")} | @json']),
  ).map((line) => JSON.parse(line) as Posted);
};

const sliceBisect = async (run: string, sha: string, at: string, tier: Tier) => {
  const failed = jobsOf(run, 1).filter((job) => job.conclusion === 'failure');
  const read = new Map<number, ReadonlyArray<string>>();
  const filesOf = (job: Job) => {
    const held = read.get(job.id) ?? failedFiles(job);
    read.set(job.id, held);

    return held;
  };

  const files = [...new Set(failed.flatMap(filesOf))].sort();

  const covered = coveredFiles(bisectRecordsIn(postedOnOpen()), slicePasses());
  const uncovered = new Set(files.filter((file) => !covered.has(file)));
  const tagged = checkOf(failed, (job) => filesOf(job).filter((file) => uncovered.has(file)));
  const check = tagged === undefined ? undefined : { ...tagged, inputs: { ...tagged.inputs, ...bisectInput } };

  // One comment, kept up to date. Its record holds what this run saw fail, and what it ran by hand
  // once it has, the only evidence a later bisect skips on once it's finished.
  let probed: BisectRecord['probed'];
  let finished = false;
  const record = (): BisectRecord => {
    const seen: BisectRecord = { run, sha, at, failed: files, finished };

    return probed === undefined ? seen : { ...seen, probed };
  };

  const lead = `${tier.what} ${runUrl(run)}, on \`${sha.slice(0, 8)}\`, failed`;
  const comment = gh(['api', '-X', 'POST', `repos/${repo()}/issues/${issue()}/comments`, '-f', `body=${lead}.\n\n${recordMarker(record())}`, '--jq', '.id']);
  const post = (body: ReadonlyArray<string>) => {
    const text = [...body, '', recordMarker(record())].join('\n');
    say(text);
    gh(['api', '-X', 'PATCH', `repos/${repo()}/issues/comments/${comment}`, '-f', `body=${text}`]);
  };

  if (files.length > 0 && uncovered.size === 0) {
    post([
      `${lead} only in files an earlier bisect on this issue ran by hand and found failing, ${files.map((file) => `\`${file}\``).join(', ')}, so nothing is bisected again until a run passes one of them.`,
    ]);

    return;
  }

  if (check === undefined) {
    post([`${lead} in ${failed.map((job) => `"${job.name}"`).join(', ')}, which no run by hand checks alone, so nothing is bisected.`]);

    return;
  }

  const steps: Array<string> = [];
  const seenAt = new Map<string, ReadonlyArray<string>>();

  const investigate = async () => {
    let spent = 0;
    const stop = () =>
      `This month's bisects have billed or hold ${String(spent)} of their ${String(bisectBudget.monthlyVcpuMinutes)} vCPU-minutes, by GitHub's jobs, and a run by hand takes up to ${String(bisectBudget.nextRunVcpuMinutes)}, so it runs no more: \`bisectBudget\` in \`scripts/sweeps/sweep-bisect.ts\`.`;
    const probe = async (there: Check, commit: string) => {
      spent = monthSpend(new Date());

      if (!mayRun(spent)) return undefined;

      const { tried, verdict, failed: seen } = await runByHand(there, commit);
      seenAt.set(commit, seen);
      const line = `- \`${commit.slice(0, 8)}\`${commit === sha ? ", the run's own" : ''}: ${verdict}, ${runUrl(tried)}`;
      steps.push(line);
      post([`${lead} in ${check.name}: bisecting.`, '', ...steps]);

      return { verdict, line, seen };
    };

    // The uncovered failed files alone at the run's own commit, in place of a rerun of every shard.
    const own = await probe(check, sha);

    if (own === undefined) {
      post([`${lead} in ${check.name}, and nothing is bisected. ${stop()}`]);

      return;
    }

    // Only the files the run by hand saw fail, never every file it ran.
    probed = { files: own.seen, verdict: own.verdict };

    if (own.verdict !== 'failed') {
      post([
        own.verdict === 'passed'
          ? `${lead} in ${check.name}, which passed by hand at the same commit, so it was a flake, and nothing is bisected. CI's records name each test that passed only on a retry.`
          : `${lead} in ${check.name}, and a run by hand at the same commit didn't run it, so nothing is bisected.`,
        '',
        ...steps,
      ]);

      return;
    }

    const base = lastPassing(tier, sha);

    if (base === undefined) {
      post([`${lead} in ${check.name}, and ${tier.none}, so nothing is bisected.`, '', ...steps]);

      return;
    }

    const merges = git('rev-list', '--first-parent', '--reverse', `${base}..${sha}`).split('\n');
    const halved = await halve(check, merges, probe);
    const found = foundIn(merges, base, sha, halved);
    // Only the files that failed at the merge it found: the rest broke later, and stay uncovered.
    const covers = boundaryFiles(seenAt, merges, halved.bad, sha);
    probed = { files: covers, verdict: 'failed' };
    const rest = uncovered.size - covers.length;
    finished = true;
    post([
      `${lead} in ${check.name}, again by hand at the same commit, so it bisected them over the ${String(merges.length)} merges ${tier.since}, \`${base.slice(0, 8)}\`. ${found}${halved.stopped ? ` ${stop()}` : ''}${rest > 0 ? ` ${String(rest)} more failed files aren't covered by this bisect, so the next run that fails them bisects them.` : ''}`,
      '',
      own.line,
      ...halved.steps,
    ]);
  };

  try {
    await investigate();
  } catch (error) {
    // A bisect cut short covers nothing, so the next run that fails these files bisects them
    // again, within the allowance. The controller still fails, for its log.
    const why = error instanceof Error ? error.message : String(error);
    finished = false;

    try {
      post([`${lead} in ${check.name}: stopped: ${why}. It covers nothing.`, '', ...steps]);
    } catch {
      say(`Couldn't say so on the issue: ${why}`);
    }

    throw error;
  }
};

const bisect = async (run: string) => {
  const [sha = '', at = '', ...title] = api(`repos/${repo()}/actions/runs/${run}`, '"\\(.head_sha) \\(.created_at) \\(.display_title)"').split(' ');
  const tier = tierOf(title.join(' '));
  if (tier === undefined) throw new Error(`run ${run} is neither main's sweep nor a slice of main's tests`);

  // The controller counts against the month's allowance only by its name.
  const own = env['GITHUB_RUN_ID'] ?? '';
  if (api(`repos/${repo()}/actions/runs/${own}`, '.display_title') !== controllerTitle(run))
    throw new Error(`the controller's run-name must be "${controllerTitle(run)}", so its minutes count`);

  await (tier.slice ? sliceBisect(run, sha, at, tier) : sweepBisect(run, sha, tier));
};

if (argv[1] === fileURLToPath(import.meta.url)) {
  const [run] = argv.slice(2);

  if (run === undefined || !/^\d+$/.test(run)) {
    console.error('usage: node scripts/sweeps/sweep-bisect.ts <run id>');
    exit(2);
  }

  try {
    await bisect(run);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    exit(1);
  }
}
