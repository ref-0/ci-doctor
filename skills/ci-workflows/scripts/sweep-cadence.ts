#!/usr/bin/env node
/**
 * What: measures how often a repo merges and what its full sweep costs, from GitHub's API, and prints
 *   sweep cadences to choose from, each "after N merges or T hours, whichever comes first", with its
 *   monthly job-minutes and the most merges a missed break can hide behind it.
 * Where: run by a person or an agent before choosing or changing how often the default branch's
 *   sweep runs. It reads only; it starts, cancels and changes nothing.
 * Configure: runner labels' vCPUs from `.agents/repo/ci-time.json`, as `ci-time.ts` reads them, and
 *   the flags below, as `.agents/repo/ci.md` names the sweep. Needs Node 24 and `gh`, logged in.
 * Tests: `node --test sweep-cadence.test.ts`, from this folder.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 *   node sweep-cadence.ts --sweep-title 'CI on main, '     the sweep's runs by their title's start
 *   node sweep-cadence.ts --sweep-event push               a repo with no sweep: each push to the
 *                                                          default branch runs everything, so a push
 *                                                          run stands in for a sweep's cost
 *   node sweep-cadence.ts --days 28 --repo <org>/<repo> --workflow ci.yml --branch main
 *   node sweep-cadence.ts --option 40:24 --option 0:168    the options to price, merges:hours
 *                                                          (0 merges: by the clock alone)
 *   node sweep-cadence.ts --json                           the numbers, for a plan
 *
 * What it measures, exactly:
 * - Merges: pull requests merged into the branch in the window, from GitHub's search (at most 1,000).
 *   A commit pushed straight to the branch isn't a merge here.
 * - A sweep's cost: the median, over the window's completed sweep runs (newest 10), of each run's
 *   jobs' started minutes, each job rounded up to a whole minute, as ci-time.ts counts them, and
 *   vCPU-minutes from runner labels. A run whose plan found nothing new costs only the jobs it ran;
 *   its median is "a slot with nothing new", or `--quiet-minutes` on 2 vCPU when the window has none.
 * - What PR selection skips: one minus a PR run's median job-minutes over a full sweep's. A proxy:
 *   job-minutes, not test files, and a PR run also replays from caches.
 * - Releases: GitHub releases published in the window. Where the sweep gates the release, a release
 *   waits for the next passing sweep.
 *
 * Each option is replayed over the window's real merges: a sweep starts when N merges have landed
 * since the last, or T hours have passed, whichever comes first, and a sweep with no merge since the
 * last costs a quiet slot's minutes. "Hidden" is the merges a break can sit behind: those since the
 * last sweep, at the sweep that finds it. Bisecting them takes about log2 of that many steps.
 *
 * The check that runs this is the ci-workflows skill's references/tiers.md, "Choosing the sweep's
 * cadence". The user picks the cadence: it's recurring spend.
 */
import { argv, stderr } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { billedMinutes, quantile, run as sh, type Run, vcpus, WORKFLOW, when } from './ci-time.ts';

/** A cadence: sweep after `merges` merges (0: never by count) or `hours` hours, whichever comes first. */
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

/** What an option did over the window: its sweeps, the quiet ones, and the merges each one checked. */
export type Replay = { readonly sweeps: number; readonly quiet: number; readonly spans: readonly number[] };

/**
 * Replays an option over merge times (seconds since the epoch, any order) from `start` to `end`. The
 * window starts just after a sweep. A quiet sweep is a slot with no merge since the last.
 */
export function replay(merged: readonly number[], start: number, end: number, option: Option): Replay {
  const times = merged.filter((t) => t > start && t <= end).toSorted((a, b) => a - b);
  const every = option.hours * 3600;
  const spans: number[] = [];
  let last = start;
  let next = 0; // the first merge no sweep has checked

  for (;;) {
    const nth = option.merges > 0 ? times[next + option.merges - 1] : undefined;
    const at = nth !== undefined && nth < last + every ? nth : last + every;
    if (at > end) break;

    let checked = 0;
    while (next < times.length && (times[next] ?? Infinity) <= at) {
      next += 1;
      checked += 1;
    }
    spans.push(checked);
    last = at;
  }
  const quiet = spans.filter((n) => n === 0).length;

  return { sweeps: spans.length, quiet, spans };
}

/** Bisect steps to find one break among `merges` merges: about log2 of them, 0 for one or none. */
export const bisectSteps = (merges: number) => (merges <= 1 ? 0 : Math.ceil(Math.log2(merges)));

