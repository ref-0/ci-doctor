// CI score: what a repo's GitHub data says about its CI, scored 0–100, with what to fix first.
// Copied from ci-score/score.ts. The weights, fixes, notes and guide links are unchanged; what changed is the
// must-fixes': every read goes through `gh` (none from GitHub's unauthenticated raw-file host), a read that fails throws instead of
// reading as empty, a practice that couldn't be checked is null (unknown) rather than false (absent), job logs are
// read in memory and never kept, and nothing is written here: the CLI decides what, if anything, is saved.
import { CliError } from './errors.ts';
import { evidenceOf, outsideConfigs, outsideOn } from './evidence.ts';
import { ApiCache, Gh } from './gh.ts';
import { graphsFixes, graphsOf } from './graphs.ts';
import { graphFixes, jobGraphOf, SETUP_STEP, type ApiJob } from './job-graph.ts';
import { vcpusOf } from './runners.ts';
import { githubSource, localSource, remembered, type Source, type Tree } from './source.ts';
import { historyOf, practices, workflowFiles, type Practices } from './practices.ts';
import { ecosystemOf, stackOf } from './stack.ts';
import { VERSION } from './version.ts';

const DAY = 24 * 3600e3;
const MAX_RUN_PAGES = 10;
const JOB_SAMPLE = 6;
export const GUIDE = 'https://github.com/ref-0/ci-doctor/blob/main/docs/pages/';

// ---------- small helpers ----------

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.max(0, Math.ceil(q * s.length) - 1)]! : NaN;
};
const median = (xs: number[]) => pct(xs, 0.5);
const minutes = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60000;
const seconds = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 1000;
const r1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const share = (n: number, d: number) => (d ? n / d : NaN);
const count = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};
const groupBy = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
};
/** Linear in log(x) between (good, 100) and (bad, 0), clamped. */
const logScore = (x: number, good: number, bad: number) => {
  if (!Number.isFinite(x)) return NaN;
  const t = (Math.log(Math.max(x, 1e-9)) - Math.log(good)) / (Math.log(bad) - Math.log(good));
  return 100 * Math.min(1, Math.max(0, 1 - t));
};
/** Points from anchors [value, points], linear in log(value) between them, clamped at the ends. */
const anchored = (x: number, anchors: [number, number][]) => {
  if (!Number.isFinite(x)) return NaN;
  if (x <= anchors[0]![0]) return anchors[0]![1];
  for (let i = 1; i < anchors.length; i++) {
    const [x0, y0] = anchors[i - 1]!;
    const [x1, y1] = anchors[i]!;
    if (x <= x1) return y0 + ((y1 - y0) * Math.log(x / x0)) / Math.log(x1 / x0);
  }
  return anchors.at(-1)![1];
};
// What a developer feels. 5 minutes is ci-doctor's PR budget; past 8 the score falls fast, so a 20-minute wait reads slow.
// Calibrated 19 Nov against the trusted research labels (calibration.md).
export const WAIT_P50: [number, number][] = [[3, 100], [5, 90], [8, 80], [12, 65], [20, 45], [45, 15], [120, 0]];
export const WAIT_P90: [number, number][] = [[5, 100], [8, 90], [15, 75], [22, 60], [40, 40], [90, 10], [180, 0]];

// S+ for 97 and up, then letters at 90, 75, 60 and 50 with a + on each band's top: A+ 94–96, A 90–93; B+ 85–89, B 75–84;
// C+ 70–74, C 60–69; D+ 57–59, D 50–56. F, under 50, has no sign.
const GRADES: [number, string][] = [[97, 'S+'], [94, 'A+'], [90, 'A'], [85, 'B+'], [75, 'B'], [70, 'C+'], [60, 'C'], [57, 'D+'], [50, 'D']];
export const grade = (score: number | null) => (score === null ? null : (GRADES.find(([from]) => score >= from)?.[1] ?? 'F'));
export const band = (score: number | null) =>
  score === null ? null : score >= 90 ? 'excellent' : score >= 75 ? 'fast' : score >= 50 ? 'ok' : 'slow';

const linScore = (x: number, good: number, bad: number) =>
  Number.isFinite(x) ? 100 * Math.min(1, Math.max(0, 1 - (x - good) / (bad - good))) : NaN;

// ---------- runs: the outcomes ----------

const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);
// Workflows that run on PRs but don't gate a merge; left out of the wait, listed in the report.
const NOT_A_CHECK =
  /claude|codex|copilot|coderabbit|gemini|greptile|sourcery|ai.?review|pr.?review|label|triage|welcome|greet|stale|lock|assign|size|auto-?merge|preview|deploy|benchmark|codspeed|bundle.?(size|analy)|release|publish|cla\b|first.?interaction|backport|comment/i;
// A run that hit its time limit failed, and its hours were CI time: it's red, and its push is timed.
const FAILED = new Set(['failure', 'timed_out']);
const failed = (conclusion: string | null | undefined) => FAILED.has(conclusion ?? '');
const DONE = new Set(['success', ...FAILED]);
const PUSH_WINDOW = 10 * 60e3;
/** Timed PR pushes a score needs. */
export const MIN_TIMED = 5;
const isBotActor = (login = '') => /\[bot\]$|^(renovate|dependabot|github-actions|copilot-swe-agent)/i.test(login);

interface Run {
  id: number;
  name: string;
  path: string;
  event: string;
  head_sha: string;
  head_branch: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  created_at: string;
  updated_at: string;
  run_started_at: string;
  actor?: { login: string };
}

/**
 * One stream of completed runs, such as PR runs or pushes to main, newest first. `from` is where the
 * stream's window starts, and `days` what it covers, to now: from `since` when every run in it was read,
 * and from the oldest run read when GitHub had more than the pages hold. A week with one burst of runs is
 * still a week. With `until`, reading stops once it's back to that time: older runs aren't wanted.
 */
const readRuns = (gh: Gh, repo: string, since: string, filter: string, pages: number, until?: number) => {
  const runs: Run[] = [];
  let total = 0;
  for (let page = 1; page <= pages; page++) {
    const res = gh.json(`repos/${repo}/actions/runs?${filter}&created=%3E%3D${since}&per_page=100&page=${page}&exclude_pull_requests=true`);
    total = res.total_count;
    runs.push(...res.workflow_runs);
    if (res.workflow_runs.length < 100) break;
    if (until !== undefined && Date.parse(runs.at(-1)!.created_at) < until) break;
  }
  const done = runs.filter((r) => r.status === 'completed');
  const from = total > runs.length && runs.length ? Date.parse(runs.at(-1)!.created_at) : Date.parse(since);
  const days = done.length ? (Date.now() - from) / DAY : 0;
  return { runs: done, total, fetched: runs.length, from, days };
};

// A run that sat over an hour before starting was waiting for a maintainer's approval (a fork's PR)
// or an environment, not for CI: its clock starts when it started.
const startOf = (r: Run) =>
  r.run_attempt === 1 && Date.parse(r.run_started_at) - Date.parse(r.created_at) > 60 * 60e3 ? r.run_started_at : r.created_at;

/**
 * A rerun run's first attempt: failed, cancelled or green. One call each, capped per report: past the
 * cap it's null, not read, which `waits` counts at the rate of the reruns that were read.
 */
const firstAttempts = (gh: Gh, repo: string, cap: number) => {
  const seen = new Map<number, string | undefined>();
  return (run: Run): string | null | undefined => {
    if (run.run_attempt === 1) return run.conclusion ?? undefined;
    if (!seen.has(run.id) && seen.size >= cap) return null;
    if (!seen.has(run.id)) seen.set(run.id, gh.json(`repos/${repo}/actions/runs/${run.id}/attempts/1`, { absentOn: [404] })?.conclusion ?? undefined);
    return seen.get(run.id);
  };
};

// A failed first attempt that took over an hour with no jobs never ran: GitHub failed it while it
// waited, such as a fork's run nobody approved, closed days later with its pull request. Its hours
// aren't CI time and its failure isn't a red check. A run that passed did run, so it isn't asked.
// One call each, capped per report.
const ranJobs = (gh: Gh, repo: string, cap: number) => {
  const seen = new Map<number, boolean>();
  return (run: Run): boolean => {
    if (run.conclusion !== 'failure' || run.run_attempt > 1 || Date.parse(run.updated_at) - Date.parse(run.run_started_at) <= 60 * 60e3) return true;
    if (!seen.has(run.id) && seen.size < cap) seen.set(run.id, gh.json(`repos/${repo}/actions/runs/${run.id}/attempts/1/jobs?per_page=1&page=1`).jobs.length > 0);
    return seen.get(run.id) ?? true;
  };
};

