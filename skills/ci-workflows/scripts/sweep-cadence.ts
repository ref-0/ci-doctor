#!/usr/bin/env node
/**
 * What: measures how often a repo merges and what its full sweep costs, from GitHub's API, and prints
 *   sweep cadences to choose from, each "after N merges or T hours, whichever comes first", with its
 *   monthly job-minutes and the most merges a missed break can hide behind it.
 * Where: run by a person or an agent before choosing or changing how often the default branch's
 *   sweep runs. It reads only; it starts, cancels and changes nothing.
 * Configure: runner labels' vCPUs and the test jobs' names from `.agents/repo/ci-time.json`, as
 *   `ci-time.ts` reads them, and the flags below, as `.agents/repo/ci.md` names the sweep. Needs
 *   Node 24 and `gh`, logged in.
 * Tests: `node --test sweep-cadence.test.ts`, from this folder.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 *   node sweep-cadence.ts --sweep-title 'CI on main, '     the sweep's runs by their title's start
 *   node sweep-cadence.ts --sweep-event push               a repo with no sweep: each push to the
 *                                                          default branch runs everything, so a push
 *                                                          run stands in for a sweep's cost
 *   node sweep-cadence.ts --test-job 'Tests '              the jobs that run tests, by their name's
 *                                                          start (default: ci-time.json's first shard)
 *   node sweep-cadence.ts --days 28 --repo <org>/<repo> --workflow ci.yml --branch main
 *   node sweep-cadence.ts --option 40:24 --option 0:168    the options to price, merges:hours
 *                                                          (0 merges: by the clock alone)
 *   node sweep-cadence.ts --json                           the numbers, for a plan
 *
 * What it measures, exactly:
 * - Merges: first-parent commits on the branch in the window, by committer date, from the commits
 *   API read to its end. A merged pull request is one, as are each commit of a rebase-merge and of a
 *   direct push. It's the unit the sweep template's merge count and the sweep's bisect use: the
 *   commits a bisect of the branch walks. A window of more than `commitPages` pages is refused.
 * - A sweep's cost: the median over the window's successful sweep runs (newest 10) that ran a test
 *   job, of each run's jobs' started minutes, each job rounded up to a whole minute, as ci-time.ts
 *   counts them, and vCPU-minutes from runner labels. A successful run that ran no test job is "a
 *   slot with nothing new", its plan having found nothing to check; with none in the window, it's
 *   `--quiet-minutes` on 2 vCPU. A failed or cancelled run counts as neither. With no full run in the
 *   window it prices nothing and says so.
 * - What PR selection skips: one minus a PR run's median job-minutes over a full sweep's. A proxy:
 *   job-minutes, not test files, and a PR run also replays from caches.
 * - Releases: GitHub releases published in the window. Where the sweep gates the release, a release
 *   waits for the next passing sweep.
 *
 * Each option is replayed over the window's merges as the sweep template runs it: a clock sweep at
 * each of its fixed slots, every T hours from the window's start, and, with N set, an early sweep
 * once N merges have landed since the last sweep of either kind. An early sweep doesn't move the next
 * slot, as a cron doesn't. A clock sweep with no merge since the last is a quiet slot. "Hidden" is the
 * merges a break can sit behind: those since the last sweep, at the sweep that finds it, and the
 * merges still waiting at the window's end. Bisecting them takes about log2 of that many steps. An
 * option whose T needs more than half the window is marked unavailable: too few slots to price.
 *
 * The check that runs this is the ci-workflows skill's references/tiers.md, "Choosing the sweep's
 * cadence". The user picks the cadence: it's recurring spend.
 */
import { argv, stderr } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { billedMinutes, quantile, run as sh, type Run, SHARDS, vcpus, WORKFLOW, when } from './ci-time.ts';

/** A cadence: sweep after `merges` merges (0: never by count) or at slots `hours` apart. */
export type Option = { readonly merges: number; readonly hours: number };

