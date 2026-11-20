#!/usr/bin/env node
/**
 * What: prints where CI's time went, and roughly what it cost, from GitHub's runs and jobs API.
 * Where: run by a person or an agent from a checkout of the repo, before and after a change to CI.
 * Configure: the repo's `.agents/repo/ci-time.json` (SETTINGS below), or the flags that override it. Needs Node 24 and `gh`, logged in
 *   to <org>. With `--bill blacksmith`, also the `blacksmith` CLI and the blacksmith topic's adapter
 *   (references/blacksmith/scripts/blacksmith-bill.ts in the ci-doctor hub). It never reads either CLI's credentials.
 * Tests: `node --test ci-time.test.ts`, from this folder.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * Where CI's time goes: a spot check of recent runs, timed from GitHub's jobs API.
 *
 *   ci-time.ts                 the last 100 runs of the workflow that didn't skip: minutes by job and
 *                              by event, each run's checks span and time to the gate, the job that
 *                              ended last, then the newest large run's shards (large by shard count, a
 *                              heuristic): their slowest files
 *   ci-time.ts --runs 40       the last 40 instead
 *   ci-time.ts --shards <run-id>
 *                              only the shards of run <run-id>
 *   ci-time.ts --repo <owner/name>
 *                              another repo than the one `gh repo view` finds from this folder
 *   ci-time.ts --workflow checks.yml --shard Test --shard E2E
 *                              a repo whose workflow file or sharded jobs aren't named as the settings say,
 *                              as its .agents/repo/ci.md names them: a job whose name starts with a
 *                              --shard prefix is a shard
 *   ci-time.ts --bill blacksmith
 *                              take each job's billed vCPU-minutes from Blacksmith's bill, and each
 *                              shard's CPU from its stats, through the blacksmith topic's adapter
 *
 * It is a diagnostic, not a baseline or a spend audit. It reads the newest runs `gh run list` returns,
 * and each run's latest attempt only; an earlier attempt, a run older than the sample and a job
 * missing from the latest attempt aren't here. A baseline or an audit pages a closed window and reads
 * every attempt, as the speed-up-tests topic's references/ci-history-data.md says.
 *
 * What it prints, exactly:
 * - "checks" is the first job's start to the last non-gate job's end. It leaves out queueing before
 *   the first job, and the gate. "to gate" is the first job's start to the gate job's end, where the
 *   run has one. The job that ended last isn't always the one that limited the run: read the job
 *   graph and each job's steps before naming the limiter.
 * - Cost: each job's started minutes (each job rounds up to a whole minute) times the vCPUs its label
 *   maps to in RUNNERS, or Blacksmith's billed vCPU-minutes with `--bill blacksmith`. The bill counts
 *   every attempt of a run; the minutes count the latest. The header says how many vCPU-minutes came
 *   from a bill, how many are label estimates, and how many jobs neither prices. A money total prints
 *   only when PRICES prices every job's label.
 * - Files: from passing jobs whose name starts with the first shard prefix, the lines Vitest's default
 *   reporter prints for a passing file, `✓ [<project>] <path> (<n> tests) <ms>ms`, for paths that match
 *   TEST_FILE. Another reporter or runner prints nothing here. A log line doesn't say whether the file
 *   ran or a task cache replayed its output, so these are file timings of unknown freshness, from a
 *   large run by shard count. They aren't a whole-suite time, and they aren't proof every file ran.
 *   For fresh, complete timings, use the records collector (scripts/records/ in the playbook).
 *
 * The check that runs this is the hub's references/checks/ci-measure-before-changing-it.md, with the ci-workflows topic.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { argv, env, exit, stderr } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// ---- SETTINGS: your repo's layout and runners, in `.agents/repo/ci-time.json` -----------------------
// The repo owns that file, so updating this script never touches its values. Its template is the
// agent-knowledge skill's templates/repo-facts/ci-time.json. It's read from the folder this
// runs in, or from CI_TIME_SETTINGS; a key it leaves out keeps the default below. Flags override the
// first three. Patterns are regular expressions, as strings.
/** The defaults: the source repo's values, as examples. */
export const DEFAULTS = {
  repo: null as string | null, // "<org>/<repo>"; null reads it from `gh repo view` in this folder
  workflow: 'ci.yml', // the workflow file that runs pull requests' checks
  shards: ['Tests', 'Sandbox'] as readonly string[], // job-name prefixes of sharded jobs; the first is the test shards
  gateJob: 'CI result', // the job that only gathers the others' results; left out of wall time
  largeRunShards: 3, // a passing PR run with at least this many test shards counts as large: a heuristic, not full selection
  // A runner label's vCPUs: [pattern, vCPUs]. A pattern with a group takes the vCPUs from it. First match
  // wins. Check each against your provider's current runner list: hosted defaults change, and a
  // self-hosted label says nothing about its machine until you add it.
  runners: [
    ['(\\d+)vcpu', null], //        Blacksmith: blacksmith-<n>vcpu-ubuntu-2404[-arm]
    ['(\\d+)-cores?', null], //     GitHub's larger runners, when named for their cores
    ['^ubuntu-', 2], //            GitHub-hosted standard Linux (<github-hosted-vcpus>)
    ['^windows-', 2],
    ['^macos-', 3],
  ] as readonly (readonly [string, number | null])[],
  // A runner label's list price per started minute: [pattern, price], first match wins, in your currency.
  // Price each label from your provider's current pricing page; a per-vCPU provider's label costs its
  // vCPUs times the per-vCPU price. Leave it empty to print no money; a total prints only when every
  // job's label is priced.
  prices: [] as readonly (readonly [string, number])[],
  // Test files whose times the shard logs print, as a regular expression over the path.
  testFile: String.raw`\S+\.(?:test|spec)\.[cm]?[jt]sx?`,
};
export type Settings = typeof DEFAULTS;