/** What tells one workflow from another: its file. Two files can share a name. */
const workflowOf = (r: Run) => r.path || r.name;

/**
 * For each pushed head: the wait from the first workflow's start to the last one's end. The rates are
 * shares of the heads that ran something: a head whose runs were all skipped has no CI to be red or flaky.
 */
const waits = (runs: Run[], first: (run: Run) => string | null | undefined = () => undefined, heavy?: Set<string>, didRun: (run: Run) => boolean = () => true) => {
  const heads = groupBy(runs, (r) => r.head_sha);
  const clean: { sha: string; wait: number; last: Run; red: boolean }[] = [];
  const newest: { sha: string; at: number; wait: number }[] = [];
  let ranHeads = 0;
  let rerunHeads = 0;
  let passedOnRerun = 0;
  let rerunsRead = 0;
  let rerunsUnread = 0;
  let cancelledHeads = 0;
  let redHeads = 0;
  let botHeads = 0;
  let lightHeads = 0;
  let neverRan = 0;
  const bots: string[] = [];
  const redBy: string[] = [];
  for (const [sha, rs] of heads) {
    if (rs.every((r) => isBotActor(r.actor?.login))) bots.push(rs[0]?.actor?.login ?? '');
    // One push starts its runs together. A run created later came from another event, such as a
    // label, a comment or an approval, so it isn't part of this push's wait.
    const started = rs.filter((r) => r.conclusion !== 'skipped' && r.conclusion !== 'neutral' && r.conclusion !== 'action_required');
    const ran = started.filter(didRun);
    neverRan += started.length - ran.length;
    if (!ran.length) continue;
    ranHeads++;
    const pushedAt = Math.min(...ran.map((r) => Date.parse(r.created_at)));
    const counted = ran.filter((r) => Date.parse(r.created_at) - pushedAt <= PUSH_WINDOW);
    const startedAt = counted.map(startOf).sort()[0]!;
    const byBot = counted.every((r) => isBotActor(r.actor?.login));
    const reruns = counted.filter((r) => r.run_attempt > 1);
    // Green only on a rerun: the first attempt failed and the latest passed.
    const firsts = reruns.filter((r) => r.conclusion === 'success').map(first);
    const flaked = firsts.some(failed);
    const unread = !flaked && firsts.some((conclusion) => conclusion === null);
    const red = flaked || counted.some((r) => failed(r.conclusion));
    if (red) {
      redHeads++;
      // Only a green rerun's first attempt is asked for: the reads are few, and no other rerun can have flaked.
      for (const r of counted) if (failed(r.conclusion) || (r.run_attempt > 1 && r.conclusion === 'success' && failed(first(r)))) redBy.push(r.name);
    }
    if (reruns.length) {
      rerunHeads++;
      if (flaked) passedOnRerun++;
      if (unread) rerunsUnread++;
      else if (firsts.length) rerunsRead++;
      continue;
    }
    if (counted.some((r) => r.conclusion === 'cancelled')) {
      cancelledHeads++;
      continue;
    }
    if (!counted.every((r) => DONE.has(r.conclusion ?? ''))) continue;
    const lastRun = counted.reduce((a, b) => (a.updated_at > b.updated_at ? a : b));
    const wait = minutes(startedAt, lastRun.updated_at);
    // Any push a person made can show another CI at work, whichever workflows it ran here.
    if (!byBot) newest.push({ sha, at: Date.parse(startedAt), wait });
    // Time only pushes that ran the real work; a push that ran only quick checks says little.
    if (heavy?.size && !counted.some((r) => heavy.has(workflowOf(r)))) {
      lightHeads++;
      continue;
    }
    // Nobody waits on a bot's push.
    if (byBot) {
      botHeads++;
      continue;
    }
    clean.push({ sha, wait, last: lastRun, red });
  }
  const w = clean.map((c) => c.wait);
  const lastToFinish = count(clean, (c) => workflowOf(c.last));
  const nameOf = (workflow: string) => clean.find((c) => workflowOf(c.last) === workflow)?.last.name ?? workflow;
  // A rerun whose first attempt wasn't read went green on a rerun as often as the ones that were. With
  // none read, how often is unknown.
  const passedOnRerunEstimate = passedOnRerun + (rerunsRead ? (rerunsUnread * passedOnRerun) / rerunsRead : rerunsUnread ? NaN : 0);
  return {
    heads: heads.size,
    ranHeads,
    timed: clean.length,
    p50: pct(w, 0.5),
    p75: pct(w, 0.75),
    p90: pct(w, 0.9),
    redRate: share(redHeads, ranHeads),
    rerunRate: share(rerunHeads, ranHeads),
    passedOnRerunRate: share(passedOnRerunEstimate, ranHeads),
    rerunsUnread,
    cancelledRate: share(cancelledHeads, ranHeads),
    botHeads,
    lightHeads,
    neverRan,
    botPushes: bots.length,
    bots: count(bots, (n) => n).slice(0, 3),
    lastToFinish: lastToFinish.slice(0, 3).map(([workflow, n]) => [nameOf(workflow), n] as [string, number]),
    /** The file of the workflow that most often finishes last, which `lastToFinish` names. */
    lastWorkflow: lastToFinish[0]?.[0],
    redBy: count(redBy, (n) => n).slice(0, 3),
    /** People's finished pushes, newest first, each with when it started and its wait here: the ones whose other checks are read. Not part of the report. */
    newest: newest.sort((a, b) => b.at - a.at),
  };
};

// ---------- jobs: queue, setup, rounding, the critical job, shards ----------

const provider = (labels: string[]) => {
  const l = labels.join(' ').toLowerCase();
  if (l.includes('blacksmith')) return 'Blacksmith';
  if (l.includes('depot')) return 'Depot';
  if (l.includes('namespace') || l.includes('nscloud')) return 'Namespace';
  if (l.includes('buildjet')) return 'BuildJet';
  if (l.includes('warp')) return 'WarpBuild';
  if (l.includes('ubicloud')) return 'Ubicloud';
  if (l.includes('runs-on')) return 'RunsOn';
  if (l.includes('self-hosted')) return 'self-hosted';
  if (/ubuntu|windows|macos/.test(l) && /core|large|xl|arm64|gpu/.test(l)) return 'GitHub larger';
  if (/ubuntu|windows|macos/.test(l)) return 'GitHub-hosted';
  return labels[0] ?? 'unknown';
};

const SHARD = /\b(\d+)\s*\/\s*(\d+)\b|\bshard[\s_-]*(\d+)/i;

interface Job {
  id: number;
  name: string;
  conclusion: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  labels: string[];
  steps?: { name: string; started_at: string | null; completed_at: string | null; conclusion: string | null }[];
}

/** Every job of a run's first attempt, skipped ones too. */
const readAllJobs = (gh: Gh, repo: string, runId: number): Job[] => {
  const jobs: Job[] = [];
  for (let page = 1; page <= 3; page++) {
    const res = gh.json(`repos/${repo}/actions/runs/${runId}/attempts/1/jobs?per_page=100&page=${page}`);
    jobs.push(...res.jobs);
    if (res.jobs.length < 100) break;
  }
  return jobs;
};
const readJobs = (gh: Gh, repo: string, runId: number) => readAllJobs(gh, repo, runId).filter((j) => j.conclusion !== 'skipped' && j.started_at && j.completed_at);

