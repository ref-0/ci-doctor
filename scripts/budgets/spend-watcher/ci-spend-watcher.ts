#!/usr/bin/env node
/**
 * What: CI's spend cap on Blacksmith: reads the month's spend each minute, warns, and at the cap
 *   reports or stops CI.
 *
 *     ci-spend-watcher.ts check            the month's spend against the warning and the cap, CI's
 *                                          state and the watcher's last reading
 *     ci-spend-watcher.ts cap <usd> [--warn <usd>]
 *                                          a new cap, on a maintainer's word, warning at 85% of it
 *                                          unless given. The watcher turns CI back on at its next
 *                                          reading if the spend is under it
 *     ci-spend-watcher.ts enable           turns back on the workflows the watcher turned off, if
 *                                          the spend is under the cap
 *     ci-spend-watcher.ts watch            the watcher loop, run by the systemd user service
 *     ci-spend-watcher.ts install          links this file as ~/.local/bin/ci-spend-watcher and
 *                                          (re)starts the service
 *
 * Where: on a maintainer's always-on machine, as a systemd user service (ci-spend-watcher.service).
 *   Needs Node 24, `blacksmith` (logged in to the org) and `gh` (logged in as a maintainer with
 *   admin on the watched repos, and able to dispatch the alert workflow).
 * Configure: ~/.config/ci-spend-watcher/config.json, see config.example.json. There is no default
 *   cap: the watcher refuses to run until a maintainer sets one.
 * Tests: `node --test ci-spend-watcher.test.ts`, from this folder.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * Two modes, by `mode` in the config. `report`, the default, only warns and tells at the cap: start
 * there. `stop` disables workflows at the cap, and only those `stop_workflows` names, by file name
 * (`ci.yml`), or `["*"]` for every workflow, written out on purpose. Leave release, security and
 * recovery workflows off that list. Turn `stop` on only after the user approves it and a drill: set a
 * cap under this month's spend, see the stop and the alert, then `cap` back and see CI come back on.
 * The watcher tries to stop CI when the reported spend reaches the cap; reporting lag and cancelling
 * take time, so leave headroom between the cap and what you can afford. This prices Blacksmith only:
 * on GitHub-hosted runners, start with GitHub's own budgets and alerts instead.
 *
 * The spend is Blacksmith's own figure, from `blacksmith usage`, at list price for the whole
 * organization. Blacksmith's own spend limit counts list price too, and past it every job queues
 * without a runner and nothing says why. So keep the provider's limit a little ABOVE the cap here:
 * this watcher stops CI cleanly first.
 *
 * At the warning and at the stop, the watcher queues a comment for the open budget issue in the alerts
 * repo, and sends it by dispatching that repo's alert workflow (ci-budget-alert.yml), so the comment
 * comes from github-actions[bot] and its @mention notifies the maintainer: GitHub doesn't notify anyone
 * of their own comments, and `gh` here is the maintainer's. Once it has warned, it reads the issue each
 * minute, and a comment from an approver that says only `/cap <usd>` sets a new cap, as `cap` does.
 *
 * Blacksmith's CLI can't turn CI off, so the stop goes through GitHub: it disables each active listed
 * workflow in each watched repo, cancels their queued and running runs, and checks that every listed
 * workflow reads disabled, reading every page of both lists. A run still active at the next check of
 * the stop fails it. It remembers which workflows it disabled, so recovery re-enables exactly those. A stop
 * that fails is reported once and tried again each minute: in production one failed silently and CI
 * ran on, which is why the stop is verified. While stopped, it re-checks every ENFORCE_EVERY minutes
 * that the stop still holds (someone may re-enable a workflow by hand).
 */
import { spawnSync } from 'node:child_process';
import {
  accessSync, chmodSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, statSync, symlinkSync, unlinkSync, writeFileSync, closeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { argv, env, exit, stderr } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseCommandLine } from 'node:util';

// ---------------------------------------------------------------------------------------------
// CONFIG: the watcher's own settings. The repos, cap and approvers are in config.json.
// ---------------------------------------------------------------------------------------------