/** The repo's settings over the defaults; a key the defaults don't have is an error. */
export function readSettings(path = env.CI_TIME_SETTINGS ?? join('.agents', 'repo', 'ci-time.json')): Settings {
  if (!existsSync(path)) return DEFAULTS;
  const given = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const unknown = Object.keys(given).filter((key) => !(key in DEFAULTS));
  if (unknown.length) throw new Error(`${path}: unknown settings ${unknown.join(', ')}`);
  return { ...DEFAULTS, ...given } as Settings;
}

const SETTINGS = readSettings();
export const REPO = SETTINGS.repo;
export const WORKFLOW = SETTINGS.workflow;
export const SHARDS = SETTINGS.shards;
export const GATE_JOB = SETTINGS.gateJob;
export const LARGE_RUN_SHARDS = SETTINGS.largeRunShards;
export const RUNNERS: readonly (readonly [RegExp, number | null])[] = SETTINGS.runners.map(([pattern, vcpus]) => [new RegExp(pattern), vcpus]);
export const PRICES: readonly (readonly [RegExp, number])[] = SETTINGS.prices.map(([pattern, price]) => [new RegExp(pattern), price]);
export const TEST_FILE = SETTINGS.testFile;
// ------------------------------------------------------------------------------------------------------

const ANSI = /\x1b\[[0-9;]*m/g;
// Vitest's default reporter prints a passing file as: ✓ [<project>] <path> (<n> tests) <ms>ms
export const FILE = new RegExp(String.raw`✓ +(?:\S+ +)?(${TEST_FILE}) \((\d+) tests?[^)]*\) +(\d+)ms`, 'g');
const DURATION = /Duration +([0-9.]+)s/;

/** Runs a command and returns its stdout; throws when it fails. */
export type Run = (...args: string[]) => string;
/** Billed vCPU-minutes by run id, then by job name, from an adapter. */
export type Bill = Record<string, Record<string, number>>;
/** A billing adapter, `<provider>-bill.ts`: see the blacksmith topic's blacksmith-bill.ts. */
export type Adapter = {
  billed: (repo: string, workflowName: string, runIds: ReadonlySet<string>, since: number, run: Run) => Bill;
  cpu: (jobId: number | string, run: Run) => string | null;
};
export type Job = {
  id?: number;
  name: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  labels?: readonly string[] | null;
};
export type WorkflowRun = { databaseId: number | string; event: string; conclusion: string; createdAt: string };
export type Row = {
  run: string;
  name: string;
  start: number;
  end: number;
  seconds: number;
  minutes: number;
  vcpuMinutes: number | null;
  fromBill: boolean;
  cost: number | null;
};

export const run: Run = (...args) => {
  const [command = '', ...rest] = args;
  return execFileSync(command, rest, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 1 << 30 });
};