/** The options printed when none is given: by the clock alone, and capped by merges, for comparison. */
export const OPTIONS: readonly Option[] = [
  { merges: 0, hours: 6 },
  { merges: 0, hours: 24 },
  { merges: 0, hours: 168 },
  { merges: 25, hours: 24 },
  { merges: 50, hours: 168 },
  { merges: 10, hours: 24 },
];

/** The most pages of 100 commits it reads; past them, it refuses the window. */
export const commitPages = 100;

/** The most pages of 100 workflow runs it reads, GitHub's limit for a filtered listing. */
export const runPages = 10;

/**
 * What an option did over the window: its sweeps, the quiet ones, the early ones, the merges each
 * checked, and the merges still waiting for the next sweep at the window's end.
 */
export type Replay = {
  readonly sweeps: number;
  readonly quiet: number;
  readonly early: number;
  readonly spans: readonly number[];
  readonly pending: number;
};

/**
 * Replays an option over merge times (seconds since the epoch, any order) from `start` to `end`, as
 * the sweep template runs it: clock sweeps at fixed slots `hours` apart from `start`, and early ones
 * at the Nth merge since the last sweep. A merge at a slot's instant is checked by that slot.
 */
export function replay(merged: readonly number[], start: number, end: number, option: Option): Replay {
  const times = merged.filter((t) => t > start && t <= end).toSorted((a, b) => a - b);
  const every = option.hours * 3600;
  const spans: number[] = [];
  let quiet = 0;
  let early = 0;
  let since = 0;
  let next = 0;

  for (let slot = start + every; slot <= end; slot += every) {
    while (next < times.length && (times[next] ?? Infinity) <= slot) {
      next += 1;
      since += 1;
      if (option.merges > 0 && since >= option.merges) {
        spans.push(since);
        early += 1;
        since = 0;
      }
    }
    spans.push(since);
    if (since === 0) quiet += 1;
    since = 0;
  }
  for (; next < times.length; next += 1) {
    since += 1;
    if (option.merges > 0 && since >= option.merges) {
      spans.push(since);
      early += 1;
      since = 0;
    }
  }

  return { sweeps: spans.length, quiet, early, spans, pending: since };
}

/** Whether a window of `days` holds enough of an option's slots to price it: at least two. */
export const observable = (option: Option, days: number) => days * 24 >= 2 * option.hours;

/** Bisect steps to find one break among `merges` merges: about log2 of them, 0 for one or none. */
export const bisectSteps = (merges: number) => (merges <= 1 ? 0 : Math.ceil(Math.log2(merges)));

/** One option's row: sweeps and job-minutes a month, and the merges a break can hide behind. */
export type Row =
  | {
      readonly option: Option;
      readonly available: true;
      readonly sweepsPerMonth: number;
      readonly quietPerMonth: number;
      readonly jobMinutesPerMonth: number;
      readonly vcpuMinutesPerMonth: number | null;
      readonly hiddenP90: number;
      readonly hiddenMax: number;
      readonly bisectMax: number;
    }
  | { readonly option: Option; readonly available: false; readonly why: string };

/** A sweep's cost, and a quiet slot's, in job-minutes and vCPU-minutes (null where a label is unknown). */
export type Cost = { readonly full: number; readonly fullVcpu: number | null; readonly quiet: number; readonly quietVcpu: number | null };

/** The row for an option, scaled from the window's days to 30, or why it can't be priced. */
export function priced(option: Option, played: Replay, days: number, cost: Cost): Row {
  if (!observable(option, days)) {
    return { option, available: false, why: `needs a window of at least ${Math.ceil((2 * option.hours) / 24)} days (--days)` };
  }

  const scale = 30 / days;
  const full = played.sweeps - played.quiet;
  const vcpu = cost.fullVcpu === null || cost.quietVcpu === null ? null : (full * cost.fullVcpu + played.quiet * cost.quietVcpu) * scale;
  const hidden = [...played.spans, played.pending];
  const most = Math.max(...hidden);

  return {
    option,
    available: true,
    sweepsPerMonth: played.sweeps * scale,
    quietPerMonth: played.quiet * scale,
    jobMinutesPerMonth: (full * cost.full + played.quiet * cost.quiet) * scale,
    vcpuMinutesPerMonth: vcpu,
    hiddenP90: quantile(hidden, 0.9),
    hiddenMax: most,
    bisectMax: bisectSteps(most),
  };
}

