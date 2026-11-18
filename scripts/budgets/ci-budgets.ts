/**
 * ci-budgets.ts: the time each job a pull request can run may take, on the runner it may take,
 * the run-level budgets, and what CI may spend a month.
 *
 * Runs: nowhere on its own. `ci-budgets.test.ts` (in your normal test run) fails when a job a
 * pull request can run has no budget here, when a budget names a job that's gone, or when a job's
 * `runs-on:` asks for more vCPUs than its budget allows. `ci-health.ts` (a daily workflow) reports
 * the day's runs against these numbers.
 * Configure: everything in the CONFIG block below. Fill `budgets` from your own runs.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * A change to CI updates this file in the same pull request: a new job gets a budget, and a change
 * that moves a job's time or runner sets its budget again from what that change's runs measured.
 * Never raise a budget only to quiet the health check. Raise it for useful work, and say so.
 *
 * Each budget is a measured p95 plus 15%, rounded up to 5 s (`budgetSeconds`). Write where the
 * p95 came from in a comment beside each leg: which runs, from when, how many. Two ways to measure:
 * - GitHub's API: `gh api repos/<org>/<repo>/actions/runs/<id>/jobs`, each job's `completed_at`
 *   less its `started_at`, over the ready pull request runs since the last change to the job.
 * - Blacksmith's CLI, when a job has too few recent runs:
 *   `blacksmith jobs aggregate --since 7d --group-by job_name,runner_label`.
 */
import { runnerOf, type PullRequestJob, type Runner } from './ci-jobs.ts';

/** A runner a job may take, and the p95 time it may take on it, in seconds. */
export interface Leg {
  readonly runner: string;
  readonly seconds: number;
  /** Which of the job's legs this is, by its name on a run's page, when legs share a runner. */
  readonly name?: RegExp;
}

/** One job's budget. */
export interface Budget {
  /** The workflow's file name under `.github/workflows/`. */
  readonly workflow: string;
  /** The job's key under `jobs:`. */
  readonly job: string;
  /** Why it runs on a pull request. A job nobody can justify here is a job to cut. */
  readonly why: string;
  readonly legs: ReadonlyArray<Leg>;
}

// ---------------------------------------------------------------------------------------------
// CONFIG: replace with your repo's values.
// ---------------------------------------------------------------------------------------------

/**
 * Every job a ready pull request can run, with its budget. Empty until you fill it: the budget
 * test skips the real workflows while it's empty, and fails on every unbudgeted job once it isn't.
 * `exampleBudgets` below shows the shape.
 */
export const budgets: ReadonlyArray<Budget> = [];

/** The shape `budgets` takes. Illustrative numbers only: measure your own. */
export const exampleBudgets: ReadonlyArray<Budget> = [
  {
    workflow: 'ci.yml',
    job: 'plan',
    why: 'Chooses what the change reaches, so every other job runs only for that.',
    // p95 <p95> s over <n> ready PR runs since <date>: budgetSeconds gives p95 + 15%.
    legs: [{ runner: 'blacksmith-2vcpu-ubuntu-2404', seconds: 30 }],
  },
  {
    workflow: 'ci.yml',
    job: 'tests',
    why: 'The tests the change reaches, in shards sized from measured file times.',
    legs: [
      // A full run's shards (illustrative).
      { runner: 'blacksmith-8vcpu-ubuntu-2404', seconds: 120 },
      // A run of a few files on a small runner (illustrative).
      { runner: 'blacksmith-2vcpu-ubuntu-2404', seconds: 90 },
    ],
  },
  {
    workflow: 'builds.yml',
    job: 'linux',
    why: 'The compiled component and its tests, when the change reaches it.',
    legs: [
      // Two legs on one runner, told apart by the name the run's page shows.
      { runner: 'blacksmith-4vcpu-ubuntu-2404', name: /x64, the binary$/, seconds: 180 },
      { runner: 'blacksmith-4vcpu-ubuntu-2404', name: /x64, the tests$/, seconds: 180 },
      // Arm is a platform of its own: a 4-vCPU x64 budget doesn't allow an Arm runner.
      { runner: 'blacksmith-4vcpu-ubuntu-2404-arm', seconds: 180 },
    ],
  },
];

/**
 * Runner labels that don't name their size, with their vCPUs and a platform name. Blacksmith's
 * `blacksmith-<n>vcpu-<platform>` labels need no entry. Check your provider's docs for sizes.
 */
export const otherRunners: Readonly<Record<string, Runner>> = {
  // 'ubuntu-latest': { vcpu: 4, platform: 'github-ubuntu' },
};

/**
 * A pull request's run that ran every check, and one that ran less, at p95, in seconds. The
 * defaults are the targets docs/pages/12-budgets-health-and-spend.md uses: 5 minutes full, 3 minutes small.
 */
export const runSeconds = { full: 300, small: 180 } as const;