/** One option's row: sweeps and job-minutes a month, and the merges a break can hide behind. */
export type Row = {
  readonly option: Option;
  readonly sweepsPerMonth: number;
  readonly quietPerMonth: number;
  readonly jobMinutesPerMonth: number;
  readonly vcpuMinutesPerMonth: number | null;
  readonly hiddenP90: number;
  readonly hiddenMax: number;
  readonly bisectMax: number;
  readonly waitHours: number;
};

/** A sweep's cost, and a quiet slot's, in job-minutes and vCPU-minutes (null where a label is unknown). */
export type Cost = { readonly full: number; readonly fullVcpu: number | null; readonly quiet: number; readonly quietVcpu: number | null };

/** The row for an option, scaled from the window's days to 30. */
export function priced(option: Option, played: Replay, days: number, cost: Cost): Row {
  const scale = 30 / days;
  const full = played.sweeps - played.quiet;
  const vcpu = cost.fullVcpu === null || cost.quietVcpu === null ? null : (full * cost.fullVcpu + played.quiet * cost.quietVcpu) * scale;
  const spans = played.spans.length ? played.spans : [0];
  const most = Math.max(...spans);

  return {
    option,
    sweepsPerMonth: played.sweeps * scale,
    quietPerMonth: played.quiet * scale,
    jobMinutesPerMonth: (full * cost.full + played.quiet * cost.quiet) * scale,
    vcpuMinutesPerMonth: vcpu,
    hiddenP90: quantile(spans, 0.9),
    hiddenMax: most,
    bisectMax: bisectSteps(most),
    waitHours: option.hours,
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

// ---- Reading GitHub -------------------------------------------------------------------------------

type Listed = { id: number; display_title: string; event: string; conclusion: string | null; created_at: string; head_branch: string };
type Job = { name: string; conclusion: string | null; started_at: string | null; completed_at: string | null; labels: string[] };

const api = (run: Run, path: string) => JSON.parse(run('gh', 'api', path)) as unknown;

/** Each pull request merged into `branch` since `since`, as its merge time in seconds. */
export function merges(run: Run, repo: string, branch: string, since: string): number[] {
  const found: number[] = [];
  for (let page = 1; page <= 10; page++) {
    const query = encodeURIComponent(`repo:${repo} is:pr is:merged base:${branch} merged:>=${since}`);
    const listed = api(run, `search/issues?q=${query}&per_page=100&page=${page}`) as { items: { pull_request?: { merged_at?: string | null } }[] };
    for (const item of listed.items) if (item.pull_request?.merged_at) found.push(when(item.pull_request.merged_at));
    if (listed.items.length < 100) break;
  }
  return found;
}

/** The workflow's completed runs on `branch` since `since`, newest first, up to `pages` of 100. */
function runsOf(run: Run, repo: string, workflow: string, query: string, since: string, pages = 3): Listed[] {
  const found: Listed[] = [];
  for (let page = 1; page <= pages; page++) {
    const listed = api(run, `repos/${repo}/actions/workflows/${workflow}/runs?status=completed&created=%3E%3D${since}&per_page=100&page=${page}${query}`) as { workflow_runs: Listed[] };
    found.push(...listed.workflow_runs);
    if (listed.workflow_runs.length < 100) break;
  }
  return found.filter((r) => r.conclusion !== 'cancelled' && r.conclusion !== 'skipped');
}

/** A run's latest attempt's started job-minutes and vCPU-minutes (null when a label is unknown). */
function costOf(run: Run, repo: string, id: number): { minutes: number; vcpu: number | null; jobs: number } {
  let minutes = 0;
  let vcpu: number | null = 0;
  let jobs = 0;
  for (let page = 1; ; page++) {
    const listed = api(run, `repos/${repo}/actions/runs/${id}/jobs?per_page=50&page=${page}`) as { jobs: Job[]; total_count: number };
    for (const job of listed.jobs) {
      if (job.conclusion === 'skipped' || !job.started_at || !job.completed_at) continue;
      const m = billedMinutes(when(job.completed_at) - when(job.started_at));
      const cores = vcpus(job.labels);
      minutes += m;
      jobs += 1;
      vcpu = vcpu === null || cores === null ? null : vcpu + m * cores;
    }
    if (page * 50 >= listed.total_count || !listed.jobs.length) return { minutes, vcpu, jobs };
  }
}

const HELP = `Usage: node sweep-cadence.ts [--repo <org/repo>] [--workflow <file>] [--branch <name>] [--days <n>]
  (--sweep-title <start> | --sweep-event <event>) [--quiet-minutes <n>] [--option <merges:hours>]... [--json]
Reads only. See this file's header for what each number is.`;

export function main(args: readonly string[], run: Run = sh) {
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

  const repo = values.repo || run('gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').trim();
  const branch = values.branch || run('gh', 'api', `repos/${repo}`, '--jq', '.default_branch').trim();
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 86_400;
  const since = new Date(start * 1000).toISOString().slice(0, 10);

  const merged = merges(run, repo, branch, since).filter((t) => t >= start);
  const day = perDay(merged, start, days);

  const onBranch = `&branch=${encodeURIComponent(branch)}`;
  const sweepRuns = runsOf(run, repo, values.workflow, values['sweep-event'] ? `${onBranch}&event=${values['sweep-event']}` : onBranch, since)
    .filter((r) => !values['sweep-title'] || r.display_title.startsWith(values['sweep-title']))
    .slice(0, 10);
  if (!sweepRuns.length) throw new Error(`no completed sweep run of ${values.workflow} on ${branch} in ${days} days`);
  const costs = sweepRuns.map((r) => costOf(run, repo, r.id));
  // A run that ran no more than its plan and result found nothing new: a quiet slot.
  const busy = costs.filter((c) => c.jobs > 3);
  const quiet = costs.filter((c) => c.jobs <= 3);
  const median = (xs: readonly number[]) => quantile(xs, 0.5);
  const known = (xs: readonly (number | null)[]) => (xs.every((x) => x !== null) ? median(xs as number[]) : null);
  const full = busy.length ? busy : costs;
  const cost: Cost = {
    full: median(full.map((c) => c.minutes)),
    fullVcpu: known(full.map((c) => c.vcpu)),
    quiet: quiet.length ? median(quiet.map((c) => c.minutes)) : Number(values['quiet-minutes']),
    quietVcpu: quiet.length ? known(quiet.map((c) => c.vcpu)) : Number(values['quiet-minutes']) * 2,
  };

  const prRuns = runsOf(run, repo, values.workflow, '&event=pull_request', since, 1).filter((r) => r.conclusion === 'success').slice(0, 20);
  const pr = prRuns.length ? median(prRuns.map((r) => costOf(run, repo, r.id).minutes)) : null;

  const releases = (api(run, `repos/${repo}/releases?per_page=100`) as { published_at: string | null; draft: boolean }[])
    .filter((r) => !r.draft && r.published_at && when(r.published_at) >= start).length;

  const rows = options.map((o) => priced(o, replay(merged, start, end, o), days, cost));
  const facts = {
    repo, branch, days, merges: merged.length, perDay: day,
    sweep: { runs: sweepRuns.length, busy: busy.length, quietRuns: quiet.length, ...cost, quietMeasured: quiet.length > 0 },
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
  sweep: { runs: number; busy: number; quietRuns: number; quietMeasured: boolean } & Cost;
  pr: { runs: number; medianJobMinutes: number; shareOfSweep: number } | null;
  releases: { count: number; perWeek: number };
  options: readonly Row[];
}): string[] {
  const lines = [
    `${f.repo}, ${f.branch}, the last ${f.days} days: ${whole(f.merges)} merged pull requests, ${one(f.perDay.mean)} a day (median day ${whole(f.perDay.median)}, busiest ${whole(f.perDay.busiest)}).`,
    `A full sweep: ${whole(f.sweep.full)} job-minutes${f.sweep.fullVcpu === null ? '' : `, ${whole(f.sweep.fullVcpu)} vCPU-minutes`}, the median of ${f.sweep.busy || f.sweep.runs} runs. A slot with nothing new: ${whole(f.sweep.quiet)} job-minutes, ${f.sweep.quietMeasured ? `the median of ${f.sweep.quietRuns} runs` : 'an assumption (--quiet-minutes, on 2 vCPU): the window has no quiet run'}.`,
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
    ...f.options.map((r) => `| ${named(r.option)} | ${whole(r.sweepsPerMonth)} (${whole(r.quietPerMonth)}) | ${whole(r.jobMinutesPerMonth)}${r.vcpuMinutesPerMonth === null ? '' : ` (${whole(r.vcpuMinutesPerMonth)} vCPU)`} | ${whole(r.hiddenP90)} / ${whole(r.hiddenMax)} | ${r.bisectMax} |`),
    '',
    'Each row replays this window\'s merges; a month is 30 days at the window\'s rate. Job-minutes count each job\'s started minutes; price them at your runners\' list prices.',
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
