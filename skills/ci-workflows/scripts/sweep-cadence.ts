#!/usr/bin/env node
/**
 * What: measures how often a repo merges and what its full sweep costs, from GitHub's API, and prints
 *   sweep schedules to choose from, each a cron, with its monthly job-minutes and the merges a missed
 *   break can hide behind it.
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
 *   node sweep-cadence.ts --slot 02:41                     the slots' time of day, UTC (default: the
 *                                                          repo's sweep workflow's SWEEP_AT or cron)
 *   node sweep-cadence.ts --days 28 --repo <org>/<repo> --workflow ci.yml --branch main
 *   node sweep-cadence.ts --option '41 2 * * 1,4'          a cron to price, beside or instead of the
 *                                                          defaults
 *   node sweep-cadence.ts --json                           the numbers, for a plan
 *
 * The schedules, at the slot's time of day: every 6 hours, every 12 hours, daily, every 2 days
 * (cron's `*` + `/2` days of the month, so a month's last day and the next 1st can run back to back)
 * and weekly on Mondays. Each is a plain cron, the form ci.md records and sweep.yml runs. There's no
 * trigger by merge count, on purpose: the user chooses between schedules by cost and by the merges
 * each can hide.
 *
 * What it measures, exactly:
 * - Merges: first-parent commits on the branch in the window, by committer date, from the commits
 *   API read to its end, and back to the slot before the window's first, which the first slot
 *   checks. A merged pull request is one, as are each commit of a rebase-merge and of a direct push:
 *   the commits a bisect of the branch walks. A window of more than `commitPages` pages is refused.
 * - The slots' time of day: `--slot`, else the `SWEEP_AT` or first single-time cron in the repo's
 *   `--sweep-file` (default `.github/workflows/sweep.yml`), else midnight UTC, and the output says
 *   which.
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
 * Each schedule is replayed over the window's merges at its cron's own slots. A slot with no merge
 * since the last is a quiet one. "Hidden" is the merges a break can sit behind: those since the last
 * slot, at the slot that finds it, and the merges still waiting at the window's end. Bisecting them
 * takes about log2 of that many steps, each merge a step whichever push brought it, as a bisect
 * walks commits. A schedule whose longest gap between slots is more than half the window is marked
 * unavailable: too few slots to price.
 *
 * The check that runs this is the ci-workflows skill's references/tiers.md, "Choosing the sweep's
 * cadence". The user picks the schedule: it's recurring spend.
 */
import { argv, stderr } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { billedMinutes, quantile, run as sh, type Run, SHARDS, vcpus, WORKFLOW, when } from './ci-time.ts';

/** A schedule: a five-field cron, UTC, and its name in words. */
export type Schedule = { readonly cron: string; readonly name: string };

/** The slots' time of day, UTC, and where it came from. */
export type Slot = { readonly hour: number; readonly minute: number; readonly from: string };

/** The schedules priced when none is given, at the slot's time of day. */
export function schedules({ hour, minute }: Slot): Schedule[] {
  const every = (step: number) =>
    Array.from({ length: 24 / step }, (_, i) => (hour % step) + i * step).join(',');
  return [
    { cron: `${minute} ${every(6)} * * *`, name: 'every 6 hours' },
    { cron: `${minute} ${every(12)} * * *`, name: 'every 12 hours' },
    { cron: `${minute} ${hour} * * *`, name: 'daily' },
    { cron: `${minute} ${hour} */2 * *`, name: 'every 2 days' },
    { cron: `${minute} ${hour} * * 1`, name: 'weekly, Mondays' },
  ];
}

/** The most pages of 100 commits it reads; past them, it refuses the window. */
export const commitPages = 100;

/** The most pages of 100 workflow runs it reads, GitHub's limit for a filtered listing. */
export const runPages = 10;

/** One cron field's values, from `*`, `*` + `/n`, `a`, `a-b` and lists of them; null for a bare `*`. */
function field(text: string, low: number, high: number): Set<number> | null {
  if (text === '*') return null;
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`a cron field of ${JSON.stringify(text)} isn't one this reads: use numbers, ranges, lists, * and */n`);
    const from = match[1] === '*' ? low : Number(match[2]);
    const to = match[1] === '*' ? high : match[3] === undefined ? (match[4] === undefined ? from : high) : Number(match[3]);
    const step = match[4] === undefined ? 1 : Number(match[4]);
    if (from < low || to > high || from > to || step < 1) throw new Error(`a cron field of ${JSON.stringify(text)} is out of range`);
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

/** A parsed cron, UTC: each field's values, null where it's `*`. */
export type Cron = { minute: Set<number>; hour: Set<number>; dom: Set<number> | null; month: Set<number> | null; dow: Set<number> | null };

/** Parses a five-field cron, as GitHub's `on.schedule` takes it. */
export function parseCron(text: string): Cron {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`a cron has five fields, not ${JSON.stringify(text)}`);
  const [minute = '', hour = '', dom = '', month = '', dow = ''] = parts;
  const all = (set: Set<number> | null, low: number, high: number) => set ?? new Set(Array.from({ length: high - low + 1 }, (_, i) => low + i));
  return {
    minute: all(field(minute, 0, 59), 0, 59),
    hour: all(field(hour, 0, 23), 0, 23),
    dom: field(dom, 1, 31),
    month: field(month, 1, 12),
    dow: field(dow.replace(/\b7\b/g, '0'), 0, 6),
  };
}

