#!/usr/bin/env node
/**
 * ci-health.ts: the daily CI health report. Reads the last 24 hours of CI from GitHub's API,
 * reports it against `ci-budgets.ts` as the run's summary, and keeps one issue open while anything
 * is over, updating its body each day and closing it once everything is back under.
 *
 *     node scripts/budgets/ci-health.ts [--times <results.json>] [--scale <k>] [--report]
 *
 * Runs: a scheduled workflow once a day (see README.md for the workflow), with `GH_TOKEN` set to
 * the run's own token (`issues: write`, `actions: read`). `--report` prints and touches no issue:
 * start there, as the workflow does until the user approves issue writes, and for a person running
 * it locally with `GITHUB_REPOSITORY=<org>/<repo>`. Raise `minimumRuns` in ci-budgets.ts to the
 * sample you trust before letting it open issues.
 * Configure: the CONFIG block below (workflow path, job names, run titles, issue labels).
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * It reports: pull requests' runs, full and small; each job's p95 against its budget; the test
 * shards' p95 against the minute they'd bill next; each run's slowest shard against its median;
 * test files over the file budget, from the sweeps' records and from `--times` (a Vitest results
 * file of each file's newest time); jobs that failed and then passed on a retry; how many of main's
 * sweeps failed; and the month's spend projected from the day's started runner-minutes. `--scale`
 * multiplies every limit for one run, below 1 to open the issue and above 1 to close it, so you
 * can try that path.
 *
 * Rules that keep it trustworthy (docs/pages/12-budgets-health-and-spend.md):
 * - Two observations: a job or a kind of run is over only when its p95 is past its limit AND at
 *   least two of its runs are, so one bad run pages nobody. A test file is over at once: its time
 *   is the shard planner's input.
 * - Missing data is disclosed, not assumed healthy: runs it couldn't read for the rate limit, and
 *   runs GitHub didn't answer for, are listed in the report.
 * - API reserve: it stops reading before it leaves fewer than `spareCalls` of the hour's calls for
 *   the repository's other runs, which share the token's limit, and says what it left out.
 * - Retries: a call GitHub fails for a moment (a 5xx, or the network) is tried again after 2, 4 and
 *   8 s. A new comment is never retried, as a second could double it.
 *
 * It also keeps each open flake's issue (`../flakes/flake-issues.ts` files them): it counts the
 * day's runs since the issue's last occurrence that ran its test's file without it, adds them to
 * the count in the issue's marker, and closes the issue once `quiet` says. A run counts when its
 * records, read from every attempt's logs, say the file passed and the test neither failed nor
 * needed its retry: a pull request's run or a sweep once, and a run by hand at main once per
 * repetition. Records hold only files that really ran, so a task replayed from a cache counts as
 * nothing. Runs it can't read count as none, so a gap only delays a close.
 *
 * No dependencies: Node 24 and `gh`.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { bodyOf, bookkeepingJobs, closes, lastSeen, markerIn, quiet, quietRuns, resultJob, sweepOnly, type Marker } from '../flakes/flake-issues.ts';
import { recordsIn, type PlanRecord } from '../flakes/records.ts';
import {
  budgets,
  minimumRuns,
  pricePerMinute,
  runSeconds,
  shardSeconds,
  spendCeiling,
  testFileSeconds,
  type Budget,
  type Leg,
} from './ci-budgets.ts';
import { pullRequestJobs, workflowsIn } from './ci-jobs.ts';
import { closeIssue, editIssue, openIssue, repo, say, watchIssues } from './github.ts';
import { unzipEntries } from './zip.ts';

// ---------------------------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------------------------

/** The main CI workflow, by its path in the repo. */
const ciWorkflow = '.github/workflows/ci.yml';

/** Where the workflows are, from this file, for matching jobs to budgets by name. */
const workflowsDirectory = new URL('../../.github/workflows/', import.meta.url);

/** The plan job's name on the run's page: its log holds the plan record. */
const planJob = 'Plan';

/** Test shard jobs, as `Tests <n>/<total>`. */
const shardJob = /^Tests \d+\/\d+$/;

/** A shard's log in an attempt's log zip, where GitHub names it `<n>_Tests 3_14.txt`. */
const shardZipName = /^\d+_Tests /;

/** Every job that runs tests and prints records: the shards, and jobs for heavy files. */
const testJob = /^(Tests |Heavy )/;

/** Jobs that each run one heavy file the plan chose, such as container tests. */
const heavyJob = /^Heavy /;

/** Main's daily sweep, by its run name (`run-name:` in the workflow). */
const isSweepTitle = (title: string) => title.startsWith('CI on main, ');

/** Optional extra runs of main between sweeps, such as a 6-hourly slice. Remove if you have none. */
const isMainSliceTitle = (title: string) => title === 'Server tests on main';

/** A run by hand at main, which counts once per repetition (`-f repeat=50`). */
const isHandRunOnMainTitle = (title: string) => /^CI by hand on main(,|$)/.test(title);

/** The title of the one issue the health check keeps open, and its labels. */
export const issueTitle = 'CI over its budgets';

const issueLabels = 'ci,P2';

/** The hour's calls this leaves for the repository's other runs, which share its token's limit. */
const spareCalls = 200;

// ---------------------------------------------------------------------------------------------

export interface Run {
  readonly id: number;
  readonly path: string;
  readonly event: string;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly created_at: string;
  readonly run_attempt: number;
  readonly display_title: string;
  readonly html_url: string;
}

export interface Job {
  readonly id: number;
  readonly name: string;
  readonly conclusion: string | null;
  readonly created_at: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly labels: ReadonlyArray<string>;
  readonly run_attempt: number;
}