/** "after 25 merges or 24 hours", or "every 24 hours". */
export const named = ({ merges, hours }: Option) =>
  `${merges > 0 ? `after ${merges} merges or ` : 'every '}${hours} hours${merges > 0 ? ', whichever comes first' : ''}`;

/** Merges a day, from merge times over a window of `days`: the mean, the median day and the busiest. */
export function perDay(merged: readonly number[], start: number, days: number) {
  const counts = Array.from({ length: days }, () => 0);
  for (const t of merged) {
    const day = Math.floor((t - start) / 86_400);
    if (day >= 0 && day < days) counts[day] = (counts[day] ?? 0) + 1;
  }
  return { mean: merged.length / days, median: quantile(counts, 0.5), busiest: Math.max(0, ...counts) };
}

/** Parses `merges:hours`. */
export function parseOption(text: string): Option {
  const match = /^(\d+):([1-9]\d*)$/.exec(text);
  if (!match) throw new Error(`--option takes merges:hours, such as 25:24 or 0:168, not ${JSON.stringify(text)}`);
  return { merges: Number(match[1]), hours: Number(match[2]) };
}

/** A commit, as GitHub's commits API lists it. */
export type Commit = { readonly sha: string; readonly parents: readonly { readonly sha: string }[]; readonly commit: { readonly committer: { readonly date: string } } };

/**
 * The first-parent commits from `head` back while they're listed and after `start`, as committer
 * times in seconds, newest first: each merge once, however many commits a merged branch held.
 */
export function firstParents(commits: readonly Commit[], head: string, start: number): number[] {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const times: number[] = [];

  for (let at = bySha.get(head); at !== undefined; at = bySha.get(at.parents[0]?.sha ?? '')) {
    const t = when(at.commit.committer.date);
    if (t <= start) break;
    times.push(t);
  }

  return times;
}

// ---- Reading GitHub -------------------------------------------------------------------------------

type Listed = { id: number; display_title: string; event: string; conclusion: string | null; created_at: string; head_branch: string };
type Job = { name: string; conclusion: string | null; started_at: string | null; completed_at: string | null; labels: string[] };

const api = (run: Run, path: string) => JSON.parse(run('gh', 'api', path)) as unknown;

/** Each first-parent commit on `branch` after `start`, as its committer time in seconds; refuses a window past `pages`. */
export function merges(run: Run, repo: string, branch: string, start: number, pages = commitPages): number[] {
  const since = new Date(start * 1000).toISOString();
  const head = (api(run, `repos/${repo}/commits/${encodeURIComponent(branch)}`) as Commit).sha;
  const commits: Commit[] = [];

  for (let page = 1; ; page++) {
    if (page > pages) throw new Error(`${branch} has more than ${(pages * 100).toLocaleString('en')} commits in the window: give a shorter --days`);
    const listed = api(run, `repos/${repo}/commits?sha=${encodeURIComponent(branch)}&since=${since}&per_page=100&page=${page}`) as Commit[];
    commits.push(...listed);
    if (listed.length < 100) break;
  }

  return firstParents(commits, head, start);
}

/**
 * The workflow's completed runs created after `start`, newest first, matching `keep`, until `want`
 * match or the listing ends. GitHub lists at most `runPages` pages of a filtered listing: `truncated`
 * says the window held more than that.
 */