/** Each slot of `cron` after `start` and at most `end`, in seconds since the epoch, in order. */
export function slotsOf(cron: Cron, start: number, end: number): number[] {
  const slots: number[] = [];
  const hours = [...cron.hour].toSorted((a, b) => a - b);
  const minutes = [...cron.minute].toSorted((a, b) => a - b);
  for (let day = Math.floor(start / 86_400) * 86_400; day <= end; day += 86_400) {
    const date = new Date(day * 1000);
    if (cron.month && !cron.month.has(date.getUTCMonth() + 1)) continue;
    // Cron's rule: with both days restricted, either matches.
    const dom = cron.dom?.has(date.getUTCDate());
    const dow = cron.dow?.has(date.getUTCDay());
    if (dom === undefined ? dow === false : dow === undefined ? !dom : !dom && !dow) continue;
    for (const h of hours) for (const m of minutes) {
      const t = day + h * 3600 + m * 60;
      if (t > start && t <= end) slots.push(t);
    }
  }
  return slots;
}

/** The longest gap between a cron's slots, in seconds, over a year from 2026, which has every month's length. */
export function longestGap(cron: Cron): number {
  const from = Date.UTC(2026, 0, 1) / 1000;
  const slots = slotsOf(cron, from - 1, from + 366 * 86_400);
  let most = 0;
  for (let i = 1; i < slots.length; i++) most = Math.max(most, (slots[i] ?? 0) - (slots[i - 1] ?? 0));
  return slots.length < 2 ? Infinity : most;
}

/** The slots' time of day from a sweep workflow's text: its `SWEEP_AT`, else its first cron with one time a day. */
export function slotIn(text: string, from: string): Slot | undefined {
  const at = /^\s*SWEEP_AT:\s*['"]?(\d{1,2}):(\d{2})['"]?/m.exec(text);
  if (at) return { hour: Number(at[1]), minute: Number(at[2]), from: `${from}'s SWEEP_AT` };
  const cron = /^\s*-\s*cron:\s*['"](\d{1,2}) (\d{1,2}) [^'"]*['"]/m.exec(text);
  if (cron) return { hour: Number(cron[2]), minute: Number(cron[1]), from: `${from}'s first cron` };
  return undefined;
}

/** Parses `HH:MM`, UTC. */
export function parseSlot(text: string): Slot {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`--slot takes HH:MM, UTC, such as 02:41, not ${JSON.stringify(text)}`);
  return { hour: Number(match[1]), minute: Number(match[2]), from: '--slot' };
}

/** What a schedule did over the window: its sweeps, the quiet ones, the merges each checked, and those still waiting at its end. */
export type Replay = { readonly sweeps: number; readonly quiet: number; readonly spans: readonly number[]; readonly pending: number };

/**
 * Replays slots over merge times (seconds since the epoch, any order) from `start` to `end`. A merge
 * at a slot's instant is checked by that slot. The first slot checks the merges since `previous`,
 * the slot before the window, so it isn't quiet only because the window started after its merges.
 */
export function replay(merged: readonly number[], slots: readonly number[], start: number, end: number, previous = start): Replay {
  const times = merged.filter((t) => t > Math.min(previous, start) && t <= end).toSorted((a, b) => a - b);
  const spans: number[] = [];
  let next = 0;
  for (const slot of slots.filter((t) => t > start && t <= end).toSorted((a, b) => a - b)) {
    let since = 0;
    while (next < times.length && (times[next] ?? Infinity) <= slot) {
      next += 1;
      since += 1;
    }
    spans.push(since);
  }
  return { sweeps: spans.length, quiet: spans.filter((n) => n === 0).length, spans, pending: times.length - next };
}

/** Whether a window of `days` holds enough of a schedule's slots to price it: twice its longest gap. */
export const observable = (gap: number, days: number) => days * 86_400 >= 2 * gap;

/** Bisect steps to find one break among `merges` merges: about log2 of them, 0 for one or none. */
export const bisectSteps = (merges: number) => (merges <= 1 ? 0 : Math.ceil(Math.log2(merges)));

/** One schedule's row: sweeps and job-minutes a month, and the merges a break can hide behind. */
export type Row =
  | {
      readonly schedule: Schedule;
      readonly available: true;
      readonly sweepsPerMonth: number;
      readonly quietPerMonth: number;
      readonly jobMinutesPerMonth: number;
      readonly vcpuMinutesPerMonth: number | null;
      readonly hiddenP90: number;
      readonly hiddenMax: number;
      readonly bisectMax: number;
    }
  | { readonly schedule: Schedule; readonly available: false; readonly why: string };

/** A sweep's cost, and a quiet slot's, in job-minutes and vCPU-minutes (null where a label is unknown). */
export type Cost = { readonly full: number; readonly fullVcpu: number | null; readonly quiet: number; readonly quietVcpu: number | null };