const jobStats = (jobs: Job[]) => {
  const dur = (j: Job) => minutes(j.started_at!, j.completed_at!);
  const runStart = jobs.map((j) => j.created_at).sort()[0]!;
  const runEnd = jobs.map((j) => j.completed_at!).sort().at(-1)!;
  const span = minutes(runStart, runEnd);
  const critical = jobs.reduce((a, b) => (a.completed_at! > b.completed_at! ? a : b));
  const longest = jobs.reduce((a, b) => (dur(a) > dur(b) ? a : b));

  let setup = 0;
  let work = 0;
  let stepped = 0;
  for (const j of jobs) {
    const timed = (j.steps ?? []).filter((s) => s.started_at && s.completed_at);
    if (timed.length) stepped++;
    for (const s of timed) {
      const t = seconds(s.started_at!, s.completed_at!);
      if (SETUP_STEP.test(s.name)) setup += t;
      else work += t;
    }
  }

  // Shard groups: jobs whose names differ only by a shard index.
  const shardGroups = [...groupBy(jobs.filter((j) => SHARD.test(j.name)), (j) => j.name.replace(SHARD, '#'))]
    .filter(([, js]) => js.length >= 2)
    .map(([name, js]) => {
      const t = js.map(dur);
      const max = Math.max(...t);
      return {
        name,
        shards: js.length,
        medianMin: median(t),
        maxMin: max,
        maxOverMedian: max / median(t),
        idleTail: t.reduce((a, x) => a + (max - x), 0) / (max * t.length),
      };
    })
    .sort((a, b) => b.maxMin - a.maxMin);

  return {
    jobs: jobs.length,
    spanMin: span,
    jobMinutes: jobs.reduce((a, j) => a + dur(j), 0),
    billedMinutes: jobs.reduce((a, j) => a + Math.max(1, Math.ceil(dur(j))), 0),
    subMinuteJobs: jobs.filter((j) => dur(j) < 1).length,
    queueSec: jobs.map((j) => seconds(j.created_at, j.started_at!)),
    setupShare: share(setup, setup + work),
    // What a job spends before its own work, whatever that work takes: a share would call a fast job wasteful.
    setupMinPerJob: share(setup / 60, stepped),
    critical: { name: critical.name, id: critical.id, minutes: dur(critical), shareOfSpan: dur(critical) / span },
    longest: { name: longest.name, id: longest.id, minutes: dur(longest) },
    providers: jobs.map((j) => provider(j.labels)),
    shardGroups,
  };
};

// ---------- logs: the slowest test files ----------

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
// What a test file or test's name may hold. Anything else on a matching line is someone's log text, which can
// carry secrets or terminal escapes, so it's never kept, printed or saved.
const TEST_NAME = /^[\w.:@+\/\[\]-]+(?: [\w.:@+\/\[\]-]+)?$/;
const TEST_LINE: [RegExp, (m: RegExpMatchArray) => { file: string; sec: number }][] = [
  // Vitest: ✓ [project] path/to/file.test.ts (12 tests) 345ms
  [/[✓✗×❯]\s+(?:\S+\s+)?(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+\(\d+ tests?[^)]*\)\s+([\d.]+)(ms|s)\b/, (m) => ({ file: m[1]!, sec: +m[2]! / (m[3] === 'ms' ? 1000 : 1) })],
  // Jest: PASS path/to/file.test.ts (5.123 s)
  [/\b(?:PASS|FAIL)\s+(?:\S+\s+)?(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+\(([\d.]+) ?s\)/, (m) => ({ file: m[1]!, sec: +m[2]! })],
  // Go: ok  	pkg/path	1.234s
  [/^\s*(?:ok|FAIL)\s+(\S+)\s+([\d.]+)s\b/, (m) => ({ file: m[1]!, sec: +m[2]! })],
  // nextest: PASS [   1.234s] crate::test, or PASS [   1.234s] (1/9) crate::bin/x test::name
  [/\b(?:PASS|FAIL|SLOW)\s+\[\s*([\d.]+)s\]\s+(?:\(\d+\/\d+\)\s+)?([\w.:\/-]+(?: [\w.:\/-]+)?)\s*$/, (m) => ({ file: m[2]!, sec: +m[1]! })],
  // pytest --durations: 1.23s call     tests/test_x.py::test_y
  [/^\s*([\d.]+)s\s+(?:call|setup|teardown)\s+(\S+)/, (m) => ({ file: m[2]!.split('::')[0]!, sec: +m[1]! })],
];

// A job's log can hold code, paths or secrets: it's read in memory, only the derived timings are kept, and it's
// never cached. An expired or withheld log (403, 404, 410) leaves the test timings unknown.
const slowTests = (gh: Gh, repo: string, jobs: { id: number; name: string }[]) => {
  const files: { file: string; sec: number; job: string }[] = [];
  let read = 0;
  for (const job of jobs) {
    const text = gh.text(`repos/${repo}/actions/jobs/${job.id}/logs`, { absentOn: [403, 404, 410], noCache: true });
    if (text === undefined) continue;
    read++;
    for (const line of text.split('\n')) {
      const clean = line.replace(ANSI, '').replace(/^\S+Z\s/, '');
      for (const [re, f] of TEST_LINE) {
        const m = clean.match(re);
        if (!m) continue;
        const timed = f(m);
        if (TEST_NAME.test(timed.file) && timed.file.length <= 200 && Number.isFinite(timed.sec)) files.push({ ...timed, job: job.name });
        break;
      }
    }
  }
  // A file in two projects or shards counts once, at its slowest.
  const byFile = [...groupBy(files, (f) => f.file)].map(([, fs]) => fs.reduce((a, b) => (a.sec > b.sec ? a : b)));
  byFile.sort((a, b) => b.sec - a.sec);
  return { logsRead: read, filesTimed: byFile.length, over10s: byFile.filter((f) => f.sec > 10).length, top: byFile.slice(0, 5) };
};

// ---------- profile: how big, how busy, how fast it moves ----------

export const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|rs|py|go|vue|svelte|astro|java|kt|kts|scala|c|h|cc|cpp|hpp|cs|swift|rb|php|ex|exs|zig|dart|lua|css|scss)$/i;
// Not the repo's own code: dot-folders (copies of other repos such as .repos/, editor and tool state), vendored and
// third-party code, build output, generated code and patches. t3code's .repos/ alone made its count 7.3M instead of ~2.6M.
export const SKIP = /(^|\/)(\.[^/]+|node_modules|vendor|vendored|third[_-]?party|external|dist|build|out|target|coverage|generated|_generated|__generated__|patches)\/|\.min\.[jt]s$|\.d\.ts$|\.gen\.[a-z]+$|[._-]generated\.[a-z]+$|\.pb\.go$|_pb2\.py$/i;
export const MAX_SOURCE_FILE = 1_000_000; // bigger files are bundles or data, not code people wrote
const INTEGRATION = /(^|\/)(e2e|integration|integration-tests|playwright|cypress|smoke|live)(\/|[._-])|\.(e2e|integration|live|browser|smoke)\.(test|spec)\./i;
const SUPPORT = /(^|\/)(fixtures?|__fixtures__|__mocks__|mocks|testdata|test-?utils|test-?helpers|testing|__snapshots__|snapshots)\/|\.snap$/i;
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rs)$|(^|\/)test_[^/]*\.py$|(^|\/)(tests?|__tests__|spec|specs)\//i;
export const BYTES_PER_LINE = 30; // GitHub's language bytes ÷ lines, measured 28–31 on hono, vite and ruff, 18 Nov 2026

const notExample = (p: string) => !/(^|\/)(examples?|fixtures?|__fixtures__|test|tests|e2e|templates?(-[\w.-]+)?|benchmarks?|playground)\//i.test(p);
const isPackage = (p: string) => notExample(p) && !SKIP.test(p);
/** The workspace's package manifests, as the profile counts them: not examples, fixtures, vendored or generated. */
export const manifestPaths = (tree: Tree) => tree.blobs.map((b) => b.path).filter((p) => ecosystemOf(p) !== undefined && isPackage(p));

const kindOf = (path: string) =>
  INTEGRATION.test(path) ? 'integration' : SUPPORT.test(path) ? 'support' : TEST.test(path) ? 'tests' : 'implementation';

/** What the file tree alone says: lines by kind and packages. Shared by GitHub reads and a local checkout. */
export const treeProfile = (tree: Tree) => {
  const blobs = tree.blobs;
  const code = blobs.filter((b) => CODE_EXT.test(b.path) && !SKIP.test(b.path) && (b.size ?? 0) <= MAX_SOURCE_FILE);
  const bytes = { implementation: 0, tests: 0, integration: 0, support: 0 } as Record<string, number>;
  for (const b of code) bytes[kindOf(b.path)]! += b.size ?? 0;
  const codeBytes = Object.values(bytes).reduce((a, x) => a + x, 0);
  const lines = (n: number) => Math.round(n / BYTES_PER_LINE);
  const manifests = (name: RegExp) => blobs.filter((b) => name.test(b.path) && isPackage(b.path)).length;

  return {
    codeBytes,
    linesOfCode: lines(codeBytes),
    files: blobs.length,
    sourceFiles: code.length,
    treeTruncated: tree.truncated,
    // Shares of counted source by kind, from file sizes in the tree.
    sourceLines: {
      implementation: lines(bytes.implementation!),
      tests: lines(bytes.tests!),
      integration: lines(bytes.integration!),
      support: lines(bytes.support!),
    },
    testShare: share(bytes.tests! + bytes.integration! + bytes.support!, codeBytes),
    packages: {
      npm: manifests(/(^|\/)package\.json$/),
      cargo: manifests(/(^|\/)Cargo\.toml$/),
      go: manifests(/(^|\/)go\.mod$/),
      python: manifests(/(^|\/)(pyproject\.toml|setup\.py)$/),
    },
  };
};