export function runsOf(
  run: Run,
  repo: string,
  workflow: string,
  query: string,
  start: number,
  keep: (r: Listed) => boolean,
  want: number,
): { runs: Listed[]; truncated: boolean } {
  const since = new Date(start * 1000).toISOString().slice(0, 10);
  const runs: Listed[] = [];

  for (let page = 1; page <= runPages; page++) {
    const listed = api(run, `repos/${repo}/actions/workflows/${workflow}/runs?status=completed&created=%3E%3D${since}&per_page=100&page=${page}${query}`) as { workflow_runs: Listed[]; total_count: number };
    runs.push(...listed.workflow_runs.filter((r) => when(r.created_at) >= start && keep(r)));
    if (runs.length >= want || listed.workflow_runs.length < 100) return { runs: runs.slice(0, want), truncated: false };
  }

  return { runs: runs.slice(0, want), truncated: true };
}

/** A run's latest attempt's jobs. */
function jobsOf(run: Run, repo: string, id: number): Job[] {
  const jobs: Job[] = [];
  for (let page = 1; ; page++) {
    const listed = api(run, `repos/${repo}/actions/runs/${id}/jobs?per_page=50&page=${page}`) as { jobs: Job[]; total_count: number };
    jobs.push(...listed.jobs);
    if (page * 50 >= listed.total_count || !listed.jobs.length) return jobs;
  }
}

/** Jobs' started job-minutes and vCPU-minutes (null when a label is unknown). */
export function costOf(jobs: readonly Job[]): { minutes: number; vcpu: number | null } {
  let minutes = 0;
  let vcpu: number | null = 0;
  for (const job of jobs) {
    if (job.conclusion === 'skipped' || !job.started_at || !job.completed_at) continue;
    const m = billedMinutes(when(job.completed_at) - when(job.started_at));
    const cores = vcpus(job.labels);
    minutes += m;
    vcpu = vcpu === null || cores === null ? null : vcpu + m * cores;
  }
  return { minutes, vcpu };
}

/**
 * What a sweep run was, from what its plan selected: `full` when it passed and ran a test job (a job
 * whose name starts with one of `tests`), `quiet` when it passed and ran none, its plan having found
 * nothing new, and `unknown` when it failed or was cancelled, which says nothing of either cost.
 */
export function kindOf(conclusion: string | null, jobs: readonly Job[], tests: readonly string[]): 'full' | 'quiet' | 'unknown' {
  if (conclusion !== 'success') return 'unknown';
  const ran = jobs.some((job) => tests.some((prefix) => job.name.startsWith(prefix)) && job.conclusion !== 'skipped' && job.started_at !== null);
  return ran ? 'full' : 'quiet';
}

const HELP = `Usage: node sweep-cadence.ts [--repo <org/repo>] [--workflow <file>] [--branch <name>] [--days <n>]
  (--sweep-title <start> | --sweep-event <event>) [--test-job <name start>]... [--quiet-minutes <n>]
  [--option <merges:hours>]... [--json]
Reads only. See this file's header for what each number is.`;