/** A run with its jobs, every attempt's, and for a pull request's run of CI, whether it was full. */
export interface DayRun {
  readonly run: Run;
  readonly jobs: ReadonlyArray<Job>;
  readonly full?: boolean;
  /** A pull request's run's plan, as its record says. */
  readonly plan?: PlanRecord;
  /**
   * What its test jobs' records say, over every attempt: how many records each file passed in, and
   * each test that failed or passed only on a retry, as `file › test`.
   */
  readonly records?: {
    readonly passed: ReadonlyMap<string, number>;
    readonly recurred: ReadonlySet<string>;
  };
}

/** An open flake's issue, with the marker its body keeps. */
export interface FlakeIssue {
  readonly number: number;
  readonly title: string;
  readonly marker: Marker;
}

/** A test file's longest time in the day's records or the kept times, and where it was. */
export interface SlowFile {
  readonly path: string;
  readonly seconds: number;
  readonly where: string;
}

/** What the day's runs said, and what this couldn't read. */
export interface Day {
  readonly since: string;
  readonly runs: ReadonlyArray<DayRun>;
  readonly slowFiles: ReadonlyArray<SlowFile>;
  readonly unread: ReadonlyArray<string>;
  /** What GitHub didn't answer for, after every try. */
  readonly unanswered?: ReadonlyArray<string>;
  /** The open flakes' issues, or undefined when they weren't read. */
  readonly flakes?: ReadonlyArray<FlakeIssue> | undefined;
  /** The API calls reading it took, and how many the hour had left when it began. */
  readonly calls: number;
  readonly remaining?: number;
}

/** The limits a day is held to: `ci-budgets.ts`'s, or one replaced for a run. */
export interface Limits {
  readonly full: number;
  readonly small: number;
  readonly file: number;
  /** The test shards' p95 past which they near their next billed minute. */
  readonly shard: number;
  readonly ceiling: number | undefined;
  readonly budgets: ReadonlyArray<Budget>;
}

export const limits: Limits = {
  full: runSeconds.full,
  small: runSeconds.small,
  file: testFileSeconds,
  shard: shardSeconds.warn,
  ceiling: spendCeiling,
  budgets,
};

/** Every limit of `held` times `scale`, the budgets' legs too. */
export const scaled = (held: Limits, scale: number): Limits => ({
  full: held.full * scale,
  small: held.small * scale,
  file: held.file * scale,
  shard: held.shard * scale,
  ceiling: held.ceiling === undefined ? undefined : held.ceiling * scale,
  budgets: held.budgets.map((budget) => ({ ...budget, legs: budget.legs.map((leg) => ({ ...leg, seconds: leg.seconds * scale })) })),
});

/** A month, in days, for projecting a day's spend. */
const monthDays = 30.44;