export const when = (stamp: string) => Date.parse(stamp) / 1000;

export const kind = (name: string, shards: readonly string[] = SHARDS) =>
  shards.find((prefix) => name.startsWith(prefix)) ?? name;

/** The vCPUs RUNNERS maps a job's labels to, or null for a label it doesn't know. */
export function vcpus(labels: readonly string[] | null | undefined, runners = RUNNERS): number | null {
  for (const label of labels ?? []) {
    for (const [pattern, count] of runners) {
      const found = pattern.exec(label);
      if (found) return found.length > 1 ? Number.parseInt(found[1] ?? '', 10) : count;
    }
  }
  return null;
}

/** A job's list price per started minute from PRICES, or null for a label it doesn't price. */
export function price(labels: readonly string[] | null | undefined, prices = PRICES): number | null {
  for (const label of labels ?? []) {
    for (const [pattern, amount] of prices) {
      if (pattern.test(label)) return amount;
    }
  }
  return null;
}

/** A job's started minutes: providers that bill per minute round each job up. */
export const billedMinutes = (seconds: number) => (seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : 0);

/**
 * One row a job that ran: its kind, seconds, started minutes, vCPU-minutes and list cost.
 *
 * `bill` maps run id, then job name, to billed vCPU-minutes from an adapter; it wins over the estimate.
 */
export function jobRows(runId: number | string, jobs: readonly Job[], bill?: Bill | null, prices = PRICES): Row[] {
  const rows: Row[] = [];
  for (const job of jobs) {
    if (job.conclusion === 'skipped' || !job.started_at || !job.completed_at) continue;

    const seconds = Math.max(0, when(job.completed_at) - when(job.started_at));
    const minutes = billedMinutes(seconds);
    const cores = vcpus(job.labels);
    const billed = bill?.[String(runId)]?.[job.name];
    const rate = price(job.labels, prices);
    let cost: number | null;
    if (billed !== undefined) cost = rate !== null && cores ? (billed * rate) / cores : null;
    else cost = rate !== null ? minutes * rate : null;

    rows.push({
      run: String(runId), name: job.name, start: when(job.started_at),
      end: when(job.completed_at), seconds, minutes,
      vcpuMinutes: billed !== undefined ? billed : cores ? minutes * cores : null,
      fromBill: billed !== undefined, cost,
    });
  }
  return rows;
}

/**
 * A run's checks span, first start to the last non-gate end; the job that ended last; and the
 * first start to the gate's end, or null without a gate job.
 */
export function wall(rows: readonly Row[], gate = GATE_JOB): { checks: number; last: string; toGate: number | null } {
  const nonGate = rows.filter((r) => r.name !== gate);
  const checks = nonGate.length ? nonGate : rows;
  const gates = rows.filter((r) => r.name === gate);
  const first = Math.min(...rows.map((r) => r.start));
  const last = checks.reduce((a, b) => (b.end > a.end ? b : a));
  return {
    checks: last.end - Math.min(...checks.map((r) => r.start)),
    last: last.name,
    toGate: gates.length ? Math.max(...gates.map((r) => r.end)) - first : null,
  };
}

/** Nearest-rank quantile of a non-empty list. */
export function quantile(values: readonly number[], q: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(q * ordered.length) - 1)] ?? Number.NaN;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? (ordered[middle] ?? 0) : ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

/** vCPU-minutes as printed: whole numbers bare, others to one decimal. */
const vcpuFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, useGrouping: false });
export const vcpu = (x: number) => vcpuFormat.format(x);
const whole = (x: number) => x.toFixed(0);

const percent = (x: number) => `${whole(x * 100)}%`;
const width = (s: string) => [...s].length;
const left = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)));
const right = (s: string | number, n: number) => ' '.repeat(Math.max(0, n - width(String(s)))) + String(s);
const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