/** Where the config and the watcher's state live. Tests point these elsewhere. */
export const paths = {
  CONFIG: join(homedir(), '.config/ci-spend-watcher/config.json'),
  STATE: join(homedir(), '.local/state/ci-spend-watcher.json'),
};
export const SERVICE = 'ci-spend-watcher';
export const TICK = 60; // seconds between readings
export const ENFORCE_EVERY = 5; // minutes between checks that a stop still holds
export const SILENT_READS = 600; // seconds of failed reads before the maintainer hears of it
export const WARN_RATIO = 0.85; // the warning, as a share of the cap, when `cap` isn't given one
const APPROVE = /^\/cap\s+\$?(\d+(?:\.\d+)?)$/;
const RUNNING = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];
const ISSUE_BODY =
  "The CI spend watcher on a maintainer's machine comments here when CI's spend on Blacksmith " +
  'reaches its warning or its cap.\n\n' +
  'To set a new cap, reply with a comment that says only `/cap <usd>`. ' +
  'If CI is stopped, the watcher turns it back on once the spend is under the new cap.';
// The unit's PATH (ci-spend-watcher.service), which must reach `node` for the link's shebang.
const UNIT_PATH = ['.local/bin', '/usr/local/bin', '/usr/bin', '/bin'];

// ---------------------------------------------------------------------------------------------

export type State = {
  month?: string;
  warned?: boolean;
  reported?: boolean;
  stopped?: string | null;
  disabled?: Record<string, number[]>;
  lingering?: number[];
  outbox?: string[];
  issue?: number;
  owner?: string;
  seen_comment?: number;
  failing_since?: string;
  read_error?: string;
  told_failing?: boolean;
  stop_failing?: boolean;
  start_failing?: boolean;
  spend?: number;
  read_at?: string;
};

export type Config = {
  repos: string[];
  alerts_repo: string;
  cap: unknown;
  warn?: unknown;
  alert_workflow: string;
  issue_title: string;
  approvers: string[];
  mode: string;
  stop_workflows: string[];
  set_at?: string;
};

type Workflow = { id: number; name: string; path?: string; state: string };
type Run = { id: number; workflow_id?: number };
type Issue = { number: number; title: string; state?: string; pull_request?: unknown };
type Comment = { id: number; user: { login: string }; body: string };