const seconds = (job: Job) =>
  job.started_at === null || job.completed_at === null ? undefined : (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000;

/** The value `q` of the way up `values`, by nearest rank. */
export const percentile = (values: ReadonlyArray<number>, q: number) => {
  const sorted = values.toSorted((a, b) => a - b);

  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
};

/** Whether `values` are over `limit`: a p95 past it, and at least two past it, so one run isn't. */
export const isOver = (values: ReadonlyArray<number>, limit: number) =>
  values.length >= minimumRuns && percentile(values, 0.95) > limit && values.filter((value) => value > limit).length >= 2;

/** A row's limit cell, which says when the day had too few runs to judge. */
const limitCell = (count: number, limit: number) =>
  count < minimumRuns ? `${String(limit)} s (too few runs to judge: ${String(count)} of ${String(minimumRuns)})` : `${String(limit)} s`;

const ran = (job: Job) => job.conclusion === 'success' || job.conclusion === 'failure';

const runLink = (run: Run) => `[${String(run.id)}](${run.html_url})`;

const whole = (value: number) => String(Math.round(value));

/** Dollars, to the cent under $100. */
const dollars = (value: number) => {
  const digits = value < 100 ? 2 : 0;

  return `$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};

const isCi = (run: Run) => run.path === ciWorkflow;

const isSweep = (run: Run) => isCi(run) && isSweepTitle(run.display_title);

const isMainSlice = (run: Run) => isCi(run) && isMainSliceTitle(run.display_title);

const isHandRunOnMain = (run: Run) => run.event === 'workflow_dispatch' && isHandRunOnMainTitle(run.display_title);

/** A pull request's run's time, from its creation to its first attempt's result job. */
const runTime = ({ run, jobs }: DayRun) => {
  const result = jobs.find((job) => job.name === resultJob && job.run_attempt === 1);
  if (result?.completed_at == null || !ran(result)) return undefined;

  return (Date.parse(result.completed_at) - Date.parse(run.created_at)) / 1000;
};

/** The pull requests' runs of CI the day held to its limits. */
const pullRequestRuns = (day: Day) =>
  day.runs.filter(({ run }) => isCi(run) && run.event === 'pull_request' && (run.conclusion === 'success' || run.conclusion === 'failure'));

const selectionSection = (day: Day) => {
  const ranked = day.runs.flatMap(({ run, plan }) => {
    if (!isCi(run) || run.event !== 'pull_request') return [];
    if (plan?.changed == null || plan.changed.length === 0 || plan.test_selection === undefined) return [];

    const reasons = Object.values(plan.test_selection);
    if (reasons.length === 0) return [];

    return [{ run, changed: plan.changed.length, reasons, ratio: reasons.length / plan.changed.length }];
  });

  return [
    '### Test selection',
    '',
    ...(ranked.length === 0 ? ['No pull request plans with changed files and selected tests to compare.'] : [
      '| Pull request run | Changed files | Selected tests | Tests per changed file | Top reasons (test files) |',
      '| --- | ---: | ---: | ---: | --- |',
      ...ranked
        .sort((a, b) => b.ratio - a.ratio || b.reasons.length - a.reasons.length || a.run.id - b.run.id)
        .slice(0, 10)
        .map(({ run, changed, reasons, ratio }) => {
          const totals = new Map<string, number>();
          for (const reason of reasons) totals.set(reason, (totals.get(reason) ?? 0) + 1);

          const top = [...totals].sort(([a, aCount], [b, bCount]) => bCount - aCount || a.localeCompare(b))
            .slice(0, 3)
            .map(([reason, count]) => `${reason} (${count})`).join(', ');

          return `| ${runLink(run)} | ${changed} | ${reasons.length} | ${ratio.toFixed(2)} | ${top} |`;
        }),
    ]),
  ].join('\n');
};

const queueSection = (day: Day) => {
  const labels = new Map<string, Array<{ wait: number; run: Run; job: Job }>>();
  let missing = 0;

  for (const { run, jobs } of day.runs) {
    for (const job of jobs) {
      if (job.conclusion === 'skipped') continue;

      const wait = (Date.parse(job.started_at ?? '') - Date.parse(job.created_at ?? '')) / 1000;
      if (!Number.isFinite(wait) || wait < 0) {
        missing += 1;
        continue;
      }

      for (const label of new Set(job.labels.length === 0 ? ['(no label)'] : job.labels)) {
        const samples = labels.get(label) ?? [];
        samples.push({ wait, run, job });
        labels.set(label, samples);
      }
    }
  }

  return [
    '### Runner queue time',
    '',
    ...(labels.size === 0 ? ['No jobs with queue timestamps.'] : [
      '| Runner label | Jobs | Median | p90 | Longest waits |',
      '| --- | ---: | ---: | ---: | --- |',
      ...[...labels].sort(([a], [b]) => a.localeCompare(b)).map(([label, samples]) => {
        const waits = samples.map(({ wait }) => wait);
        const longest = samples.sort((a, b) => b.wait - a.wait || a.run.id - b.run.id || a.job.id - b.job.id)
          .slice(0, 3)
          .map(({ run, job, wait }) => `${whole(wait)} s in ${runLink(run)} (${job.name.replaceAll('|', '\\|')}, attempt ${job.run_attempt})`)
          .join(', ');

        return `| ${label.replaceAll('|', '\\|')} | ${waits.length} | ${whole(percentile(waits, 0.5))} s | ${whole(percentile(waits, 0.9))} s | ${longest} |`;
      }),
    ]),
    ...(missing === 0 ? [] : ['', `Jobs without usable queue timestamps: ${missing}.`]),
  ].join('\n');
};

const runsSection = (day: Day, held: Limits, over: Array<string>) => {
  const rows = (['full', 'small'] as const).map((kind) => {
    const times = pullRequestRuns(day)
      .filter((each) => each.full === (kind === 'full'))
      .flatMap((each) => {
        const time = runTime(each);

        return time === undefined ? [] : [time];
      });
    const limit = held[kind];
    if (isOver(times, limit)) over.push(`${kind} pull request runs' p95 is ${whole(percentile(times, 0.95))} s, past ${String(limit)} s`);

    return `| ${kind === 'full' ? 'Full' : 'Small'} | ${String(times.length)} | ${whole(times.reduce((a, b) => a + b, 0) / 60)} min | ${whole(percentile(times, 0.5))} s | ${whole(percentile(times, 0.95))} s | ${limitCell(times.length, limit)} |`;
  });

  return [
    "### Pull requests' runs",
    '',
    `From creation to the first attempt's \`${resultJob}\`. A full run's plan chose every check.`,
    '',
    '| Runs | Count | Total | Median | p95 | Limit |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
};

/** Which budget's leg a job's run is, by its name and runner. */
const legOf = (job: Job, named: ReadonlyArray<{ readonly budget: Budget; readonly names: ReadonlyArray<RegExp> }>) => {
  const owner = named.find(({ names }) => names.some((name) => name.test(job.name)));
  if (owner === undefined) return undefined;

  const label = job.labels[0];
  const leg = owner.budget.legs.find((each) => each.runner === label && (each.name === undefined || each.name.test(job.name)));

  return { budget: owner.budget, leg };
};