/** The spend-by-job and by-event tables, as lines. */
export function report(worked: readonly WorkflowRun[], rows: readonly Row[], shards: readonly string[] = SHARDS): string[] {
  const lines: string[] = [];
  const events = new Map(worked.map((r) => [String(r.databaseId), r.event]));
  const vcpuTotal = sum(rows.map((r) => r.vcpuMinutes ?? 0));
  const fromBill = sum(rows.filter((r) => r.fromBill).map((r) => r.vcpuMinutes ?? 0));
  const unknown = rows.filter((r) => r.vcpuMinutes === null).length;
  const unpriced = rows.filter((r) => r.cost === null).length;
  const money = !unpriced
    ? `; ${sum(rows.map((r) => r.cost ?? 0)).toFixed(2)} at list price`
    : unpriced < rows.length
      ? `; no money total: ${unpriced} of ${rows.length} jobs on labels PRICES doesn't price`
      : '';
  lines.push(`${worked.length} runs from ${worked.at(-1)?.createdAt} to ${worked[0]?.createdAt}, latest attempts: `
    + `${sum(rows.map((r) => r.minutes))} started job-minutes; ${vcpu(vcpuTotal)} vCPU-minutes, `
    + `${vcpu(fromBill)} from a bill (every attempt) and ${vcpu(vcpuTotal - fromBill)} estimated from runner labels`
    + (unknown ? `; ${unknown} jobs on labels RUNNERS doesn't map` : '')
    + money);

  lines.push(`\n${left('job', 34)} ${right('jobs', 5)} ${right('minutes', 8)} ${right('vCPU-min', 9)} ${right('share', 6)} ${right('median s', 9)}`);
  const byKind = new Map<string, Row[]>();
  for (const r of rows) {
    const k = kind(r.name, shards);
    byKind.set(k, [...(byKind.get(k) ?? []), r]);
  }
  const weight = (group: readonly Row[]) => sum(group.map((r) => r.vcpuMinutes || r.minutes));
  for (const [name, group] of [...byKind].sort((a, b) => weight(b[1]) - weight(a[1]))) {
    const billed = sum(group.map((r) => r.vcpuMinutes ?? 0));
    const share = vcpuTotal ? right(percent(billed / vcpuTotal), 6) : right('?', 6);
    lines.push(`${left([...name].slice(0, 34).join(''), 34)} ${right(group.length, 5)} ${right(sum(group.map((r) => r.minutes)), 8)} `
      + `${right(vcpu(billed), 9)} ${share} ${right(whole(median(group.map((r) => r.seconds))), 9)}`);
  }

  lines.push(`\n${left('event', 20)} ${right('runs', 5)} ${right('vCPU-min', 9)} ${right('a run', 6)} ${right('checks p50', 10)} ${right('p90', 5)} `
    + `${right('to gate p50', 11)} ${right('p90', 5)}  ended last`);
  const byRun = new Map<string, Row[]>();
  for (const r of rows) byRun.set(r.run, [...(byRun.get(r.run) ?? []), r]);
  const kinds = new Set([...byRun.keys()].flatMap((r) => (events.has(r) ? [events.get(r) ?? ''] : [])));
  for (const event of [...kinds].sort()) {
    const ids = [...byRun.keys()].filter((r) => events.get(r) === event);
    const billed = sum(ids.flatMap((r) => (byRun.get(r) ?? []).map((j) => j.vcpuMinutes ?? 0)));
    const spans: number[] = [];
    const gated: number[] = [];
    const lasts = new Map<string, number>();
    for (const r of ids) {
      const { checks, last, toGate } = wall(byRun.get(r) ?? []);
      spans.push(checks);
      if (toGate !== null) gated.push(toGate);
      lasts.set(kind(last, shards), (lasts.get(kind(last, shards)) ?? 0) + 1);
    }
    const top = [...lasts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ${n}`).join(', ');
    const gate = gated.length
      ? `${right(whole(quantile(gated, 0.5)), 11)} ${right(whole(quantile(gated, 0.9)), 5)}`
      : `${right('-', 11)} ${right('-', 5)}`;
    lines.push(`${left(event, 20)} ${right(ids.length, 5)} ${right(vcpu(billed), 9)} ${right(whole(billed / ids.length), 6)} `
      + `${right(whole(quantile(spans, 0.5)), 10)} ${right(whole(quantile(spans, 0.9)), 5)} ${gate}  ${top}`);
  }
  lines.push('\nIn seconds, nearest-rank, over each event\'s runs with a job that ran. "checks" is the first job\'s'
    + ' start to the last non-gate job\'s end; "to gate" ends at the gate job\'s end. Neither counts'
    + ' queueing before the first job. The job that ended last isn\'t proof of the limiter.');
  return lines;
}

/** Every job of a run's latest attempt, paged. */
function jobsOf(repo: string, runId: number | string): Job[] {
  const found: Job[] = [];
  for (let page = 1; ; page++) {
    const listed = JSON.parse(run('gh', 'api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`)) as
      { jobs: Job[]; total_count?: number };
    found.push(...listed.jobs);
    if (found.length >= (listed.total_count ?? 0) || !listed.jobs.length) return found;
  }
}