const profileOf = (gh: Gh, repo: string, meta: any, tree: Tree, prRunCount: number, coveredDays: number, since: string) => {
  const { codeBytes, ...fromTree } = treeProfile(tree);
  const lines = (n: number) => Math.round(n / BYTES_PER_LINE);

  const languages = gh.json(`repos/${repo}/languages`) ?? {};
  const langTotal = Object.values(languages).reduce((a: number, x: any) => a + x, 0) as number;

  // Commits on the default branch in the last 28 days, and who wrote them.
  const since28 = new Date(Date.now() - 28 * DAY).toISOString();
  const commits: any[] = [];
  for (let page = 1; page <= 5; page++) {
    // 409: an empty repo has no commits.
    const res = gh.json(`repos/${repo}/commits?sha=${meta.default_branch}&since=${since28}&per_page=100&page=${page}`, { absentOn: [409] }) ?? [];
    commits.push(...res);
    if (res.length < 100) break;
  }
  const authors = new Set(commits.map((c) => c.author?.login ?? c.commit?.author?.email).filter((a) => a && !String(a).endsWith('[bot]')));

  // The year's weekly commits, to see whether it's speeding up.
  // GitHub answers 202 with no body while it computes these; the pace is then unknown.
  const participation = gh.json(`repos/${repo}/stats/participation`)?.all as number[] | undefined;
  const yearWeekly = participation?.length ? participation.reduce((a, x) => a + x, 0) / participation.length : NaN;
  const lastMonthWeekly = participation?.length ? participation.slice(-4).reduce((a, x) => a + x, 0) / 4 : NaN;

  // Merged PRs in the window the runs were read over: how many a week, and opened (or marked ready) to merged.
  const weeks = (Date.now() - Date.parse(since)) / (7 * DAY);
  const merged = mergedPrs(gh, meta.full_name, since);
  const opened = gh.json(`search/issues?q=${encodeURIComponent(`repo:${meta.full_name} is:pr created:>=${since}`)}&per_page=1`);
  const items: any[] = merged?.items ?? [];
  const isBot = (i: any) => i.user?.type === 'Bot' || /\[bot\]$|^(renovate|dependabot)/.test(i.user?.login ?? '');
  const openToMerge = items.filter((i) => i.pull_request?.merged_at && !isBot(i)).map((i) => (Date.parse(i.pull_request.merged_at) - Date.parse(i.created_at)) / 3600e3);
  const botPrs = items.filter(isBot).length;
  const mergedPerWeek = merged ? merged.total_count / weeks : NaN;

  const profile = {
    ageYears: r1((Date.now() - Date.parse(meta.created_at)) / (365 * DAY)),
    stars: meta.stargazers_count,
    forks: meta.forks_count,
    languages: Object.entries(languages).slice(0, 4).map(([l, b]) => [l, Math.round(((b as number) / langTotal) * 100)] as [string, number]),
    ...fromTree,
    // Lines of the repo's own source, from the tree's file sizes. GitHub's language bytes count vendored copies and
    // generated code a repo hasn't marked, so they are only the fallback, when the tree is truncated or empty.
    linesOfCode: !tree.truncated && codeBytes > 0 ? lines(codeBytes) : lines(langTotal),
    linesFrom: !tree.truncated && codeBytes > 0 ? 'tree' : 'languages',
    commitsPerWeek: r1((commits.length / 4) * (commits.length >= 500 ? NaN : 1)) ?? `≥${Math.round(500 / 4)}`,
    commitsPerWeekYear: r1(yearWeekly),
    pace: Number.isFinite(lastMonthWeekly / yearWeekly) ? r1(lastMonthWeekly / yearWeekly) : null,
    activeAuthors28d: commits.length >= 500 ? `≥${authors.size}` : authors.size,
    prsOpenedPerWeek: opened ? r1(opened.total_count / weeks) : null,
    prsMergedPerWeek: r1(mergedPerWeek) ?? NaN,
    botShareOfMergedPrs: r1(share(botPrs, items.length) * 100),
    // People's PRs only: bots' are often merged in minutes.
    openToMergeHours: { p50: r1(median(openToMerge)), p90: r1(pct(openToMerge, 0.9)), n: openToMerge.length },
    prRunsPerDay: r1(prRunCount / Math.max(coveredDays, 0.5)),
    runsPerMergedPr: r1((prRunCount / Math.max(coveredDays, 0.5)) * 7 / mergedPerWeek),
  };

  // The rate as counted, for what's worked out from it: the profile's is rounded for reading.
  return { profile, mergedPerWeek, merged };
};

/** The window's merged pull requests, newest updated first: one page of search, which the profile and the practices share. */
const mergedPrs = (gh: Gh, fullName: string, since: string) =>
  gh.json(`search/issues?q=${encodeURIComponent(`repo:${fullName} is:pr is:merged merged:>=${since}`)}&per_page=100&sort=updated`);

// ---------- score and fixes ----------

export { practices };
export type { Practices };

// The larger of two classes: by code and by PR traffic.
export const sizeClass = (headsPerWeek: number, linesOfCode: number) => {
  const names = ['tiny', 'small', 'medium', 'large'] as const;
  const byTraffic = headsPerWeek < 10 ? 0 : headsPerWeek < 50 ? 1 : headsPerWeek < 250 ? 2 : 3;
  const byCode = linesOfCode < 20_000 ? 0 : linesOfCode < 200_000 ? 1 : linesOfCode < 1_000_000 ? 2 : 3;
  return names[Math.max(byTraffic, byCode)]!;
};

/** A GitHub-hosted Linux runner's vCPUs on a public repo: what a runner of unknown size counts as. */
export const STANDARD_VCPUS = 4;

/**
 * PR CI job minutes in the window, across every workflow file: 3 sampled runs each, scaled by run count.
 * A workflow whose sampled runs ran no job has no minutes to stand for it, and with none measured the
 * minutes are unknown, not zero. The vCPU-minutes are each job's minutes times its runner's vCPUs, so a
 * job that finishes in a quarter of the time on a runner four times the size has used the same.
 */