/**
 * A run's test shards bill whole started minutes, and each ends within seconds of the others, so
 * when their p95 passes `cliff` every shard bills one more minute at once. The health check flags
 * their p95 past `warn`, before that. With <shards> shards on <vcpu> vCPU, crossing the cliff
 * costs <shards> x <vcpu> vCPU-minutes more per full run: 10 shards on 8 vCPU, for example, 80.
 */
export const shardSeconds = { warn: 110, cliff: 120 } as const;

/** A test file over this, in seconds, holds a shard past its share. */
export const testFileSeconds = 90;

/**
 * List price per started minute in USD, by runner label, for labels that price per runner rather
 * than per vCPU: GitHub-hosted runners, priced per runner SKU. Copy each label your jobs use from
 * your provider's pricing page and note the date beside it. A label neither here nor Blacksmith's
 * is unpriced: the report then shows its minutes and quotes no dollar total.
 */
export const runnerMinutePrices: Readonly<Record<string, number>> = {
  // 'ubuntu-latest': <price-per-minute>, // GitHub's Actions runner pricing, read <date>
};

/**
 * A runner's list price per started minute in USD, or undefined when it isn't priced. A
 * `blacksmith-<n>vcpu-*` label prices per vCPU-minute at Blacksmith's published list price at the
 * time of writing (x64 Linux; Arm at 0.625 of it, macOS at 6.67 of it). Check the provider's
 * pricing page, and price before any discount: per-run pennies hide the total. This is a list-price
 * projection, not your bill: included minutes, free public-repo usage and discounts are in your
 * provider's billing report, which is where actual spend comes from.
 */
export const pricePerMinute = (runner: string): number | undefined => {
  const listed = runnerMinutePrices[runner];
  if (listed !== undefined) return listed;

  const vcpu = /^blacksmith-(\d+)vcpu-/.exec(runner)?.[1];
  if (vcpu === undefined) return undefined;

  return Number(vcpu) * (/macos/.test(runner) ? 0.002 * 6.67 : /-arm$/.test(runner) ? 0.002 * 0.625 : 0.002);
};

/**
 * The most CI may cost a month, in USD at list price, before the health check opens its issue.
 * Set the authoritative cap, and any warning, in the spend watcher's config (`spend-watcher/`), then
 * copy only the cap here: `<monthly-cap>`. Whoever changes one changes the other. A day that
 * projects past it opens the issue before the watcher has to act. Undefined skips the check, and
 * the report says so, as it does while any label is unpriced. Change it with the cap, never to
 * quiet the check.
 */
export const spendCeiling: number | undefined = undefined;

/**
 * The fewest runs a job or a kind of run needs in the day before its p95 is judged against its
 * budget. Fewer are reported as too few to judge, never as over. Raise it to the sample you trust
 * for your repo's traffic: a sparse day pages on noise.
 */
export const minimumRuns = 2;

// ---------------------------------------------------------------------------------------------

/** A budget from measured job times in seconds: the p95 plus 15%, rounded up to 5 s. */
export const budgetSeconds = (samples: ReadonlyArray<number>) => {
  if (samples.length === 0) throw new Error('a budget needs measured runs');

  const sorted = samples.toSorted((a, b) => a - b);
  const p95 = sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)]!;

  return Math.ceil((p95 * 1.15) / 5) * 5;
};

/** What's wrong with the budgets for `jobs`: each a line, none when every job has its budget. */
export const budgetProblems = (
  jobs: ReadonlyArray<PullRequestJob>,
  held: ReadonlyArray<Budget> = budgets,
  others: Readonly<Record<string, Runner>> = otherRunners,
) => {
  const problems: Array<string> = [];

  for (const job of jobs) {
    const budget = held.find((each) => each.workflow === job.workflow && each.job === job.id);

    if (budget === undefined) {
      problems.push(`${job.workflow}'s job ${job.id} can run on a pull request and has no budget`);
      continue;
    }

    if (job.unreadable) problems.push(`${job.workflow}'s job ${job.id} runs on a runner this can't read`);

    for (const runner of job.runners) {
      const asked = runnerOf(runner, others);

      if (asked === undefined) {
        problems.push(`${job.workflow}'s job ${job.id} runs on ${runner}, which this can't size: add it to otherRunners`);
        continue;
      }

      const allowed = budget.legs.some((leg) => {
        const own = runnerOf(leg.runner, others);

        return own !== undefined && own.platform === asked.platform && own.vcpu >= asked.vcpu;
      });

      if (!allowed) {
        problems.push(
          `${job.workflow}'s job ${job.id} can run on ${runner}, more than its budget allows: ${budget.legs.map((leg) => leg.runner).join(', ')}`,
        );
      }
    }
  }

  for (const budget of held) {
    if (!jobs.some((job) => job.workflow === budget.workflow && job.id === budget.job)) {
      problems.push(`the budget for ${budget.workflow}'s job ${budget.job} names no job a pull request can run`);
    }
  }

  return problems;
};