/** The row for a schedule, scaled from the window's days to 30, or why it can't be priced. */
export function priced(schedule: Schedule, played: Replay, gap: number, days: number, cost: Cost): Row {
  if (!observable(gap, days)) {
    return { schedule, available: false, why: `needs a window of at least ${Math.ceil((2 * gap) / 86_400)} days (--days)` };
  }

  const scale = 30 / days;
  const full = played.sweeps - played.quiet;
  const vcpu = cost.fullVcpu === null || cost.quietVcpu === null ? null : (full * cost.fullVcpu + played.quiet * cost.quietVcpu) * scale;
  const hidden = [...played.spans, played.pending];
  const most = Math.max(...hidden);

  return {
    schedule,
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

/** Merges a day, from merge times over a window of `days`: the mean, the median day and the busiest. */
export function perDay(merged: readonly number[], start: number, days: number) {
  const counts = Array.from({ length: days }, () => 0);
  for (const t of merged) {
    const day = Math.floor((t - start) / 86_400);
    if (day >= 0 && day < days) counts[day] = (counts[day] ?? 0) + 1;
  }
  return { mean: merged.length / days, median: quantile(counts, 0.5), busiest: Math.max(0, ...counts) };
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
  [--slot <HH:MM> | --sweep-file <path>] [--option '<cron>']... [--json]
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
      slot: { type: 'string' },
      'sweep-file': { type: 'string', default: '.github/workflows/sweep.yml' },
      option: { type: 'string', multiple: true },
      json: { type: 'boolean', default: false },
    },
  });
  if (values.help) return console.log(HELP);
  if (!values['sweep-title'] && !values['sweep-event']) throw new Error('name the sweep: --sweep-title <start of its run title>, or --sweep-event push where each push runs everything');
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1) throw new Error(`--days takes a whole number above 0, not ${values.days}`);
  const tests = values['test-job']?.length ? values['test-job'] : SHARDS.slice(0, 1);

  const repo = values.repo || run('gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').trim();
  const branch = values.branch || run('gh', 'api', `repos/${repo}`, '--jq', '.default_branch').trim();
  const end = now;
  const start = end - days * 86_400;

  // The slots' time of day: --slot, else the repo's sweep workflow on the branch, else midnight.
  let slot: Slot | undefined = values.slot === undefined ? undefined : parseSlot(values.slot);
  if (slot === undefined) {
    try {
      slot = slotIn(run('gh', 'api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${values['sweep-file']}?ref=${encodeURIComponent(branch)}`), values['sweep-file']);
    } catch {
      slot = undefined;
    }
  }
  slot ??= { hour: 0, minute: 0, from: `an assumption: no SWEEP_AT or cron in ${values['sweep-file']} on ${branch}, and no --slot` };
  const options = [...(values.option?.length ? [] : schedules(slot)), ...(values.option ?? []).map((cron) => ({ cron, name: cron }))];
  const crons = options.map((o) => parseCron(o.cron));
  const gaps = crons.map(longestGap);

  // Merges from the slot before the window's first, so the first slot counts all it would check.
  const lookback = Math.min(days * 86_400, Math.max(0, ...gaps.filter(Number.isFinite)));
  const read = merges(run, repo, branch, start - lookback);
  const merged = read.filter((t) => t > start);
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

  const rows = options.map((o, i) => {
    const cron = crons[i] as Cron;
    const gap = gaps[i] ?? Infinity;
    const previous = slotsOf(cron, start - Math.min(gap, lookback) - 1, start).at(-1) ?? start;
    return priced(o, replay(read, slotsOf(cron, start, end), start, end, previous), gap, days, cost);
  });
  const facts = {
    repo, branch, days, merges: merged.length, perDay: day, slot,
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
  repo: string; branch: string; days: number; merges: number; perDay: { mean: number; median: number; busiest: number }; slot: Slot;
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
    `Slots at ${String(f.slot.hour).padStart(2, '0')}:${String(f.slot.minute).padStart(2, '0')} UTC, from ${f.slot.from}.`,
    '',
    '| Schedule | Cron | Sweeps a month (quiet) | Job-minutes a month | Merges a break can hide, p90 / most | Bisect steps, most |',
    '| --- | --- | --- | --- | --- | --- |',
    ...f.options.map((r) =>
      r.available
        ? `| ${r.schedule.name} | \`${r.schedule.cron}\` | ${whole(r.sweepsPerMonth)} (${whole(r.quietPerMonth)}) | ${whole(r.jobMinutesPerMonth)}${r.vcpuMinutesPerMonth === null ? '' : ` (${whole(r.vcpuMinutesPerMonth)} vCPU)`} | ${whole(r.hiddenP90)} / ${whole(r.hiddenMax)} | ${r.bisectMax} |`
        : `| ${r.schedule.name} | \`${r.schedule.cron}\` | unavailable: ${r.why} | | | |`,
    ),
    '',
    "Each row replays this window's merges against the cron's own slots; a month is 30 days at the window's rate. Job-minutes count each job's started minutes; price them at your runners' list prices.",
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