const ciMinutes = (gh: Gh, repo: string, prRuns: Run[], isPrivate: boolean) => {
  const ran = prRuns.filter((r) => DONE.has(r.conclusion ?? '') || r.conclusion === 'cancelled');
  const byWorkflow = [...groupBy(ran, workflowOf)].sort((x, y) => y[1].length - x[1].length);
  const perRun: number[] = [];
  const billedPerRun: number[] = [];
  const vcpuPerRun: number[] = [];
  let minutes = 0;
  let billed = 0;
  let vcpu = 0;
  let sampledMinutes = 0;
  let sizedMinutes = 0;
  let sampledRuns = 0;
  const sum = (js: Job[]) => js.reduce((acc, j) => acc + minutes_(j.started_at!, j.completed_at!), 0);
  const totals = new Map<string, number>();
  const names = new Map<string, string>();
  for (const [, rs] of byWorkflow.slice(0, 12)) {
    // The 3 runs nearest the workflow's median duration, so a run whose jobs were all skipped, or an
    // unusually long one, doesn't stand for the workflow.
    const length = (r: Run) => Date.parse(r.updated_at) - Date.parse(r.run_started_at);
    const usable = rs.filter((r) => r.run_attempt === 1 && r.conclusion !== 'cancelled').sort((x, y) => length(x) - length(y));
    const mid = Math.floor(usable.length / 2);
    const sample = usable.slice(Math.max(0, mid - 1), mid + 2);
    const jobs = sample.map((r) => readJobs(gh, repo, r.id)).filter((js) => js.length);
    // Its runs are accounted for either way: a workflow whose sampled runs ran no job costs nothing, and
    // isn't charged the minutes of the workflows that did.
    sampledRuns += rs.length;
    if (!jobs.length) continue;
    const dur = (j: Job) => minutes_(j.started_at!, j.completed_at!);
    const m = median(jobs.map((js) => js.reduce((acc, j) => acc + dur(j), 0)));
    const bm = median(jobs.map((js) => js.reduce((acc, j) => acc + Math.max(1, Math.ceil(dur(j))), 0)));
    const vm = median(jobs.map((js) => js.reduce((acc, j) => acc + dur(j) * (vcpusOf(j.labels, isPrivate) ?? STANDARD_VCPUS), 0)));
    // A cancelled run usually stopped partway: count it as half.
    const weight = rs.filter((r) => r.conclusion !== 'cancelled').length + rs.filter((r) => r.conclusion === 'cancelled').length / 2;
    // How much of this workflow's minutes ran on runners of a known size, counted as the minutes are: by its runs.
    const sized = share(sum(jobs.flat().filter((j) => vcpusOf(j.labels, isPrivate) !== null)), sum(jobs.flat()));
    sampledMinutes += m * weight;
    sizedMinutes += (Number.isFinite(sized) ? sized : 0) * m * weight;
    minutes += m * weight;
    totals.set(workflowOf(rs[0]!), m * weight);
    names.set(workflowOf(rs[0]!), rs[0]!.name);
    billed += bm * weight;
    vcpu += vm * weight;
    perRun.push(m);
    billedPerRun.push(bm);
    vcpuPerRun.push(vm);
  }
  // Workflows past the top 12: at the sampled median.
  const rest = ran.length - sampledRuns;
  minutes += rest * (median(perRun) || 0);
  billed += rest * (median(billedPerRun) || 0);
  vcpu += rest * (median(vcpuPerRun) || 0);
  // The workflows that do the real work: the fewest that make up 80% of PR job-minutes.
  const heavy = new Set<string>();
  let covered = 0;
  for (const [name, m] of [...totals].sort((a, b) => b[1] - a[1])) {
    if (covered >= 0.8 * minutes && heavy.size) break;
    heavy.add(name);
    covered += m;
  }
  const measured = perRun.length > 0;
  return {
    jobMinutes: measured ? minutes : NaN,
    billedMinutes: measured ? billed : NaN,
    vcpuMinutes: measured ? vcpu : NaN,
    /** The share of the sampled workflows' job minutes, each counted by its runs, whose runner's size is known; the rest count as standard runners. */
    sizedShare: share(sizedMinutes, sampledMinutes),
    workflows: byWorkflow.length,
    heavy,
    heavyNames: [...new Set([...heavy].map((workflow) => names.get(workflow) ?? workflow))],
  };
};
const minutes_ = (a: string, b: string) => minutes(a, b);

// The p50 wait and the PR CI minutes per merged PR expected of a repo with this many lines, fitted log–log
// over 219 scored repos on 19 Nov (calibration.md). The fits are loose (r² 0.12 each): a fairness adjustment, not a prediction.
/**
 * How a repo's main language moves the wait typical for its size: each language's median wait against the
 * size curve, across the scored repos of 23 Nov 2026 with at least 15 in the language, pulled toward 1 by
 * n / (n + 20), since 15 to 97 repos a language is a loose fit. A language not listed is 1.
 */
export const LANGUAGE_WAIT: Record<string, number> = {
  C: 1.64,
  'C++': 1.49,
  Swift: 1.07,
  Rust: 1.08,
  Java: 0.98,
  TypeScript: 0.96,
  Go: 0.94,
  Python: 0.91,
  'C#': 0.92,
  Kotlin: 0.86,
  Elixir: 0.82,
  JavaScript: 0.79,
  PHP: 0.67,
};

/** The p50 wait typical for a repo of this size, in minutes, and of this main language when it's given. */
export const expectedWait = (linesOfCode: number, language?: string) =>
  Math.max(2, 10.9 * (Math.max(linesOfCode, 1) / 100_000) ** 0.23) * (language !== undefined && Object.hasOwn(LANGUAGE_WAIT, language) ? LANGUAGE_WAIT[language]! : 1);
export const expectedMinutesPerMergedPr = (linesOfCode: number) => Math.max(10, 155 * (Math.max(linesOfCode, 1) / 100_000) ** 0.33);
/** The same curve in vCPU-minutes: it was fitted on job minutes of repos that mostly ran standard runners. */
export const expectedVcpuMinutesPerMergedPr = (linesOfCode: number) => STANDARD_VCPUS * expectedMinutesPerMergedPr(linesOfCode);

/** Kinds of flag a graph can raise: the job graph's three, and the package, entry and task graphs' seven. */
export const PATH_FLAGS = ['top-blocker', 'setup-in-path', 'hidden-wait'];
export const GRAPH_FLAGS = ['package-cycle', 'overloaded-entry', 'root-barrel', 'no-inputs', 'wide-inputs', 'deep-chain', 'task-cycle'];

export interface Inputs {
  p50: number;
  p90: number;
  linesOfCode: number;
  /** The repo's main language, for the size curve. */
  language?: string;
  /** How many of the job graph's three kinds of flag it raised: NaN when the job graph wasn't read. */
  pathFlags: number;
  /** How many kinds of flag the package, entry and task graphs raised: NaN when the repo has none to read, or one came back unknown and clean. */
  graphFlags: number;
  passedOnRerunRate: number;
  mainRedRate: number;
  /** Each job's minutes times its runner's vCPUs, summed, for each merged PR. */
  vcpuMinutesPerMergedPr: number;
  runsPerMergedPr: number;
  /** Minutes a job spends on setup steps, the mean across a run's jobs. */
  setupMinPerJob: number;
  queueP90Sec: number;
  shardIdleTail: number;
}

/** Three parts, each 0–100 from the parts of it that could be measured, weighted into one score. */
export const scoreOf = (o: Inputs) => {
  const parts = {
    // Speed leads: a slow but steady repo shouldn't reach B on reliability and efficiency alone.
    speed: {
      w: 60,
      of: {
        // What people feel: 3 minutes is full marks, 8 is 80, 20 is 45, 120 is zero.
        wait: { w: 20, s: anchored(o.p50, WAIT_P50) },
        // Fair to big repos and slow-building languages: half the wait typical for this size and language is full marks, 2.5× is zero.
        forSize: { w: 15, s: logScore(o.p50 / expectedWait(o.linesOfCode, o.language), 0.5, 2.5) },
        // Light: a p90 many times the p50 is often a wait outside CI, such as an approval gate or a stuck run.
        tail: { w: 5, s: anchored(o.p90, WAIT_P90) },
      },
    },
    // Red PR heads aren't counted: people push failing work in progress, which measures contributors, not CI.
    reliability: {
      w: 20,
      of: {
        flakes: { w: 14, s: linScore(o.passedOnRerunRate, 0.01, 0.12) },
        mainRed: { w: 10, s: linScore(o.mainRedRate, 0.05, 0.4) },
      },
    },
    efficiency: {
      w: 20,
      of: {
        minutesPerPr: { w: 6, s: logScore(o.vcpuMinutesPerMergedPr / expectedVcpuMinutesPerMergedPr(o.linesOfCode), 0.5, 4) },
        runsPerPr: { w: 4, s: logScore(o.runsPerMergedPr, 5, 60) },
        // 30 seconds a job is full marks, 4 minutes is zero.
        setup: { w: 4, s: logScore(o.setupMinPerJob, 0.5, 4) },
        queue: { w: 3, s: logScore(Math.max(o.queueP90Sec, 1), 10, 300) },
        // Only a repo with shards has this one: without them it isn't a measure that's missing.
        shardIdle: { w: 3, s: linScore(o.shardIdleTail, 0.1, 0.4), optional: true },
        // How the jobs are wired: a third off for each of a job that holds the rest, setup on the path, and a
        // wait no job shows. Here and not under speed, where most repos' clean graph would pad a slow wait.
        path: { w: 3, s: linScore(o.pathFlags, 0, PATH_FLAGS.length) },
        // What makes work rerun that didn't need to: a quarter off for each kind of flag on the package, entry and
        // task graphs. Only a repo with such graphs has this one.
        graphs: { w: 3, s: linScore(o.graphFlags, 0, 4), optional: true },
      },
    },
  };
  const sum = (xs: { w: number }[]) => xs.reduce((a, x) => a + x.w, 0);
  const weigh = (xs: { w: number; s: number }[]) => {
    const known = xs.filter((x) => Number.isFinite(x.s));
    const w = sum(known);
    return w ? known.reduce((a, x) => a + x.w * x.s, 0) / w : NaN;
  };
  // How much of the score was measured: each part's weight, by the share of its measures that were made.
  const owed = (part: { of: Record<string, { w: number; s: number; optional?: boolean }> }) => Object.entries(part.of).filter(([, x]) => Number.isFinite(x.s) || !x.optional);
  const measured = sum(Object.values(parts).map((part) => ({ w: (part.w * sum(owed(part).filter(([, x]) => Number.isFinite(x.s)).map(([, x]) => x))) / sum(owed(part).map(([, x]) => x)) }))) / sum(Object.values(parts));
  const scored = Object.fromEntries(Object.entries(parts).map(([k, part]) => [k, { w: part.w, s: weigh(Object.values(part.of)) }])) as Record<keyof typeof parts, { w: number; s: number }>;
  return {
    score: Math.round(weigh(Object.values(scored))),
    parts: Object.fromEntries(Object.entries(scored).map(([k, v]) => [k, Math.round(v.s)])),
    detail: Object.fromEntries(Object.entries(parts).map(([k, part]) => [k, Object.fromEntries(Object.entries(part.of).map(([n, x]) => [n, Number.isFinite(x.s) ? Math.round(x.s) : null]))])),
    /** The share of the score's weight that was measured, 0 to 1, and each measure that wasn't, as `part.measure`. */
    measured,
    missing: Object.entries(parts).flatMap(([k, part]) => owed(part).filter(([, x]) => !Number.isFinite(x.s)).map(([n]) => `${k}.${n}`)),
    /** Each part with none of the measures every repo is owed: one measured only where a repo has the thing, such as shards, doesn't carry a part alone. */
    empty: Object.entries(parts).filter(([, part]) => !owed(part).some(([, x]) => !x.optional && Number.isFinite(x.s))).map(([k]) => k),
  };
};