function runs(repo: string, workflow: string, count: number): WorkflowRun[] {
  const listed = JSON.parse(run('gh', 'run', 'list', '--repo', repo, '--workflow', workflow,
    '--limit', String(count * 5), '--json', 'databaseId,event,conclusion,createdAt')) as WorkflowRun[];
  const worked = listed.filter((r) => r.conclusion !== 'skipped').slice(0, count);
  if (worked.length < count) stderr.write(`only ${worked.length} runs of ${workflow} that did work in the last ${count * 5}\n`);
  return worked;
}

/** One test file's time from a shard's log. */
type FileTime = { seconds: number; path: string; tests: number };

/** Slowest first, then by path, so equal times print in a stable order. */
const slowestFirst = (a: FileTime, b: FileTime) => b.seconds - a.seconds || a.path.localeCompare(b.path);

function shards(repo: string, runId: number | string, shardPrefixes: readonly string[], adapter: Adapter | null) {
  const tests = jobsOf(repo, runId).filter((j) => j.name.startsWith(shardPrefixes[0] ?? '') && j.conclusion === 'success');
  if (!tests.length) {
    console.log(`\nrun ${runId} has no passing test shard`);
    return;
  }

  console.log(`\nrun ${runId}'s shards`);
  const files: FileTime[] = [];
  for (const job of [...tests].sort((a, b) => a.name.localeCompare(b.name))) {
    const log = run('gh', 'api', '--allow-escape-sequences', `repos/${repo}/actions/jobs/${job.id}/logs`).replace(ANSI, '');
    const found = [...log.matchAll(FILE)].map((m): FileTime => ({ seconds: Number(m[3]) / 1000, path: m[1] ?? '', tests: Number(m[2]) }));
    files.push(...found);
    const took = DURATION.exec(log);
    const cpu = adapter && job.id !== undefined ? adapter.cpu(job.id, run) : null;
    const [slowest = { seconds: 0, path: 'none', tests: 0 }] = [...found].sort(slowestFirst);
    console.log(`  ${left(job.name, 10)} ${right(found.length, 4)} files, Vitest ${took ? took[1] : '?'} s`
      + `${cpu ? `, ${cpu}` : ''}; slowest ${slowest.path} ${whole(slowest.seconds)} s`);
  }

  const total = sum(files.map((f) => f.seconds));
  if (!total) {
    console.log('\n  no file times in the logs: this reads Vitest\'s default reporter for paths matching TEST_FILE');
    return;
  }
  console.log(`\n  ${files.length} files, ${whole(total)} recorded test-seconds, of unknown freshness: a replayed file can`
    + ' reprint its time, and a file that printed none isn\'t here. The slowest:');
  for (const { seconds, path, tests } of [...files].sort(slowestFirst).slice(0, 12)) {
    console.log(`  ${right(whole(seconds), 6)} s ${right(percent(seconds / total), 4)}  ${path} (${tests} tests)`);
  }
}

/** The newest passing PR run with LARGE_RUN_SHARDS or more test shards: large by shard count only. */
export function newestLargeRun(worked: readonly WorkflowRun[], jobs: ReadonlyMap<string, readonly Job[]>, shardPrefixes: readonly string[] = SHARDS) {
  for (const r of worked) {
    if (r.event !== 'pull_request' || r.conclusion !== 'success') continue;
    const count = (jobs.get(String(r.databaseId)) ?? []).filter((j) => j.name.startsWith(shardPrefixes[0] ?? '')).length;
    if (count >= LARGE_RUN_SHARDS) return r.databaseId;
  }
  return null;
}