/** An exit with a message on stderr and a code, as `main` prints and returns it. */
export class Exit extends Error {
  code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

/** Runs a command, returns its stdout, and throws with its stderr when it fails. */
function run(...cmd: string[]): string {
  const p = spawnSync(cmd[0] ?? '', cmd.slice(1), {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 1 << 29, // `--paginate --slurp` of every run can pass the 1 MiB default
    env: { ...env, BLACKSMITH_DISABLE_AUTO_UPDATE: '1' },
  });
  const name = cmd.slice(0, 3).join(' ');
  if (p.error) {
    const timedOut = (p.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    throw new Error(`${name}: ${timedOut ? 'timed out after 120 seconds' : p.error.message}`);
  }
  if (p.status !== 0) throw new Error(`${name}: ${(p.stderr || p.stdout).trim().slice(0, 400)}`);
  return p.stdout;
}

function gh(...args: string[]): any {
  const out = io.run('gh', 'api', ...args);
  return out.trim() ? JSON.parse(out) : null;
}

/** The organization's Blacksmith spend since the month began, in USD at list price. */
function spend(now: Date): number {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const out = io.run('blacksmith', 'usage', '--start-time', stamp(start), '--end-time', stamp(now), '--format', 'json');
  const summary: Record<string, unknown> = JSON.parse(out)?.summary || {};
  if (!('cost_usd' in summary)) {
    throw new Error(`blacksmith usage printed no summary.cost_usd: summary keys ${JSON.stringify(Object.keys(summary).sort())}`);
  }
  return usdOf(summary['cost_usd']);
}

/** The watcher's side effects, swapped out by the tests. */
export const io = { run, gh, spend, now: (): Date => new Date() };

function log(text: string): void {
  console.log(text);
}

function load(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}

function save(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}

/**
 * Runs `body` on the state under an exclusive lock, and saves the state if `body` returns.
 * Node has no flock, so the lock is a file made with O_EXCL that holds its owner's pid; one whose
 * owner is gone (a killed watcher) is taken over.
 */
export function locked<T>(body: (state: State) => T): T {
  mkdirSync(dirname(paths.STATE), { recursive: true });
  const lock = `${paths.STATE}.lock`;
  acquire(lock);
  try {
    const state: State = load(paths.STATE);
    const out = body(state);
    save(paths.STATE, state);
    return out;
  } finally {
    try {
      unlinkSync(lock);
    } catch {}
  }
}

function acquire(lock: string): void {
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }

    let pid = 0;
    try {
      pid = Number.parseInt(readFileSync(lock, 'utf8'), 10);
    } catch {
      continue; // released meanwhile
    }
    if (!alive(pid)) {
      try {
        unlinkSync(lock);
      } catch {}
      continue;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

function alive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The maintainer's settings. Repos, the alerts repo and the cap are required. */
export function config(): Config {
  const c = load(paths.CONFIG);
  const missing = ['repos', 'alerts_repo', 'cap'].filter((k) => !given(c[k]));
  if (missing.length) throw new Error(`${paths.CONFIG} lacks ${missing.join(', ')}: see config.example.json`);

  const defaults = { alert_workflow: 'ci-budget-alert.yml', issue_title: 'CI budget', approvers: [], mode: 'report', stop_workflows: [] };
  for (const [k, v] of Object.entries(defaults)) if (!(k in c)) c[k] = v;
  if (c.mode !== 'report' && c.mode !== 'stop') throw new Error(`${paths.CONFIG}: mode is report or stop, not ${shown(c.mode)}`);
  if (c.mode === 'stop' && !given(c.stop_workflows)) {
    throw new Error(`${paths.CONFIG}: mode stop needs stop_workflows: the workflow files to stop, or ["*"]`);
  }
  return c;
}

export function limits(): [cap: number, warn: number] {
  const c = config();
  try {
    const cap = usdOf(c.cap);
    const warn = usdOf(given(c.warn) ? c.warn : defaultWarn(cap));
    return [cap, warn];
  } catch {
    throw new Error(`${paths.CONFIG}: cap and warn must be numbers in USD, not ${shown(c.cap)} and ${shown(c.warn)}`);
  }
}

/** The warning for `cap` when none is given: WARN_RATIO of it, to the cent. */
function defaultWarn(cap: number): number {
  return Math.round(cap * WARN_RATIO * 100) / 100;
}

function setCap(state: State, cap: number, warn?: number): [number, number] {
  warn = warn === undefined ? defaultWarn(cap) : warn;
  save(paths.CONFIG, { ...load(paths.CONFIG), cap, warn, set_at: io.now().toISOString() });
  state.warned = state.reported = false;
  return [cap, warn];
}

/** Every item of a paged list: `gh api --paginate --slurp` returns one object per page. */
function pages<T>(path: string, key: string): T[] {
  const got = io.gh('--paginate', '--slurp', path);
  return (Array.isArray(got) ? got : [got]).flatMap((page: Record<string, T[]>) => page[key] ?? missingKey(key));
}

function missingKey(key: string): never {
  throw new Error(`gh api returned a page without '${key}'`);
}

function workflows(repo: string): Workflow[] {
  return pages(`repos/${repo}/actions/workflows?per_page=100`, 'workflows');
}

/** Whether the stop takes this workflow: its file name is in stop_workflows, or that holds "*". */
function listed(w: Workflow): boolean {
  const names = config().stop_workflows;
  return names.includes('*') || names.includes((w.path ?? '').split('/').at(-1) ?? '');
}

function activeRuns(repo: string, ids: Set<number>): number[] {
  return RUNNING.flatMap((status) =>
    pages<Run>(`repos/${repo}/actions/runs?status=${status}&per_page=100`, 'workflow_runs')
      .filter((r) => r.workflow_id !== undefined && ids.has(r.workflow_id))
      .map((r) => r.id),
  );
}

/** Disables each active listed workflow, cancels its queued and running runs, and checks both. */
export function stop(state: State): void {
  const disabled = (state.disabled ??= {});
  const lingering = new Set(state.lingering ?? []);
  state.lingering = [];
  for (const repo of config().repos) {
    const flows = workflows(repo).filter(listed);
    for (const w of flows) {
      if (w.state === 'active') {
        io.gh('-X', 'PUT', `repos/${repo}/actions/workflows/${w.id}/disable`);
        disabled[repo] = [...new Set([...(disabled[repo] ?? []), w.id])].sort((a, b) => a - b);
      }
    }

    const ids = new Set(flows.map((w) => w.id));
    for (const runId of activeRuns(repo, ids)) {
      try {
        io.gh('-X', 'POST', `repos/${repo}/actions/runs/${runId}/cancel`);
      } catch (e) {
        if (!message(e).includes('HTTP 409')) throw e; // it finished meanwhile
      }
    }

    const still = workflows(repo).filter((w) => ids.has(w.id) && w.state === 'active').map((w) => w.name);
    if (still.length) throw new Error(`${repo}: still active after disabling: ${still.join(', ')}`);
    // A cancel takes a while to land, so a run still active now is checked at the next hold.
    const left = activeRuns(repo, ids);
    state.lingering.push(...left);
    const stuck = [...new Set(left.filter((id) => lingering.has(id)))].sort((a, b) => a - b);
    if (stuck.length) throw new Error(`${repo}: runs still active after cancelling: ${stuck.join(', ')}`);
  }
}

/** Turns back on exactly the workflows the watcher turned off, and checks each reads active. */
function start(state: State): void {
  for (const [repo, ids] of Object.entries(state.disabled ?? {})) {
    for (const wid of ids) io.gh('-X', 'PUT', `repos/${repo}/actions/workflows/${wid}/enable`);

    const off = workflows(repo).filter((w) => ids.includes(w.id) && w.state !== 'active').map((w) => w.name);
    if (off.length) throw new Error(`${repo}: still disabled after enabling: ${off.join(', ')}`);
  }
  state.disabled = {};
  state.stopped = null;
}

function owner(state: State): string {
  if (!state.owner) state.owner = io.run('gh', 'api', 'user', '-q', '.login').trim();
  return state.owner;
}

function approvers(state: State): Set<string> {
  const listed = config().approvers;
  return new Set(listed.length ? listed : [owner(state)]);
}

/** The open budget issue in the alerts repo, opened if there's none. */
function issue(state: State): number {
  const c = config();
  const alerts = c.alerts_repo;
  let number = state.issue;
  if (number && io.gh(`repos/${alerts}/issues/${number}`).state === 'open') return number;

  const mine: Issue[] = io.gh(`repos/${alerts}/issues?state=open&creator=${owner(state)}&per_page=100`);
  const found = mine.filter((i) => i.title === c.issue_title && !('pull_request' in i)).map((i) => i.number);
  number = found[0] ?? io.gh(`repos/${alerts}/issues`, '-f', `title=${c.issue_title}`, '-f', `body=${ISSUE_BODY}`).number as number;
  state.issue = number;
  return number;
}

/** Queues a comment for the maintainer. `deliver` sends it, and keeps it while sending fails. */
function tell(state: State, text: string): void {
  log(text);
  (state.outbox ??= []).push(text);
}

export function deliver(state: State): void {
  const c = config();
  while (state.outbox?.length) {
    const number = issue(state);
    io.run('gh', 'workflow', 'run', c.alert_workflow, '-R', c.alerts_repo,
      '-f', `issue=${number}`, '-f', `body=@${owner(state)} ${state.outbox[0]}`);
    state.outbox.shift();
  }
}

/** Sets the cap from an approver's newest `/cap <usd>` comment that the watcher hasn't read yet. */
function approve(state: State): void {
  if (!state.issue) return;
  const alerts = config().alerts_repo;
  const seen = state.seen_comment ?? 0;
  const allowed = approvers(state);
  let approved: number | undefined;
  const comments: Comment[] = io.gh(`repos/${alerts}/issues/${state.issue}/comments?per_page=100&since=${state.month}-01T00:00:00Z`);
  for (const c of comments) {
    if (c.id <= seen) continue;
    state.seen_comment = Math.max(state.seen_comment ?? 0, c.id);
    const m = APPROVE.exec(c.body.trim());
    if (m?.[1] && allowed.has(c.user.login)) approved = Number(m[1]);
  }
  if (approved === undefined) return;

  const [cap, warn] = setCap(state, approved);
  io.gh(`repos/${alerts}/issues/${state.issue}/comments`, '-f',
    `body=Cap set to ${whole(cap)}, warning at ${whole(warn)}. If CI is stopped and the spend is under it, it turns back on within a minute.`);
  log(`cap set to ${whole(cap)} by an approver's comment`);
}

/** Runs `action`, and tells the maintainer `failure` once while it keeps failing. */
function attempt(state: State, key: 'stop_failing' | 'start_failing', action: (state: State) => void, failure: string): void {
  try {
    action(state);
  } catch (e) {
    if (!state[key]) {
      tell(state, `${failure} It tries again each minute: ${message(e)}`);
      state[key] = true;
    }
    throw e;
  }
  delete state[key];
}

export function tick(state: State, minute: number): void {
  const now = io.now();
  const month = now.toISOString().slice(0, 7);
  if (state.month !== month) Object.assign(state, { month, warned: false, reported: false });

  if (state.warned || state.stopped) {
    try {
      approve(state);
    } catch (e) {
      log(`couldn't read the issue's comments: ${message(e)}`);
    }
  }
  const [cap, warn] = limits();

  let usd: number;
  try {
    usd = io.spend(now);
  } catch (e) {
    state.failing_since ??= now.toISOString();
    state.read_error = message(e);
    const silent = (now.getTime() - Date.parse(state.failing_since)) / 1000;
    if (silent >= SILENT_READS && !state.told_failing) {
      tell(state, `The CI spend watcher hasn't read Blacksmith's spend for ${Math.round(silent / 60)} minutes, ` +
        `so it can't stop CI at the ${whole(cap)} cap: ${message(e)}`);
      state.told_failing = true;
    }
    if (state.stopped && minute % ENFORCE_EVERY === 0) stop(state);
    throw e;
  }
  const told = state.told_failing;
  delete state.told_failing;
  if (told) tell(state, `The CI spend watcher reads Blacksmith's spend again: ${dollars(usd)} of the ${whole(cap)} cap.`);
  delete state.failing_since;
  delete state.read_error;
  Object.assign(state, { spend: usd, read_at: now.toISOString() });

  if (usd >= cap && config().mode === 'report') {
    if (!state.reported) {
      Object.assign(state, { reported: true, warned: true });
      tell(state, `CI has reached ${dollars(usd)} of its ${whole(cap)} cap this month, at list price. The watcher ` +
        'only reports (mode report), so CI runs on. To set a new cap, reply `/cap <usd>`.');
    }
  } else if (usd >= cap) {
    if (state.stopped && minute % ENFORCE_EVERY) return;
    attempt(state, 'stop_failing', stop, `CI reached ${dollars(usd)} of its ${whole(cap)} cap, but the watcher couldn't stop it.`);
    if (!state.stopped) {
      Object.assign(state, { stopped: now.toISOString(), warned: true });
      tell(state, `CI is stopped: ${dollars(usd)} of its ${whole(cap)} cap this month, at list price. Every listed workflow ` +
        `in ${config().repos.join(', ')} is disabled and its runs cancelled. To set a new cap and ` +
        'turn CI back on, reply `/cap <usd>`.');
    }
  } else if (state.stopped) {
    attempt(state, 'start_failing', start, `CI is under its ${whole(cap)} cap at ${dollars(usd)}, but the watcher couldn't turn it back on.`);
    tell(state, `CI is back on: ${dollars(usd)} of its ${whole(cap)} cap this month.`);
  } else if (usd >= warn && !state.warned) {
    state.warned = true;
    tell(state, `CI has spent ${dollars(usd)} of its ${whole(cap)} cap this month, at list price, and stops at ` +
      `${whole(cap)}. To set a new cap, reply \`/cap <usd>\`.`);
  }
}

async function watch(): Promise<never> {
  limits(); // refuse to start without a cap
  log(`watching CI spend for ${config().repos.join(', ')} each minute`);
  for (let minute = 0; ; minute++) {
    locked((state) => {
      try {
        tick(state, minute);
      } catch (e) {
        log(`error: ${message(e)}`);
      }
      try {
        deliver(state);
      } catch (e) {
        log(`alert not sent, kept for the next minute: ${message(e)}`);
      }
    });
    await sleep(TICK * 1000);
  }
}

function check(): number {
  const [cap, warn] = limits();
  const c = config();
  const state: State = load(paths.STATE);
  const now = io.now();
  let code = 0;

  try {
    const usd = io.spend(now);
    console.log(`CI spend: ${dollars(usd)} this month at list price, warning at ${whole(warn)}, cap ${whole(cap)}`);
    console.log(`Mode: ${c.mode}` + (c.mode === 'stop' ? `, stops ${c.stop_workflows.join(', ')}` : ', stops nothing'));
  } catch (e) {
    console.log(`CI spend: unread: ${message(e)}`);
    code = 1;
  }
  if (state.stopped) {
    console.log(`CI: stopped since ${localTime(new Date(state.stopped), true)}. \`cap <usd>\` on a maintainer's word turns it back on`);
  } else {
    console.log('CI: on');
  }

  const active = serviceState();
  const read = state.read_at ? `last read ${Math.round((now.getTime() - Date.parse(state.read_at)) / 1000)} s ago` : 'no reading yet';
  const failing = state.failing_since ? `, failing since ${localTime(new Date(state.failing_since), false)}: ${state.read_error ?? 'no error recorded'}` : '';
  console.log(`Watcher: ${active || 'unknown'}, ${read}${failing}`);
  if (state.outbox?.length) console.log(`Alerts not yet sent: ${state.outbox.length}`);
  let last: Array<{ conclusion?: string | null; status?: string; url?: string }>;
  try {
    last = JSON.parse(io.run('gh', 'run', 'list', '-R', c.alerts_repo, '-w', c.alert_workflow, '-L', '1', '--json', 'conclusion,status,url'));
  } catch (e) {
    last = [{ status: `unread: ${message(e)}` }];
  }
  const first = last[0];
  if (first && first.conclusion !== 'success') {
    console.log(`Last alert: ${first.conclusion || first.status}, not posted yet: ${first.url ?? ''}`);
  }
  return code;
}

function serviceState(): string {
  const p = spawnSync('systemctl', ['--user', 'is-active', SERVICE], { encoding: 'utf8' });
  return (p.stdout ?? '').trim();
}

function install(): void {
  const here = realpathSync(fileURLToPath(import.meta.url));
  const home = homedir();
  const link = join(home, '.local/bin/ci-spend-watcher');
  mkdirSync(dirname(link), { recursive: true });
  try {
    lstatSync(link);
    unlinkSync(link);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  symlinkSync(here, link);
  // The unit runs the link directly, so its target must be executable: a copy or a checkout
  // that dropped the mode bit would leave the service failing to start.
  chmodSync(here, statSync(here).mode | 0o111);
  // The link's shebang finds `node` on the unit's PATH, which a version manager's node isn't on.
  const unitPath = UNIT_PATH.map((d) => (d.startsWith('/') ? d : join(home, d))).join(':');
  if (spawnSync('/usr/bin/env', ['node', '--version'], { env: { PATH: unitPath } }).status !== 0) {
    throw new Error(`node isn't on the service's PATH (${unitPath}): add its directory to Environment=PATH in ${SERVICE}.service`);
  }
  run('systemctl', '--user', 'enable', join(dirname(here), `${SERVICE}.service`));
  run('systemctl', '--user', 'daemon-reload');
  run('systemctl', '--user', 'restart', SERVICE);
  run('loginctl', 'enable-linger');
  try {
    accessSync(link, constants.X_OK);
  } catch {
    throw new Error(`${link} isn't executable after install`);
  }
  const state = serviceState();
  if (state !== 'active') throw new Error(`the service ${SERVICE} is ${state || 'unknown'}: read \`journalctl --user -u ${SERVICE}\``);
  console.log(`${link} -> ${here}; the service ${SERVICE} is active`);
}

// ---------------------------------------------------------------------------------------------
// The command line.
// ---------------------------------------------------------------------------------------------

const COMMANDS = ['check', 'cap', 'enable', 'watch', 'install'];
const USAGE = `usage: ci-spend-watcher.ts <command>

CI's spend cap on Blacksmith: reads the month's spend each minute, warns, and at the cap reports or stops CI.

commands:
  check                     the month's spend against the warning and the cap, CI's state and the
                            watcher's last reading
  cap <usd> [--warn <usd>]  a new cap, on a maintainer's word, warning at 85% of it unless given
  enable                    turns back on the workflows the watcher turned off, if the spend is
                            under the cap
  watch                     the watcher loop, run by the systemd user service
  install                   links this file as ~/.local/bin/ci-spend-watcher and (re)starts the
                            service`;

export type Args = { command: 'check' | 'enable' | 'watch' | 'install' } | { command: 'cap'; usd: number; warn?: number } | { help: string };

/** The parsed command line; throws an `Exit` with code 2 and the usage on a bad one. */
export function parseArgs(args: string[]): Args {
  const bad = (text: string) => new Exit(`ci-spend-watcher.ts: ${text}\n\n${USAGE}`, 2);
  let parsed;
  try {
    parsed = parseCommandLine({ args, allowPositionals: true, options: { help: { type: 'boolean', short: 'h' }, warn: { type: 'string' } } });
  } catch (e) {
    throw bad(message(e));
  }
  const { values, positionals: [command, ...rest] } = parsed;
  if (values.help) return { help: USAGE };
  if (command === undefined) throw bad('a command is required');
  if (!COMMANDS.includes(command)) throw bad(`unknown command ${JSON.stringify(command)}`);

  if (command !== 'cap') {
    if (rest.length || values.warn !== undefined) throw bad(`${command} takes no arguments`);
    return { command: command as 'check' | 'enable' | 'watch' | 'install' };
  }
  const [amount, ...extra] = rest;
  if (amount === undefined || extra.length) throw bad('cap takes one amount: cap <usd> [--warn <usd>]');
  const number = (name: string, v: string) => {
    try {
      return usdOf(v);
    } catch {
      throw bad(`${name} must be a number in USD, not ${JSON.stringify(v)}`);
    }
  };
  const usd = number('usd', amount);
  return values.warn === undefined ? { command: 'cap', usd } : { command: 'cap', usd, warn: number('--warn', values.warn) };
}

async function main(args: string[]): Promise<number> {
  try {
    const parsed = parseArgs(args);
    if ('help' in parsed) {
      console.log(parsed.help);
      return 0;
    }
    return await command(parsed);
  } catch (e) {
    if (e instanceof Exit) {
      stderr.write(`${e.message}\n`);
      return e.code;
    }
    stderr.write(`ci-spend-watcher: ${message(e)}\n`);
    return 1;
  }
}

async function command(args: Exclude<Args, { help: string }>): Promise<number> {
  if (args.command === 'check') return check();
  if (args.command === 'watch') return watch();
  if (args.command === 'cap') {
    const { usd, warn } = args;
    const [cap, w] = locked((state) => setCap(state, usd, warn));
    console.log(`Cap ${whole(cap)}, warning at ${whole(w)}. If CI is stopped and the spend is under the cap, ` +
      'the watcher turns it back on within a minute.');
  }
  if (args.command === 'enable') {
    const [cap] = limits();
    const usd = locked((state) => {
      const usd = io.spend(io.now());
      if (usd >= cap) {
        throw new Exit(`CI has spent ${dollars(usd)} of its ${whole(cap)} cap. Set a new cap first, on a maintainer's word: ` +
          'ci-spend-watcher.ts cap <usd>');
      }
      start(state);
      return usd;
    });
    console.log(`CI is on: ${dollars(usd)} of its ${whole(cap)} cap.`);
  }
  if (args.command === 'install') install();
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Amounts, times and values as the alerts and `check` print them.
// ---------------------------------------------------------------------------------------------

/** `usd` to the cent, as `$850.10`. */
export function dollars(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** `usd` to the dollar, as `$1000`: how the cap and the warning are shown. */
export function whole(usd: number): string {
  return `$${usd.toFixed(0)}`;
}

/** An amount in USD from the config, Blacksmith or the command line: a number, or a string of one. */
function usdOf(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new Error(`not a number: ${shown(v)}`);
  return n;
}

/** Whether a config value is set: not missing, null, empty, zero or false. */
function given(v: unknown): boolean {
  return Array.isArray(v) ? v.length > 0 : Boolean(v);
}

/** A config value as JSON, for an error message. */
function shown(v: unknown): string {
  return v === undefined ? 'unset' : JSON.stringify(v);
}

/** `d` in UTC to the second, as `2026-10-21T12:00:00Z`, the form `blacksmith usage` takes. */
function stamp(d: Date): string {
  return d.toISOString().slice(0, 19) + 'Z';
}

/** `d` in local time as `Oct 21, 05:00 PDT`, or `05:00 PDT` without the date. */
function localTime(d: Date, withDate: boolean): string {
  const date = withDate ? ({ month: 'short', day: 'numeric' } as const) : {};
  return new Intl.DateTimeFormat('en-US', { ...date, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(d);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

if (import.meta.main) exit(await main(argv.slice(2)));