export function main(args: readonly string[], run: Run = sh, now = Math.floor(Date.now() / 1000)) {
  const { values } = parseArgs({
    args: [...args],
    options: {
      help: { type: 'boolean', short: 'h' },
      repo: { type: 'string' },
      workflow: { type: 'string', default: WORKFLOW },
      branch: { type: 'string' },
      days: { type: 'string', default: '28' },
      'sweep-title': { type: 'string' },
      'sweep-event': { type: 'string' },
      'test-job': { type: 'string', multiple: true },
      'quiet-minutes': { type: 'string', default: '2' },
      option: { type: 'string', multiple: true },
      json: { type: 'boolean', default: false },
    },
  });
  if (values.help) return console.log(HELP);
  if (!values['sweep-title'] && !values['sweep-event']) throw new Error('name the sweep: --sweep-title <start of its run title>, or --sweep-event push where each push runs everything');
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1) throw new Error(`--days takes a whole number above 0, not ${values.days}`);
  const options = values.option?.length ? values.option.map(parseOption) : OPTIONS;
  const tests = values['test-job']?.length ? values['test-job'] : SHARDS.slice(0, 1);

  const repo = values.repo || run('gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').trim();
  const branch = values.branch || run('gh', 'api', `repos/${repo}`, '--jq', '.default_branch').trim();
  const end = now;
  const start = end - days * 86_400;

  const merged = merges(run, repo, branch, start);
  const day = perDay(merged, start, days);

  // The sweep's runs, newest first, until 10 full ones or the window's end.
  const onBranch = `&branch=${encodeURIComponent(branch)}`;
  const title = values['sweep-title'];
  const listed = runsOf(run, repo, values.workflow, values['sweep-event'] ? `${onBranch}&event=${values['sweep-event']}` : onBranch, start, (r) => !title || r.display_title.startsWith(title), 40);
  // Newest first, until 10 full runs: each costs a jobs listing.
  const kinds: { kind: 'full' | 'quiet' | 'unknown'; minutes: number; vcpu: number | null }[] = [];
  for (const r of listed.runs) {
    if (kinds.filter((k) => k.kind === 'full').length >= 10) break;
    const jobs = r.conclusion === 'success' ? jobsOf(run, repo, r.id) : [];
    kinds.push({ kind: kindOf(r.conclusion, jobs, tests), ...costOf(jobs) });
  }
  const busy = kinds.filter((k) => k.kind === 'full').slice(0, 10);
  const quiet = kinds.filter((k) => k.kind === 'quiet').slice(0, 10);
  if (!busy.length) {
    throw new Error(
      `not enough evidence: no successful sweep run of ${values.workflow} on ${branch} in ${days} days ran a test job (a job named ${tests.map((t) => JSON.stringify(`${t}…`)).join(' or ')}), ` +
        `of ${listed.runs.length} sweep runs read${listed.truncated ? `, the first ${runPages * 100} runs of the window` : ''}. Name the test jobs with --test-job, or give a longer --days.`,
    );
  }
  const median = (xs: readonly number[]) => quantile(xs, 0.5);
  const known = (xs: readonly (number | null)[]) => (xs.every((x) => x !== null) ? median(xs as number[]) : null);
  const cost: Cost = {
    full: median(busy.map((c) => c.minutes)),
    fullVcpu: known(busy.map((c) => c.vcpu)),
    quiet: quiet.length ? median(quiet.map((c) => c.minutes)) : Number(values['quiet-minutes']),
    quietVcpu: quiet.length ? known(quiet.map((c) => c.vcpu)) : Number(values['quiet-minutes']) * 2,
  };

  const prRuns = runsOf(run, repo, values.workflow, '&event=pull_request', start, (r) => r.conclusion === 'success', 20).runs;
  const pr = prRuns.length ? median(prRuns.map((r) => costOf(jobsOf(run, repo, r.id)).minutes)) : null;

  const releases = (api(run, `repos/${repo}/releases?per_page=100`) as { published_at: string | null; draft: boolean }[])
    .filter((r) => !r.draft && r.published_at && when(r.published_at) >= start).length;

  const rows = options.map((o) => priced(o, replay(merged, start, end, o), days, cost));
  const facts = {
    repo, branch, days, merges: merged.length, perDay: day,
    sweep: {
      runs: listed.runs.length, busy: busy.length, quietRuns: quiet.length, unknown: kinds.filter((k) => k.kind === 'unknown').length,
      truncated: listed.truncated, ...cost, quietMeasured: quiet.length > 0,
    },
    pr: pr === null ? null : { runs: prRuns.length, medianJobMinutes: pr, shareOfSweep: pr / cost.full },
    releases: { count: releases, perWeek: (releases * 7) / days },
    options: rows,
  };
  if (values.json) return console.log(JSON.stringify(facts, null, 2));
  console.log(text(facts).join('\n'));
}