// The guide has stack pages for these; for any other main language, the report says the fixes apply the principles without one.
const STACK_PAGES = new Set(['TypeScript', 'JavaScript', 'Rust']);
const stackNote = (language: string | undefined) =>
  language && !STACK_PAGES.has(language)
    ? [{ text: `ci-doctor's guides are strongest for TypeScript and Rust. For ${language} it applies the principles, without a ${language}-specific page`, guide: GUIDE + '01-principles.md' }]
    : [];

/** Setup under this share of job time is no fix, however many minutes it is. */
export const SETUP_SLIVER = 0.05;

// A fix for a missing practice shows only when the practice is known to be absent (false), never when unknown (null).
export const fixesOf = (o: any, pr: Practices) => {
  const fixes: { text: string; page: string; weight: number }[] = [];
  const slow = o.wait.p50 > 5;
  const add = (when: unknown, weight: number, text: string | (() => string), page: string) =>
    when && fixes.push({ text: typeof text === "string" ? text : text(), page, weight });

  add(slow && pr.affected === false && pr.pathFilters === false, 9, 'Run only what a change can reach: no path filters or affected-only selection on PR workflows', '04-run-only-what-a-change-can-reach.md');
  add(slow && pr.remoteCache === false && typeof pr.taskRunner === 'string', 8, () => `Share a remote cache for ${pr.taskRunner}: it has none in CI`, '06-reuse-work-by-its-real-inputs.md');
  // Over a minute a job, unless that's a sliver of a long job: a 4-hour job's minute of setup isn't its problem.
  add(o.jobs?.setupMinPerJob > 1 && !(o.jobs.setupShare < SETUP_SLIVER), 7, () => `Each job spends ${o.jobs.setupMinPerJob.toFixed(1)} minutes on setup: cache dependencies and build once`, '06-reuse-work-by-its-real-inputs.md');
  add(o.jobs?.shard && o.jobs.shard.maxOverMedian > 1.25, 7, () => `"${o.jobs.shard.name}": the slowest shard takes ${o.jobs.shard.maxOverMedian.toFixed(2)}× the median, ${Math.round(o.jobs.shard.idleTail * 100)}% idle; balance shards by measured time`, '07-shards-runners-and-billing.md');
  add(slow && !o.jobs?.shard && pr.shardsConfigured === false && o.jobs?.longest.minutes > 8, 6, () => `"${o.jobs?.longest.name}" runs ${Math.round(o.jobs?.longest.minutes)} min in one job: shard it`, '07-shards-runners-and-billing.md');
  add(o.tests?.over10s > 0, 6, () => `${o.tests?.over10s} test file${o.tests?.over10s === 1 ? ' takes' : 's take'} over 10 s; the slowest, ${o.tests?.top[0]?.file}, takes ${Math.round(o.tests?.top[0]?.sec)} s`, '10-slow-tests-the-method.md');
  add(o.wait.passedOnRerunRate > 0.03, 6, () => `${Math.round(o.wait.passedOnRerunRate * 100)}% of PR heads went green only on a rerun: track and fix flakes`, '11-flakes.md');
  add(o.wait.p90 > 2 * o.wait.p50 && o.wait.p90 > 10, 5, () => `p90 is ${(o.wait.p90 / o.wait.p50).toFixed(1)}× p50: find what makes the slow runs slow`, '12-budgets-health-and-spend.md');
  add(o.jobs?.queueP90Sec > 60, 5, () => `Jobs wait ${Math.round(o.jobs.queueP90Sec)} s for a runner at p90${/^GitHub/.test(o.jobs.providers[0]?.[0] ?? '') ? ': GitHub-hosted runners are often slow to start, so price a faster provider' : ''}`, '02-runners-blacksmith-and-the-cost-of-getting-fast.md#when-jobs-wait-to-start');
  add(o.jobs?.subMinuteJobs / o.jobs?.jobs > 0.4 && o.jobs.billedMinutes > 1.5 * o.jobs.jobMinutes && o.jobs.providers[0]?.[0] !== 'GitHub-hosted', 3, () => `${o.jobs?.subMinuteJobs} of ${o.jobs?.jobs} jobs finish in under a minute but bill a whole one: merge them`, '07-shards-runners-and-billing.md');
  add(pr.cancelInProgress === false, 4, 'Cancel superseded PR runs: no concurrency with cancel-in-progress', '04-run-only-what-a-change-can-reach.md');
  add(slow && pr.scheduled === false, 3, 'Move broad checks to a scheduled sweep', '05-tiers-what-runs-where.md');
  fixes.push(...graphFixes(o.jobGraph));
  fixes.push(...graphsFixes(o.graphs));
  add(pr.timeouts === false, 2, 'Set timeout-minutes on jobs', '03-workflow-anatomy.md');
  add(slow && pr.eslint === true && pr.fastLint === false, 2, 'Lint with Oxlint or Biome', '09-workspace-tooling.md');
  add(slow && pr.testRunner === 'jest', 2, 'Jest: consider Vitest', '09-workspace-tooling.md');

  return fixes.sort((a, b) => b.weight - a.weight).map(({ text, page }) => ({ text, guide: GUIDE + page }));
};

// ---------- one repo ----------

// Flags, not fixes: worth knowing, but not a CI problem the measurements show.
const notesOf = (pr: Practices, language: string | undefined) => [
  ...(pr.agentsMd?.length === 0 ? [{ text: 'No AGENTS.md: agents working here have no instructions, such as how to run one test', guide: GUIDE + '15-the-agent-workflow-around-ci.md' }] : []),
  ...stackNote(language),
];

type Flagged = { flags: { kind: string }[]; unknown: string[] };

/**
 * What the graphs' flags come to for the score. A flag found always counts. With none found, a count is 0 only when
 * the graph was read and could have raised one, and unknown otherwise: clean can't be told from unread.
 * - The job graph: unknown when it wasn't read, when no sampled run fits today's workflows, or when part of it is unknown.
 * - The other graphs: unknown when the repo has nothing for them to flag, one package and no cached task, or when the
 *   packages, the tasks or the read as a whole is partly unknown, or an entry is undecided: unread, or one that the
 *   importers not seen could still flag.
 */
export const flagCounts = (graphs: {
  jobs: (Flagged & { count: { runs: number } }) | null;
  packages: Flagged & { count: { nodes: number | null } };
  exports: Flagged & { count: { undecided: number } };
  tasks: Flagged & { count: { cached: number } };
  unknown: string[];
}) => {
  const kinds = (sections: Flagged[], of: string[]) => new Set(sections.flatMap((section) => section.flags.map((flag) => flag.kind)).filter((kind) => of.includes(kind))).size;
  const found = kinds([graphs.packages, graphs.exports, graphs.tasks], GRAPH_FLAGS);
  const flaggable = (graphs.packages.count.nodes ?? 0) > 1 || graphs.tasks.count.cached > 0;
  const unsure = graphs.unknown.length > 0 || graphs.packages.unknown.length > 0 || graphs.tasks.unknown.length > 0 || graphs.exports.count.undecided > 0;
  const path = graphs.jobs ? kinds([graphs.jobs], PATH_FLAGS) : 0;
  const pathRead = graphs.jobs !== null && graphs.jobs.count.runs > 0 && graphs.jobs.unknown.length === 0;

  return {
    pathFlags: path > 0 || pathRead ? path : NaN,
    graphFlags: found > 0 || (flaggable && !unsure) ? found : NaN,
  };
};