const jobsSection = (day: Day, held: Limits, over: Array<string>) => {
  const jobs = existsSync(workflowsDirectory) ? pullRequestJobs(workflowsIn(workflowsDirectory)) : [];
  const named = held.budgets.map((budget) => ({
    budget,
    names: jobs.find((job) => job.workflow === budget.workflow && job.id === budget.job)?.names ?? [],
  }));
  const times = new Map<Leg, Array<number>>();
  const unbudgeted = new Set<string>();

  for (const { run, jobs: ranJobs } of day.runs) {
    if (run.event !== 'pull_request') continue;

    for (const job of ranJobs) {
      const time = seconds(job);
      if (!ran(job) || time === undefined) continue;

      const found = legOf(job, named);

      if (found?.leg === undefined) {
        unbudgeted.add(`${job.name} on ${job.labels.join(', ')}`);
        continue;
      }

      times.set(found.leg, [...(times.get(found.leg) ?? []), time]);
    }
  }

  const rows = held.budgets.flatMap((budget) =>
    budget.legs.flatMap((leg) => {
      const values = times.get(leg) ?? [];
      if (values.length === 0) return [];

      const p95 = percentile(values, 0.95);
      const name = `${budget.job}${leg.name === undefined ? '' : `, ${leg.name.source.replace(/^\^|\$$/g, '')}`}`;
      if (isOver(values, leg.seconds)) over.push(`${name}'s p95 on ${leg.runner} is ${whole(p95)} s, past its ${String(leg.seconds)} s`);

      return [
        `| ${name} | ${leg.runner} | ${String(values.length)} | ${whole(percentile(values, 0.5))} s | ${whole(p95)} s | ${limitCell(values.length, leg.seconds)} |`,
      ];
    }),
  );

  return [
    "### Each job's p95 against its budget",
    '',
    ...(held.budgets.length === 0 ? ['No budgets are set yet (`budgets` in ci-budgets.ts), so no job is judged: this is no overrun.', ''] : []),
    '| Job | Runner | Runs | Median | p95 | Budget |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    ...(unbudgeted.size === 0 ? [] : ['', `No budget's leg for: ${[...unbudgeted].join('; ')}.`]),
  ].join('\n');
};

const shardsSection = (day: Day, held: Limits, over: Array<string>) => {
  const times: Array<number> = [];
  const spreads = pullRequestRuns(day).flatMap(({ run, jobs }) => {
    const shards = jobs.flatMap((job) => {
      const time = seconds(job);

      return shardJob.test(job.name) && job.run_attempt === 1 && ran(job) && time !== undefined ? [time] : [];
    });
    if (shards.length < 2) return [];

    times.push(...shards);
    const slowest = Math.max(...shards);
    const median = percentile(shards, 0.5);

    return [{ run, shards: shards.length, slowest, median, ratio: slowest / median }];
  });
  const worst = spreads.toSorted((a, b) => b.ratio - a.ratio).slice(0, 5);
  const p95 = percentile(times, 0.95);
  if (isOver(times, held.shard))
    over.push(`test shards' p95 is ${whole(p95)} s, past ${String(held.shard)} s, near the ${String(shardSeconds.cliff)} s where each bills another minute`);

  const ratios = spreads.map(({ ratio }) => ratio * 100);

  return [
    '### Test shards',
    '',
    ...(times.length === 0
      ? []
      : [
          `${String(times.length)} shards, in runs of two or more: p95 ${whole(p95)} s, flagged past ${String(held.shard)} s, since each bills another minute past ${String(shardSeconds.cliff)} s.`,
          '',
        ]),
    spreads.length === 0
      ? 'No pull request ran two shards or more.'
      : `${String(spreads.length)} runs of two shards or more. The slowest shard took ${whole(percentile(ratios, 0.5))}% of the median one at the median run, and ${whole(percentile(ratios, 0.95))}% at p95.`,
    '',
    ...(worst.length === 0
      ? []
      : [
          '| Run | Shards | Slowest | Median | Ratio |',
          '| --- | --- | --- | --- | --- |',
          ...worst.map(
            ({ run, shards, slowest, median, ratio }) =>
              `| ${runLink(run)} | ${String(shards)} | ${whole(slowest)} s | ${whole(median)} s | ${ratio.toFixed(2)} |`,
          ),
        ]),
  ].join('\n');
};

const filesSection = (day: Day, held: Limits, over: Array<string>) => {
  const slow = day.slowFiles.filter(({ seconds: time }) => time > held.file);

  for (const file of slow) over.push(`${file.path} took ${whole(file.seconds)} s, past ${String(held.file)} s`);

  return [
    `### Test files over ${String(held.file)} s`,
    '',
    slow.length === 0
      ? "None, in the sweeps' records or the kept times."
      : slow.map((file) => `- \`${file.path}\`: ${whole(file.seconds)} s, ${file.where}`).join('\n'),
  ].join('\n');
};

// The result and report jobs rerun with whatever failed, and for reasons of their own, so they're left out.
const retriesSection = (day: Day) => {
  const retried = day.runs.flatMap(({ run, jobs }) =>
    [...new Set(jobs.map((job) => job.name))]
      .filter((name) => !bookkeepingJobs.has(name))
      .flatMap((name) => {
        const attempts = jobs.filter((job) => job.name === name);
        const failed = attempts.find((job) => job.conclusion === 'failure');
        const passed = attempts.find(
          (job) => job.conclusion === 'success' && failed !== undefined && job.run_attempt > failed.run_attempt,
        );

        return passed === undefined || failed === undefined
          ? []
          : [`- ${name}, in ${runLink(run)}: failed on attempt ${String(failed.run_attempt)}, passed on ${String(passed.run_attempt)}`];
      }),
  );

  return ['### Jobs that failed and passed on a retry', '', retried.length === 0 ? 'None.' : retried.join('\n')].join('\n');
};

/** Whether a run's records count for flakes: a pull request's, a sweep's, a slice of main's, or one by hand at main. */
const counts = (run: Run) =>
  isCi(run) && (run.event === 'pull_request' || isSweep(run) || isMainSlice(run) || isHandRunOnMain(run));

/** Whether a plan chose a test file: a heavy file it lists, or an ordinary one under its packages. */
export const chose = (plan: PlanRecord, file: string) =>
  sweepOnly(file)
    ? plan.sandbox.includes(file)
    : plan.packages === null || plan.packages.some((each) => file === each || file.startsWith(each.endsWith('/') ? each : `${each}/`));

/** How many times a run ran a flake's file, or its job, without the flake: none if it recurred. */
export const cleanRunsIn = ({ run, jobs, plan, records }: DayRun, marker: Marker) => {
  if (!counts(run)) return 0;

  if (marker.kind === 'job')
    return jobs.some((job) => job.name === marker.job && job.run_attempt === 1 && job.conclusion === 'success') ? 1 : 0;

  const file = marker.file ?? '';

  if (records !== undefined) {
    if (records.recurred.has(`${file} › ${marker.test ?? ''}`)) return 0;

    const passed = records.passed.get(file) ?? 0;

    return isHandRunOnMain(run) ? passed : Math.min(passed, 1);
  }

  // Without records, an ordinary file's task may have replayed its pass from a cache, which ran
  // nothing, so only a heavy file the plan chose, whose jobs all passed first time, counts.
  if (plan === undefined || run.event !== 'pull_request' || !sweepOnly(file) || !chose(plan, file)) return 0;

  const heavy = jobs.filter((job) => heavyJob.test(job.name) && job.run_attempt === 1);

  return heavy.length > 0 && heavy.every((job) => job.conclusion === 'success') ? 1 : 0;
};

/** What the day does to a flake's issue: its marker with the day's runs counted, and whether it closes. */
export interface FlakeUpdate {
  readonly issue: FlakeIssue;
  readonly marker: Marker;
  readonly added: number;
  readonly closes: boolean;
}

/** Each open flake's issue with the day's runs since it was last counted, or last seen, counted. */
export const flakeUpdates = (day: Day, now: Date): ReadonlyArray<FlakeUpdate> =>
  (day.flakes ?? []).map((issue) => {
    const from = Math.max(Date.parse(lastSeen(issue.marker)), Date.parse(issue.marker.counted ?? lastSeen(issue.marker)));
    const added = day.runs
      .filter((each) => Date.parse(each.run.created_at) > from)
      .reduce((sum, each) => sum + cleanRunsIn(each, issue.marker), 0);
    const marker = { ...issue.marker, clean: issue.marker.clean + added, counted: now.toISOString() };

    return { issue, marker, added, closes: closes(marker, now) };
  });

const flakesSection = (updates: ReadonlyArray<FlakeUpdate>, now: Date) =>
  [
    "### Flakes' issues",
    '',
    `Each open flake issue, with the runs since its last occurrence that ran its file without it. One closes after ${String(quiet.days)} days and ${String(quiet.runs)} such runs, or ${String(quiet.sweepRuns)} for a file only the sweep runs, or a job.`,
    '',
    ...(updates.length === 0
      ? ['None open.']
      : [
          '| Issue | Last seen | Days since | Runs since without it | Today | Closes |',
          '| --- | --- | --- | --- | --- | --- |',
          ...updates.map(
            ({ issue, marker, added, closes: closing }) =>
              `| #${String(issue.number)} | ${lastSeen(marker).slice(0, 10)} | ${whole((now.getTime() - Date.parse(lastSeen(marker))) / 86_400_000)} | ${String(marker.clean)} | +${String(added)} | ${closing ? 'yes' : 'no'} |`,
          ),
        ]),
  ].join('\n');

/** Main's sweeps and slices of the day: how many ran, failed on their first attempt, and still failed. */
const mainRunsSection = (day: Day) => {
  const rows = (
    [
      ['The sweep', isSweep],
      ["Main's slices", isMainSlice],
    ] as const
  ).map(([name, is]) => {
    const runs = day.runs.filter(({ run }) => is(run));
    const failed = runs.filter(({ jobs }) => jobs.some((job) => job.run_attempt === 1 && job.conclusion === 'failure'));
    const still = failed.filter(({ run }) => run.conclusion === 'failure');

    return `| ${name} | ${String(runs.length)} | ${String(failed.length)} | ${String(still.length)} | ${failed.map(({ run }) => runLink(run)).join(', ') || 'none'} |`;
  });

  return [
    "### Main's runs",
    '',
    '| Runs | Count | Failed first | Failed after a rerun | Failures |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
};

/**
 * A job's started minutes and their list price, or no price when its label has none. Each job
 * rounds up to whole minutes, as GitHub's hosted runners and Blacksmith bill: check your provider's
 * rounding. Every attempt's jobs count, since every attempt bills.
 */
const billed = (job: Job) => {
  const time = seconds(job);
  if (time === undefined || job.conclusion === 'skipped') return undefined;

  const label = job.labels[0] ?? '';
  const minutes = Math.max(1, Math.ceil(time / 60));
  const price = pricePerMinute(label);

  return { label, minutes, usd: price === undefined ? undefined : minutes * price };
};

const spendSection = (day: Day, held: Limits, over: Array<string>) => {
  const byWorkflow = new Map<string, { minutes: number; usd: number }>();
  const unpriced = new Set<string>();

  for (const { run, jobs } of day.runs) {
    for (const job of jobs) {
      const cost = billed(job);
      if (cost === undefined) continue;
      if (cost.usd === undefined) unpriced.add(cost.label || 'a job with no label');

      const workflow = run.path.replace('.github/workflows/', '');
      const sum = byWorkflow.get(workflow) ?? { minutes: 0, usd: 0 };
      byWorkflow.set(workflow, { minutes: sum.minutes + cost.minutes, usd: sum.usd + (cost.usd ?? 0) });
    }
  }

  const total = [...byWorkflow.values()].reduce((sum, each) => sum + each.usd, 0);
  const minutes = [...byWorkflow.values()].reduce((sum, each) => sum + each.minutes, 0);
  const month = total * monthDays;
  const priced = unpriced.size === 0;
  if (priced && held.ceiling !== undefined && month > held.ceiling)
    over.push(`the month's spend projects to ${dollars(month)}, past its ${dollars(held.ceiling)} ceiling`);

  const ceiling = held.ceiling === undefined ? 'no ceiling (set `spendCeiling` in ci-budgets.ts)' : `a ceiling of ${dollars(held.ceiling)}`;

  return [
    '### Spend',
    '',
    priced
      ? `${minutes.toLocaleString('en-US')} runner-minutes started in the day, ${dollars(total)} at list price: ${dollars(month)} over a month of ${String(monthDays)} days, against ${ceiling}. Each job's started minutes priced by its label (\`pricePerMinute\`). A list-price projection, not the bill: your provider's billing report has actual spend.`
      : `${minutes.toLocaleString('en-US')} runner-minutes started in the day. No dollar total: ${[...unpriced].join(', ')} ${unpriced.size === 1 ? 'has' : 'have'} no price (\`runnerMinutePrices\` in ci-budgets.ts), so the ceiling isn't checked.`,
    '',
    '| Workflow | Runner-minutes | USD, priced labels | A month at this rate |',
    '| --- | --- | --- | --- |',
    ...[...byWorkflow]
      .toSorted(([, a], [, b]) => b.usd - a.usd || b.minutes - a.minutes)
      .map(
        ([workflow, { minutes: count, usd }]) =>
          `| ${workflow} | ${count.toLocaleString('en-US')} | ${usd.toFixed(2)} | ${dollars(usd * monthDays)} |`,
      ),
  ].join('\n');
};

/** The day's report, each thing over its limit, and what it does to each flake's issue. */
export const healthOf = (day: Day, held: Limits) => {
  const over: Array<string> = [];
  const now = new Date(Date.parse(day.since) + 24 * 60 * 60 * 1000);
  const flakes = flakeUpdates(day, now);
  const sections = [
    runsSection(day, held, over),
    selectionSection(day),
    jobsSection(day, held, over),
    queueSection(day),
    shardsSection(day, held, over),
    filesSection(day, held, over),
    retriesSection(day),
    mainRunsSection(day),
    ...(day.flakes === undefined ? [] : [flakesSection(flakes, now)]),
    spendSection(day, held, over),
  ];
  const headline = over.length === 0 ? 'Everything is under its budget.' : ['Over:', '', ...over.map((each) => `- ${each}`)].join('\n');
  const unanswered = day.unanswered ?? [];
  const unread = [
    ...(day.unread.length === 0 ? [] : [`Not read, for GitHub's rate limit: ${day.unread.join('; ')}.`]),
    ...(unanswered.length === 0 ? [] : [`Not read, as GitHub didn't answer: ${unanswered.join('; ')}.`]),
  ];

  return {
    over,
    flakes,
    markdown: [
      `## CI's health, the 24 hours from ${day.since}`,
      '',
      headline,
      ...unread.flatMap((line) => ['', line]),
      '',
      `Read ${String(day.runs.length)} runs with ${String(day.calls)} API calls${day.remaining === undefined ? '' : `, of ${String(day.remaining)} the hour had left`}.`,
      '',
      ...sections.flatMap((section) => [section, '']),
      'The budgets and the ceiling are in `scripts/budgets/ci-budgets.ts`, which says how each was measured.',
    ].join('\n'),
  };
};

const execGh = promisify(execFile);

/** `gh api` with `args`, and what it printed. */
export type GhApi = (args: ReadonlyArray<string>) => Promise<Buffer>;

const ghApi: GhApi = async (args) => (await execGh('gh', ['api', ...args], { encoding: 'buffer', maxBuffer: 1 << 30 })).stdout;

/** The waits before each new try of a call GitHub failed for a moment: four tries in about 14 s. */
export const backoff = [2_000, 4_000, 8_000];

/** Whether what `gh` said on failing is what a moment can cure: a 5xx from GitHub, or the network. */
const transient = (said: string) =>
  /\(HTTP 5\d\d\)|connection reset|i\/o timeout|TLS handshake timeout|unexpected EOF|dial tcp/i.test(said);

const pauseFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `gh api`, counting each call against what the hour allows, and trying a moment's failure again. */
export const reader = (allowed: number, gh: GhApi = ghApi, pause = pauseFor) => {
  let calls = 0;

  const tried = async (args: ReadonlyArray<string>, waits: ReadonlyArray<number>): Promise<Buffer> => {
    calls++;

    try {
      return await gh(args);
    } catch (error) {
      const [wait, ...rest] = waits;
      if (wait === undefined || !transient(String(error))) throw error;

      await pause(wait);

      return tried(args, rest);
    }
  };

  /** `gh api` for a binary answer, such as a zip. A new comment is sent once, as a second could double it. */
  const bytes = (args: ReadonlyArray<string>): Promise<Buffer> => tried(args, args[args.indexOf('-X') + 1] === 'POST' ? [] : backoff);

  const api = async (args: ReadonlyArray<string>) => (await bytes(args)).toString('utf8');

  return { api, bytes, left: () => allowed - calls, calls: () => calls };
};

/** Each of `items` through `read`, six at a time. */
const eachOf = async <A, B>(items: ReadonlyArray<A>, read: (item: A) => Promise<B>) => {
  const results: Array<B> = [];
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await read(items[index]!);
    }
  };

  await Promise.all(Array.from({ length: 6 }, worker));

  return results;
};