const whole = (x: number) => Math.round(x).toLocaleString('en');
const one = (x: number) => (Math.round(x * 10) / 10).toLocaleString('en');

/** The report, as lines. */
export function text(f: {
  repo: string; branch: string; days: number; merges: number; perDay: { mean: number; median: number; busiest: number };
  sweep: { runs: number; busy: number; quietRuns: number; unknown: number; truncated: boolean; quietMeasured: boolean } & Cost;
  pr: { runs: number; medianJobMinutes: number; shareOfSweep: number } | null;
  releases: { count: number; perWeek: number };
  options: readonly Row[];
}): string[] {
  const lines = [
    `${f.repo}, ${f.branch}, the last ${f.days} days: ${whole(f.merges)} merges (first-parent commits), ${one(f.perDay.mean)} a day (median day ${whole(f.perDay.median)}, busiest ${whole(f.perDay.busiest)}).`,
    `A full sweep: ${whole(f.sweep.full)} job-minutes${f.sweep.fullVcpu === null ? '' : `, ${whole(f.sweep.fullVcpu)} vCPU-minutes`}, the median of ${f.sweep.busy} passing runs that ran tests. A slot with nothing new: ${whole(f.sweep.quiet)} job-minutes, ${f.sweep.quietMeasured ? `the median of ${f.sweep.quietRuns} passing runs that ran none` : 'an assumption (--quiet-minutes, on 2 vCPU): the window has no quiet run'}.${f.sweep.unknown ? ` ${f.sweep.unknown} failed or cancelled runs left out.` : ''}${f.sweep.truncated ? ` Only the window's newest ${(runPages * 100).toLocaleString('en')} runs were listed.` : ''}`,
    f.pr === null
      ? 'PR selection: no successful pull request run in the window to compare.'
      : f.pr.shareOfSweep >= 0.95
        ? `PR selection: a PR run's median is ${whole(f.pr.medianJobMinutes)} job-minutes, ${whole(f.pr.shareOfSweep * 100)}% of a full sweep: PRs run about everything, so a sweep finds only what two PRs break together, or what changed outside the repo (job-minutes over ${f.pr.runs} runs, a proxy).`
        : `PR selection: a PR run's median is ${whole(f.pr.medianJobMinutes)} job-minutes, ${whole(f.pr.shareOfSweep * 100)}% of a full sweep, so selection skips about ${whole((1 - f.pr.shareOfSweep) * 100)}% of it (job-minutes over ${f.pr.runs} runs, a proxy). What it skips, the sweep is first to run.`,
    f.releases.count
      ? `Releases: ${f.releases.count} in ${f.days} days, ${one(f.releases.perWeek)} a week. Where the sweep gates the release, a release waits for the next passing sweep.`
      : `Releases: none published in ${f.days} days.`,
    '',
    '| Cadence | Sweeps a month (quiet) | Job-minutes a month | Merges a break can hide, p90 / most | Bisect steps, most |',
    '| --- | --- | --- | --- | --- |',
    ...f.options.map((r) =>
      r.available
        ? `| ${named(r.option)} | ${whole(r.sweepsPerMonth)} (${whole(r.quietPerMonth)}) | ${whole(r.jobMinutesPerMonth)}${r.vcpuMinutesPerMonth === null ? '' : ` (${whole(r.vcpuMinutesPerMonth)} vCPU)`} | ${whole(r.hiddenP90)} / ${whole(r.hiddenMax)} | ${r.bisectMax} |`
        : `| ${named(r.option)} | unavailable: ${r.why} | | | |`,
    ),
    '',
    "Each row replays this window's merges against the sweep template's fixed slots, T hours apart, and its early sweep at N merges; a month is 30 days at the window's rate. Job-minutes count each job's started minutes; price them at your runners' list prices.",
  ];
  return lines;
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(argv.slice(2));
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