const shown = <T extends { newest: unknown }>({ newest: _, ...rest }: T) => rest;

const metaOf = (gh: Gh, repo: string) => {
  const meta = gh.json(`repos/${repo}`, { absentOn: [404] });
  if (!meta)
    throw new CliError(`GitHub has no repo ${repo} that this gh account can see. If it's private, the account needs access to it and the \`repo\` scope (\`gh auth refresh -s repo\`).`);
  return meta;
};
const sinceOf = (days: number) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);

/** One repo's report through this Gh: what `scoreRepo` and the CLI return, without the `read` provenance. */
export const measure = (gh: Gh, repo: string, days: number) => {
  const meta = metaOf(gh, repo);
  const since = sinceOf(days);
  // PR runs and pushes to main are read as separate streams, so a busy repo's bots, schedules and
  // other events don't crowd the PR runs out of the window.
  const prStream = readRuns(gh, repo, since, 'event=pull_request', MAX_RUN_PAGES);
  // Read back as far as the PR runs go, and no further: both streams are counted over the same days.
  const targetStream = readRuns(gh, repo, since, 'event=pull_request_target', MAX_RUN_PAGES, prStream.from);
  const mainStream = readRuns(gh, repo, since, `event=push&branch=${encodeURIComponent(meta.default_branch)}`, 3);
  const from = Math.max(prStream.from, targetStream.from);
  const inWindow = (r: Run) => Date.parse(r.created_at) >= from;
  const runs = [...prStream.runs.filter(inWindow), ...targetStream.runs.filter(inWindow), ...mainStream.runs];
  const total = prStream.total;
  const covered = prStream.runs.length + targetStream.runs.length ? (Date.now() - from) / DAY : 0;

  const prRuns = runs.filter((r) => PR_EVENTS.has(r.event));
  const gating = prRuns.filter((r) => !NOT_A_CHECK.test(r.name));
  const left = [...new Set(prRuns.filter((r) => NOT_A_CHECK.test(r.name)).map((r) => r.name))];
  const ci = ciMinutes(gh, repo, gating, meta.private === true);
  const first = firstAttempts(gh, repo, 25);
  const ranAny = ranJobs(gh, repo, 60);
  const wait = waits(gating, first, ci.heavy, ranAny);
  const allPushes = waits(gating, first, undefined, ranAny);
  const main = waits(runs.filter((r) => r.event === 'push' && r.head_branch === meta.default_branch && !NOT_A_CHECK.test(r.name)));
  const bots = share(runs.filter((r) => r.actor?.login.endsWith('[bot]')).length, runs.length);

  // Jobs of the workflow that most often finishes last.
  const sample = gating
    .filter((r) => workflowOf(r) === wait.lastWorkflow && r.conclusion === 'success' && r.run_attempt === 1)
    .slice(0, JOB_SAMPLE);
  const perRun = sample.map((r) => ({ run: r, jobs: readJobs(gh, repo, r.id) })).filter((x) => x.jobs.length);
  const stats = perRun.map((x) => jobStats(x.jobs));
  const jobs = stats.length
    ? {
        runsSampled: stats.length,
        jobs: Math.round(median(stats.map((s) => s.jobs))),
        spanMin: median(stats.map((s) => s.spanMin)),
        jobMinutes: median(stats.map((s) => s.jobMinutes)),
        billedMinutes: median(stats.map((s) => s.billedMinutes)),
        subMinuteJobs: Math.round(median(stats.map((s) => s.subMinuteJobs))),
        queueP50Sec: pct(stats.flatMap((s) => s.queueSec), 0.5),
        queueP90Sec: pct(stats.flatMap((s) => s.queueSec), 0.9),
        // A run whose steps took no time, or had none timed, has no share or mean: it's left out, not the median.
        setupShare: median(stats.map((s) => s.setupShare).filter(Number.isFinite)),
        setupMinPerJob: median(stats.map((s) => s.setupMinPerJob).filter(Number.isFinite)),
        critical: count(stats, (s) => s.critical.name).slice(0, 1).map(([name]) => ({
          name,
          minutes: median(stats.filter((s) => s.critical.name === name).map((s) => s.critical.minutes)),
          shareOfSpan: median(stats.filter((s) => s.critical.name === name).map((s) => s.critical.shareOfSpan)),
        }))[0]!,
        longest: count(stats, (s) => s.longest.name).slice(0, 1).map(([name]) => ({
          name,
          minutes: median(stats.filter((s) => s.longest.name === name).map((s) => s.longest.minutes)),
        }))[0]!,
        providers: count(stats.flatMap((s) => s.providers), (p) => p).slice(0, 3),
        // The shard group that's the slowest in the most sampled runs, not only in the newest.
        shard: stats.some((s) => s.shardGroups[0])
          ? (() => {
              const name = count(stats.flatMap((s) => s.shardGroups.slice(0, 1)), (g) => g.name)[0]![0];
              const gs = stats.map((s) => s.shardGroups.find((g) => g.name === name)).filter((g) => !!g);
              return {
                name,
                shards: gs[0]!.shards,
                medianMin: median(gs.map((g) => g.medianMin)),
                maxMin: median(gs.map((g) => g.maxMin)),
                maxOverMedian: median(gs.map((g) => g.maxOverMedian)),
                idleTail: median(gs.map((g) => g.idleTail)),
              };
            })()
          : undefined,
      }
    : undefined;

  // Logs of the newest sampled run's critical job and its slowest shard.
  let tests: ReturnType<typeof slowTests> | undefined;
  if (perRun[0]) {
    const s = jobStats(perRun[0].jobs);
    const picks = [s.longest, ...s.shardGroups.slice(0, 1).flatMap((g) => {
      const j = perRun[0]!.jobs.filter((x) => x.name.replace(SHARD, '#') === g.name).sort((a, b) => b.completed_at!.localeCompare(a.completed_at!))[0];
      return j ? [{ id: j.id, name: j.name }] : [];
    })];
    // The job that spends longest in steps named for tests.
    const testTime = (j: Job) =>
      (j.steps ?? []).filter((x) => /test|spec|vitest|jest|pytest|nextest/i.test(x.name) && x.started_at && x.completed_at)
        .reduce((a, x) => a + seconds(x.started_at!, x.completed_at!), 0);
    const testy = perRun[0].jobs
      .filter((j) => testTime(j) > 0)
      .sort((a, b) => testTime(b) - testTime(a))
      .slice(0, 2)
      .map((j) => ({ id: j.id, name: j.name }));
    const uniq = [...new Map([...testy, ...picks].map((j) => [j.id, j])).values()].slice(0, 3);
    tests = slowTests(gh, repo, uniq);
  }

  // Remembered, so the graphs reread the stack's manifests from memory.
  const source = remembered(githubSource(gh, repo, meta.default_branch));
  const { profile, mergedPerWeek, merged } = profileOf(gh, repo, meta, source.tree, prRuns.length, covered, since);
  // The bots' merged pull requests come from the profile's search, remembered: no new call.
  const pr = practices(source, historyOf(merged));
  // Workflow files and the languages answer are remembered from the reads before: no second call.
  const stack = stackOf({
    source,
    manifestPaths: manifestPaths(source.tree),
    workflows: workflowFiles(source),
    languages: gh.json(`repos/${repo}/languages`) === undefined ? undefined : profile.languages,
    packages: profile.packages,
    runners: jobs?.providers,
  });
  // The sampled runs' jobs and the workflow files are remembered from the reads above: no new calls.
  const jobGraph = jobGraphOf(source.read, perRun.map((x) => ({ id: x.run.id, path: x.run.path, jobs: readAllJobs(gh, repo, x.run.id) as ApiJob[] })), meta.private === true);
  // The entry files and task configs: GraphQL blob batches at the tree's ids, counted here.
  const callsBefore = gh.calls;
  const graphs = graphsOf({ source, stack, jobGraph });
  graphs.read.calls = gh.calls - callsBefore;
  const mergedInWindow = (mergedPerWeek * Math.max(covered, 0.5)) / 7;
  const efficiency = {
    prJobMinutesPerDay: r1(ci.jobMinutes / Math.max(covered, 0.5)),
    prBilledMinutesPerDay: r1(ci.billedMinutes / Math.max(covered, 0.5)),
    jobMinutesPerMergedPr: r1(ci.jobMinutes / mergedInWindow),
    prVcpuMinutesPerDay: r1(ci.vcpuMinutes / Math.max(covered, 0.5)),
    vcpuMinutesPerMergedPr: r1(ci.vcpuMinutes / mergedInWindow),
    expectedVcpuMinutesPerMergedPr: r1(expectedVcpuMinutesPerMergedPr(profile.linesOfCode)),
    sizedShare: Number.isFinite(ci.sizedShare) ? Math.round(ci.sizedShare * 100) / 100 : null,
    expectedMinutesPerMergedPr: r1(expectedMinutesPerMergedPr(profile.linesOfCode)),
    expectedWait: r1(expectedWait(profile.linesOfCode, profile.languages[0]?.[0] as string | undefined)),
    workflowsOnPrs: ci.workflows,
  };

  const outcomes = { wait, jobs, tests, jobGraph, graphs };
  const language = profile.languages[0]?.[0] as string | undefined;
  const { score, parts, detail, measured, missing, empty } = scoreOf({
    p50: wait.p50,
    p90: wait.p90,
    linesOfCode: profile.linesOfCode,
    language,
    ...flagCounts(graphs),
    passedOnRerunRate: wait.passedOnRerunRate,
    mainRedRate: main.redRate,
    vcpuMinutesPerMergedPr: ci.vcpuMinutes / mergedInWindow,
    runsPerMergedPr: profile.runsPerMergedPr ?? NaN,
    setupMinPerJob: jobs?.setupMinPerJob ?? NaN,
    queueP90Sec: jobs?.queueP90Sec ?? NaN,
    shardIdleTail: jobs?.shard?.idleTail ?? NaN,
  });

  // Too few timed pushes to say anything: no score, and the report says why.
  const timedEnough = wait.timed >= MIN_TIMED;
  // Then what the score would rest on: other CIs' checks on people's newest pushes, and what went unmeasured.
  const { thin, evidence } = evidenceOf({
    timed: wait.timed,
    p50: wait.p50,
    rerunsUnread: wait.rerunsUnread,
    expectedWait: expectedWait(profile.linesOfCode, language),
    linesOfCode: profile.linesOfCode,
    measured,
    missing,
    empty,
    sizedShare: ci.sizedShare,
    configs: outsideConfigs(source.tree.blobs.map((b) => b.path)),
    treeTruncated: source.tree.truncated,
    // Not asked when there's no score to rest on them: too few timed pushes, or a part with nothing measured.
    outside: timedEnough && !empty.length ? outsideOn(gh, repo, wait.newest) : { sampled: 0, read: 0, pushes: [] },
  });
  const enough = timedEnough && thin === undefined;
  const unscored = timedEnough
    ? thin
    : pr.workflows === 0 && !source.tree.truncated
      ? `There are no GitHub Actions workflows on ${meta.default_branch}, so there's no CI history to score.`
      : prRuns.length === 0
        ? `There were no pull-request runs of GitHub Actions in the last ${days} days.`
        : wait.heads > 0 && wait.botPushes >= 0.8 * wait.heads
          ? `${wait.botPushes} of ${wait.heads} PR pushes in the window came from bots (${wait.bots.map(([name]) => name).join(', ')}), and only pushes people make are timed; ${MIN_TIMED} are needed.`
          : `Only ${wait.timed} PR pushes in the window ran the main workflows; ${MIN_TIMED} are needed.`;

  return {
    repo,
    date: new Date().toISOString().slice(0, 10),
    scorerVersion: VERSION,
    checkout: null,
    defaultBranch: meta.default_branch as string,
    unscored,
    profile,
    window: { days: r1(covered), runs: prStream.runs.length, runsInPeriod: total, truncated: total > prStream.fetched, mainDays: r1(mainStream.days) },
    size: sizeClass((wait.heads / Math.max(covered, 0.5)) * 7, profile.linesOfCode),
    headsPerWeek: Math.round((wait.heads / Math.max(covered, 0.5)) * 7),
    score: enough ? score : null,
    grade: grade(enough ? score : null),
    band: band(enough ? score : null),
    parts: enough ? parts : {},
    detail,
    efficiency,
    evidence: enough ? evidence : { ...evidence, confidence: null, reasons: [] },
    wait: { ...shown(wait), leftOut: left, heavyWorkflows: ci.heavyNames, allPushesP50: allPushes.p50 },
    main: { heads: main.heads, p50: main.p50, p90: main.p90, redRate: main.redRate, redBy: main.redBy },
    botRunShare: bots,
    jobs,
    jobGraph,
    tests,
    practices: pr,
    stack,
    graphs,
    // No workflows: no CI to fix yet, as for a checkout's inventory.
    fixes: pr.workflows === 0 ? [] : fixesOf(outcomes, pr),
    notes: notesOf(pr, profile.languages[0]?.[0] as string | undefined),
    apiCalls: gh.calls,
  };
};