/** A billing adapter by name, from --adapter-dir or the hub's topic of that name, beside this one. */
export async function loadAdapter(name: string, folder?: string): Promise<Adapter> {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(folder ? resolve(folder) : resolve(here, '..', '..', name, 'scripts'), `${name}-bill.ts`);
  if (!existsSync(file)) {
    stderr.write(`--bill ${name}: no ${name}-bill.ts found in the ci-doctor hub's ${name} topic; pass --adapter-dir\n`);
    exit(1);
  }
  return (await import(pathToFileURL(file).href)) as Adapter;
}

const USAGE = 'usage: ci-time.ts [--runs <n>] [--shards <run-id>] [--repo <owner/name>] [--workflow <file>]\n'
  + '                  [--shard <prefix>]... [--bill blacksmith] [--adapter-dir <dir>]';
const HELP = `Where CI's time goes: a spot check of recent runs, timed from GitHub's jobs API.

${USAGE}

options:
  --runs <n>             how many of the newest runs that did work to read (default 100)
  --shards <run-id>      only the shards of this run
  --repo <owner/name>    another repo than the one \`gh repo view\` finds from this folder
  --workflow <file>      the workflow file (default ${WORKFLOW})
  --shard <prefix>       a sharded job's name prefix, repeatable; the first is the test shards
  --bill blacksmith      take billed vCPU-minutes and CPU from a provider's adapter
  --adapter-dir <dir>    where the adapter's <provider>-bill.ts is
  -h, --help             print this help

The header of ci-time.ts says exactly what each number is and leaves out.`;

/** A usage error: the reason and the usage on stderr, exit 2. */
function usageError(message: string): never {
  stderr.write(`ci-time.ts: ${message}\n${USAGE}\n`);
  exit(2);
}

export async function main(args: readonly string[]) {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        help: { type: 'boolean', short: 'h' },
        runs: { type: 'string', default: '100' },
        shards: { type: 'string' },
        repo: { type: 'string' },
        workflow: { type: 'string', default: WORKFLOW },
        shard: { type: 'string', multiple: true },
        bill: { type: 'string' },
        'adapter-dir': { type: 'string' },
      },
    });
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
  }
  const { values } = parsed;
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (!/^[1-9]\d*$/.test(values.runs)) usageError(`--runs takes a whole number above 0, not ${JSON.stringify(values.runs)}`);
  const count = Number(values.runs);
  if (values.bill !== undefined && values.bill !== 'blacksmith') {
    usageError(`--bill: no adapter for ${JSON.stringify(values.bill)}; the one provider is blacksmith`);
  }

  const repo = values.repo || REPO || run('gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').trim();
  const shardPrefixes = values.shard?.length ? values.shard : SHARDS;
  const adapter = values.bill ? await loadAdapter(values.bill, values['adapter-dir']) : null;

  if (values.shards) {
    shards(repo, values.shards, shardPrefixes, adapter);
    return;
  }
  const worked = runs(repo, values.workflow, count);
  if (!worked.length) {
    stderr.write(`no runs of ${values.workflow} that did work\n`);
    return;
  }

  const jobs = new Map(worked.map((r) => [String(r.databaseId), jobsOf(repo, r.databaseId)]));
  let bill: Bill | null = null;
  if (adapter) {
    const name = run('gh', 'api', `repos/${repo}/actions/workflows/${values.workflow}`, '--jq', '.name').trim();
    bill = adapter.billed(repo, name, new Set(jobs.keys()), Math.min(...worked.map((r) => when(r.createdAt))) - 3600, run);
  }
  const rows = [...jobs].flatMap(([runId, listed]) => jobRows(runId, listed, bill));
  if (!rows.length) {
    console.log('no job of these runs ran');
    return;
  }
  console.log(report(worked, rows, shardPrefixes).join('\n'));

  const large = newestLargeRun(worked, jobs, shardPrefixes);
  if (large) {
    console.log(`\nthe newest large run by shard count (a heuristic, not proof of full selection): ${large}`);
    shards(repo, large, shardPrefixes, adapter);
  }
}

if (argv[1] === fileURLToPath(import.meta.url)) await main(argv.slice(2));