const lines = (text: string) => text.split('\n').filter((line) => line !== '');

/** Each file's newest time in ms, from Vitest-shaped results files (`projects.*.files[path]`). */
export const timesIn = (texts: ReadonlyArray<string>) => {
  const newest = new Map<string, { duration: number; lastRun: number }>();

  for (const text of texts) {
    const { projects } = JSON.parse(text) as {
      readonly projects?: Record<string, { readonly files?: Record<string, { readonly duration?: number; readonly lastRun?: number }> }>;
    };

    for (const { files = {} } of Object.values(projects ?? {})) {
      for (const [path, { duration = 0, lastRun = 0 }] of Object.entries(files)) {
        if (!Number.isFinite(duration) || duration <= 0) continue;

        const kept = newest.get(path);
        if (kept === undefined || lastRun >= kept.lastRun) newest.set(path, { duration, lastRun });
      }
    }
  }

  return new Map([...newest].map(([path, { duration }]) => [path, duration]));
};

/** The day's runs, their jobs, full or small, and the sweeps' slow files, as far as the hour allows. */
export const read = async (now: Date, times: string | undefined, gh: GhApi = ghApi, pause = pauseFor) => {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const counted = reader(Number.POSITIVE_INFINITY, gh, pause);
  const remaining = Number((await counted.api(['rate_limit', '--jq', '.resources.core.remaining'])).trim());
  const { api, bytes, left, calls } = reader(remaining - spareCalls, gh, pause);
  const unread: Array<string> = [];
  const unanswered: Array<string> = [];

  /** `api`'s answer, or undefined, kept as `what` GitHub didn't answer for, once every try failed. */
  const orLeftOut = async <A>(what: string, answer: Promise<A>) => {
    try {
      return await answer;
    } catch (error) {
      say(`Left out ${what}: ${String(error)}`);
      unanswered.push(what);

      return undefined;
    }
  };

  const listed = lines(
    await api([
      '--paginate',
      `repos/${repo()}/actions/runs?created=%3E%3D${since}&per_page=100`,
      '--jq',
      '.workflow_runs[] | {id, path, event, status, conclusion, created_at, run_attempt, display_title, html_url} | @json',
    ]),
  ).map((line) => JSON.parse(line) as Run);
  // A run that ran no job, a draft's or one waiting for approval, bills nothing and times nothing.
  const finished = listed.filter(
    (run) => run.status === 'completed' && run.conclusion !== 'skipped' && run.conclusion !== 'action_required',
  );
  // Pull requests' runs first, then main's, then the rest, which only the spend reads.
  const order = (run: Run) => (run.event === 'pull_request' ? 0 : isSweep(run) || isMainSlice(run) ? 1 : 2);
  const ordered = finished.toSorted((a, b) => order(a) - order(b));

  const runs = (
    await eachOf(ordered, async (run): Promise<DayRun | undefined> => {
      if (left() <= 0) return undefined;

      const listedJobs = await orLeftOut(
        `run ${String(run.id)}'s jobs`,
        api([
          '--paginate',
          `repos/${repo()}/actions/runs/${String(run.id)}/jobs?filter=all&per_page=100`,
          '--jq',
          '.jobs[] | {id, name, conclusion, created_at, started_at, completed_at, labels, run_attempt} | @json',
        ]),
      );
      if (listedJobs === undefined) return undefined;

      const jobs = lines(listedJobs).map((line) => JSON.parse(line) as Job);
      if (run.event !== 'pull_request' || !isCi(run)) return { run, jobs };

      const plan = jobs.find((job) => job.name === planJob && job.run_attempt === 1);
      if (plan === undefined || left() <= 0) return { run, jobs };

      // A log GitHub no longer holds, or a run still writing it, leaves the run neither full nor small.
      const log = await api([`repos/${repo()}/actions/jobs/${String(plan.id)}/logs`, '--allow-escape-sequences']).catch(() => '');
      const record = recordsIn(log).find((each): each is PlanRecord => each.kind === 'plan');
      if (record === undefined) return { run, jobs };

      return { run, jobs, full: record.packages === null, plan: record };
    })
  ).filter((each) => each !== undefined);
  const skipped = ordered.length - runs.length - unanswered.length;
  if (skipped > 0) unread.push(`${String(skipped)} of ${String(ordered.length)} runs' jobs`);

  const slowFiles: Array<SlowFile> = [];
  const read: Array<DayRun> = [];
  const zipJob = new RegExp(`^\\d+_(${testJob.source.replace(/^\^/, '')})`);

  for (const each of runs) {
    const { run, jobs } = each;
    // Each attempt whose test jobs ran: a re-run of only the failed jobs holds none of the first's.
    const attempts = [...new Set(jobs.filter((job) => testJob.test(job.name) && ran(job)).map((job) => job.run_attempt))].sort((a, b) => a - b);

    if (!counts(run) || attempts.length === 0) {
      read.push(each);
      continue;
    }

    if (left() < attempts.length) {
      unread.push(`run ${String(run.id)}'s records`);
      read.push(each);
      continue;
    }

    const zips = await orLeftOut(
      `run ${String(run.id)}'s records`,
      Promise.all(attempts.map((attempt) => bytes([`repos/${repo()}/actions/runs/${String(run.id)}/attempts/${String(attempt)}/logs`]))),
    );

    // A run without its records counts for no ordinary test file's flake, only for a job's.
    if (zips === undefined) {
      read.push(each);
      continue;
    }

    const passed = new Map<string, number>();
    const recurred = new Set<string>();

    for (const { name, data } of zips.flatMap((zip) => unzipEntries(zip))) {
      // GitHub names each job's log `<n>_<job name>.txt` in an attempt's zip.
      if (!zipJob.test(name)) continue;

      for (const record of recordsIn(data.toString('utf8'))) {
        if (record.kind !== 'tests') continue;

        for (const [path, state] of record.files) if (state === 'passed') passed.set(path, (passed.get(path) ?? 0) + 1);

        for (const [path, test] of [...record.failed, ...record.flaky]) recurred.add(`${path} › ${test}`);

        // File times come from the shards of main's runs alone: heavy jobs have budgets of their own.
        if (!(isSweep(run) || isMainSlice(run)) || !shardZipName.test(name)) continue;

        const where = isSweep(run) ? 'sweep' : 'main slice';

        for (const [path, , ms] of record.files) slowFiles.push({ path, seconds: ms / 1000, where: `in ${where} ${runLink(run)}` });
      }
    }

    read.push({ ...each, records: { passed, recurred } });
  }

  // The open flakes' issues, with the marker flake-issues.ts keeps in each body.
  let flakes: Array<FlakeIssue> | undefined;

  if (left() > 0) {
    flakes = lines(
      await api([
        '--paginate',
        `repos/${repo()}/issues?labels=flake&state=open&per_page=100`,
        '--jq',
        '.[] | select(.pull_request == null) | {number, title, body: (.body // "")} | @json',
      ]),
    ).flatMap((line) => {
      const issue = JSON.parse(line) as { number: number; title: string; body: string };
      const marker = markerIn(issue.body);

      return marker === undefined ? [] : [{ number: issue.number, title: issue.title, marker }];
    });
  } else unread.push("the flakes' issues");

  // The kept times hold each file's newest, from the sweeps; a file since deleted is left out.
  if (times !== undefined && existsSync(times)) {
    for (const [path, ms] of timesIn([readFileSync(times, 'utf8')])) {
      if (existsSync(path)) slowFiles.push({ path, seconds: ms / 1000, where: 'in the kept test times' });
    }
  }

  const longest = new Map<string, SlowFile>();

  for (const file of slowFiles) {
    const held = longest.get(file.path);
    if (held === undefined || file.seconds > held.seconds) longest.set(file.path, file);
  }

  const day: Day = { since, runs: read, slowFiles: [...longest.values()], unread, unanswered, flakes, calls: calls(), remaining };

  return { day, api, left };
};