export type Report = ReturnType<typeof measure>;

export interface ScoreOptions {
  /** Days of runs to read, 1 to 90. Default 7. */
  days?: number;
  /** A token to read with, such as a GitHub App's; otherwise gh's sign-in, or GH_TOKEN. */
  token?: string;
  /** Keep and reuse API answers up to 24 hours old in this folder. */
  cacheDir?: string;
}

/** Where a report's numbers came from: live calls, cached answers and any file written. */
export const provenanceOf = (gh: Gh, cacheDir?: string, savedTo?: string) => ({
  calls: gh.calls,
  fromCache: gh.fromCache,
  oldestCachedAt: gh.oldestCachedAt,
  cacheDir,
  savedTo,
});

/** One GitHub repo's report, the object `--json` prints, from code. Reads go through `gh api`. */
export const scoreRepo = (repo: string, { days = 7, token, cacheDir }: ScoreOptions = {}) => {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new CliError('days takes a whole number from 1 to 90.', 2);

  const gh = new Gh(cacheDir ? new ApiCache(cacheDir) : undefined, token);
  const report = measure(gh, repo, days);
  return { ...report, read: provenanceOf(gh, cacheDir) };
};

/**
 * A stored report, the JSON `--json` prints, with its practices, fixes and notes read again from the repo as it is now,
 * and `practicesDate`, the day they were. Everything else is as stored. It reads only what the practices need: the repo,
 * its tree and files, and the window's merged pull requests, one search, over `days` back from now.
 */
export const rereadPractices = <R extends { repo: string | null }>(report: R, { days = 7, token, cacheDir }: ScoreOptions = {}) => {
  if (typeof report.repo !== 'string') throw new CliError("A checkout's report has no GitHub repo to read again.", 2);

  const r = report as any;
  const gh = new Gh(cacheDir ? new ApiCache(cacheDir) : undefined, token);
  const meta = metaOf(gh, report.repo);
  const source = remembered(githubSource(gh, report.repo, meta.default_branch));
  const pr = practices(source, historyOf(mergedPrs(gh, meta.full_name, sinceOf(days))));
  const outcomes = { wait: r.wait ?? {}, jobs: r.jobs, tests: r.tests, jobGraph: r.jobGraph, graphs: r.graphs };

  return {
    ...report,
    practices: pr,
    fixes: pr.workflows === 0 ? [] : fixesOf(outcomes, pr),
    notes: notesOf(pr, r.profile?.languages?.[0]?.[0]),
    practicesDate: new Date().toISOString().slice(0, 10),
  };
};

/** No GitHub history to read: what the checkout's own files say, unscored, with the reason. */
export const inventoryLocal = (root: string, reason: string) => {
  const source = remembered(localSource(root));
  const pr = practices(source);
  const { codeBytes: _, ...profile } = treeProfile(source.tree);
  // A checkout has no GitHub languages or jobs: those stay unknown.
  const stack = stackOf({ source, manifestPaths: manifestPaths(source.tree), workflows: workflowFiles(source), languages: undefined, packages: profile.packages, runners: undefined });
  const graphs = graphsOf({ source, stack });
  graphs.read.calls = 0;

  return {
    repo: null,
    checkout: root,
    date: new Date().toISOString().slice(0, 10),
    unscored: `${reason}.`,
    profile,
    score: null,
    grade: null,
    band: null,
    practices: pr,
    stack,
    graphs,
    // A checkout with no workflows has no CI to fix yet.
    fixes: pr.workflows ? fixesOf({ wait: waits([]), graphs }, pr) : [],
    notes: notesOf(pr, undefined),
  };
};

export type Inventory = ReturnType<typeof inventoryLocal>;