/**
 * Write each flake's update: its count, or its close with the numbers. Each body is read again
 * first, and one whose last occurrence moved since, as a run filed another, is left for tomorrow.
 * A run that files one in the second between that read and this write is lost: its comment stays,
 * and the next occurrence reopens the issue. GitHub's issues take no conditional write.
 */
const keepFlakes = async (
  updates: ReadonlyArray<FlakeUpdate>,
  now: Date,
  url: string,
  api: (args: ReadonlyArray<string>) => Promise<string>,
  left: () => number,
) => {
  const keep = async ({ issue, marker, closes: closing }: FlakeUpdate) => {
    const body = await api([`repos/${repo()}/issues/${String(issue.number)}`, '--jq', '.body // ""']);
    const held = markerIn(body);
    if (held === undefined || lastSeen(held) !== lastSeen(issue.marker)) return;

    if (closing) {
      const days = Math.floor((now.getTime() - Date.parse(lastSeen(marker))) / 86_400_000);
      await api([
        '-X',
        'POST',
        `repos/${repo()}/issues/${String(issue.number)}/comments`,
        '-f',
        `body=No occurrence in ${String(days)} days, since ${lastSeen(marker).slice(0, 10)}, and ${String(marker.clean)} runs that ran its file passed without it: past the ${String(quiet.days)} days and ${String(quietRuns(marker))} runs it closes at. CI reopens it if it flakes again. From ${url}.`,
      ]);
    }

    await api([
      '-X',
      'PATCH',
      `repos/${repo()}/issues/${String(issue.number)}`,
      '-f',
      `body=${bodyOf(marker, now)}`,
      ...(closing ? ['-f', 'state=closed', '-f', 'state_reason=completed'] : []),
    ]);

    if (closing) say(`Closes #${String(issue.number)}: ${issue.title}`);
  };

  for (const update of updates) {
    if (left() < 3) {
      say(`Left the rest of the flakes' issues, from #${String(update.issue.number)}, for the hour's calls.`);

      return;
    }

    try {
      await keep(update);
    } catch (error) {
      say(`Left #${String(update.issue.number)} for tomorrow: ${String(error)}`);
    }
  }
};

const run = async () => {
  const { values } = parseArgs({
    args: argv.slice(2),
    options: { times: { type: 'string' }, scale: { type: 'string' }, report: { type: 'boolean' } },
  });
  const scale = values.scale === undefined || values.scale === '' ? 1 : Number(values.scale);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error(`--scale takes a positive number, not ${values.scale ?? ''}`);

  const held = scaled(limits, scale);
  if (scale !== 1) say(`For this run only, every limit is ${String(scale)} times its budget.`);

  const { day, api, left } = await read(new Date(), values.times);
  const { over, flakes, markdown } = healthOf(day, held);
  say(markdown);

  if (values.report === true) return 0;

  const url = `https://github.com/${repo()}/actions/runs/${env['GITHUB_RUN_ID'] ?? ''}`;
  await keepFlakes(flakes, new Date(Date.parse(day.since) + 24 * 60 * 60 * 1000), url, api, left);

  const open = watchIssues(issueTitle).find((issue) => issue.open)?.number;
  const body = `${markdown}\n\nFrom ${url}. The health check updates this each day while anything is over, and closes it once everything is back under.`;
  if (over.length > 0 && open === undefined) say(`Opens #${openIssue(issueTitle, issueLabels, body)}.`);
  else if (over.length > 0 && open !== undefined) {
    editIssue(open, body);
    say(`Updates #${open}.`);
  } else if (open !== undefined) {
    closeIssue(open, `Everything is back under its budget: ${url}`);
    say(`Closes #${open}.`);
  }

  return 0;
};

// A failure's message alone, as an annotation on the run's page.
if (argv[1] === fileURLToPath(import.meta.url)) {
  try {
    exit(await run());
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    exit(1);
  }
}
