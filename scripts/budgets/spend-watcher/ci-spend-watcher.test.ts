#!/usr/bin/env node
/**
 * What: drives the spend watcher through a month with Blacksmith and GitHub faked: nothing leaves
 *   the machine and the real state stays untouched.
 * Where: anywhere, `node --test ci-spend-watcher.test.ts` from this folder.
 * Configure: nothing.
 * Tests: this is the test of ci-spend-watcher.ts.
 * Reference implementation from a production monorepo; adapt to your repo. The cap, warning and every
 * spend below are synthetic: made up for this test, derived from CAP and WARN, and not a recommendation.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import * as w from './ci-spend-watcher.ts';

const REPO = 'org/app';
const ALERTS = 'org/alerts';
const CAP = 1000.0; // synthetic
const WARN = 850.0; // synthetic
const NEW_CAP = CAP * 1.5; // an approver's raised cap
const NEW_WARN = NEW_CAP * 0.85; // the watcher's default warning ratio

const { dollars, whole } = w;
const real = { ...w.io };

/** GitHub's workflows and runs for one repo, the budget issue, and Blacksmith's spend. */
class Fake {
  usd = 0.0;
  now = new Date(Date.UTC(2026, 9, 21, 12));
  flows = new Map<number, string>([[1, 'active'], [2, 'active'], [3, 'disabled_manually']]);
  // Each run's workflow; runs a cancel doesn't end stay in `stuckRuns`.
  runs = new Map<number, number>([[7, 1], [8, 2]]);
  cancelled: number[] = [];
  comments: Array<[string, string]> = [];
  dispatched: string[] = [];
  stuckRuns = new Set<number>();
  fail = new Set<string>();

  constructor() {
    w.io.spend = () => {
      if (this.fail.has('spend')) throw new Error('blacksmith usage: not authenticated');
      return this.usd;
    };
    w.io.gh = (...args) => this.gh(args);
    w.io.run = (...cmd) => this.run(cmd);
    w.io.now = () => new Date(this.now);
  }

  flowStates(): Record<number, string> {
    return Object.fromEntries(this.flows);
  }

  gh(args: string[]): unknown {
    if (this.fail.has('gh')) throw new Error('gh: HTTP 502');
    const path = (args[0] !== '-X' ? args.at(-1) : args[2]) ?? '';
    const paged = args[0] === '--paginate' && args[1] === '--slurp';
    if (args[0] === '-X') {
      const parts = path.split('/');
      const verb = parts.at(-1);
      const id = Number(parts.at(-2));
      if (verb === 'disable' || verb === 'enable') {
        if (!(this.fail.has('stuck') && verb === 'disable')) this.flows.set(id, verb === 'enable' ? 'active' : 'disabled_manually');
      } else if (verb === 'cancel') {
        this.cancelled.push(id);
        if (!this.stuckRuns.has(id)) this.runs.delete(id);
      }
      return null;
    }
    if (path.startsWith(`repos/${REPO}/actions/workflows`)) {
      const flows = [...this.flows].map(([i, s]) => ({ id: i, name: `w${i}`, path: `.github/workflows/w${i}.yml`, state: s }));
      // Two pages, as `--paginate --slurp` returns them, so a second page is read too.
      assert.ok(paged, 'workflows read without paging');
      return [{ workflows: flows.slice(0, 1) }, { workflows: flows.slice(1) }];
    }
    if (path.startsWith(`repos/${REPO}/actions/runs`)) {
      assert.ok(paged, 'runs read without paging');
      const runs = path.includes('status=queued') ? [...this.runs].map(([r, wf]) => ({ id: r, workflow_id: wf })) : [];
      return [{ workflow_runs: runs }];
    }
    if ((args[0] ?? '').includes('/comments') && args.length > 1) {
      this.comments.push(['maintainer', args.at(-1) ?? '']);
      return {};
    }
    if (path.includes('/comments')) return this.comments.map(([who, body], i) => ({ id: i + 1, user: { login: who }, body }));
    if (path.startsWith(`repos/${ALERTS}/issues?`)) return [];
    if (path.startsWith(`repos/${ALERTS}/issues/`)) return { state: 'open' };
    if (args[0] === `repos/${ALERTS}/issues`) return { number: 42 };
    throw new assert.AssertionError({ message: `unexpected gh ${args.join(' ')}` });
  }

  run(cmd: string[]): string {
    const head = cmd.slice(0, 3).join(' ');
    if (head === 'gh api user') return 'maintainer\n';
    if (head === 'gh workflow run') {
      if (this.fail.has('alert')) throw new Error('gh workflow run: HTTP 404');
      this.dispatched.push((cmd.at(-1) ?? '').split('=').slice(1).join('='));
      return '';
    }
    throw new assert.AssertionError({ message: `unexpected run ${cmd.join(' ')}` });
  }
}

let home: string;
let f: Fake;
let state: w.State;
let minute: number;

function writeConfig(c: Record<string, unknown>): void {
  writeFileSync(w.paths.CONFIG, JSON.stringify(c));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ci-spend-watcher-'));
  w.paths.CONFIG = join(home, 'config.json');
  w.paths.STATE = join(home, 'state.json');
  writeConfig({ repos: [REPO], alerts_repo: ALERTS, cap: CAP, warn: WARN, mode: 'stop', stop_workflows: ['*'] });
  f = new Fake();
  state = {};
  minute = 0;
});

afterEach(() => {
  Object.assign(w.io, real);
  rmSync(home, { recursive: true, force: true });
});

function tick(usd?: number, minutes = 1): void {
  if (usd !== undefined) f.usd = usd;
  for (let i = 0; i < minutes; i++) {
    try {
      w.tick(state, minute);
    } catch {}
    try {
      w.deliver(state);
    } catch {}
    minute += 1;
    f.now.setUTCMinutes((f.now.getUTCMinutes() + 1) % 60);
  }
}

test('refuses to run without a cap', () => {
  writeConfig({ repos: [REPO], alerts_repo: ALERTS });
  assert.throws(() => w.limits(), /lacks cap/);
  writeConfig({ repos: [REPO], alerts_repo: ALERTS, cap: '<monthly-cap>' });
  assert.throws(() => w.limits(), /must be numbers/);
});

test('warns once, then stops at the cap', () => {
  tick(WARN / 2);
  assert.equal(f.dispatched.length, 0);

  tick(WARN + 1, 3);
  assert.equal(f.dispatched.length, 1);
  assert.ok(f.dispatched[0]?.startsWith(`@maintainer CI has spent ${dollars(WARN + 1)} of its ${whole(CAP)} cap`));

  tick(CAP);
  assert.deepEqual(f.flowStates(), { 1: 'disabled_manually', 2: 'disabled_manually', 3: 'disabled_manually' });
  assert.deepEqual(f.cancelled, [7, 8]);
  assert.deepEqual(state.disabled, { [REPO]: [1, 2] });
  assert.match(f.dispatched.at(-1) ?? '', new RegExp(`CI is stopped: \\${dollars(CAP)}`));
});

test('holds the stop and checks it every five minutes', () => {
  tick(CAP + 5);
  f.flows.set(1, 'active');
  f.runs.set(9, 1);
  tick(undefined, w.ENFORCE_EVERY - 1 - ((minute - 1) % w.ENFORCE_EVERY));
  assert.equal(f.flows.get(1), 'active');

  tick(undefined, 1);
  assert.equal(f.flows.get(1), 'disabled_manually');
  assert.ok(f.cancelled.includes(9));
  assert.equal(f.dispatched.filter((d) => d.includes('stopped')).length, 1);
});

test("an approver's cap comment turns CI back on, and only what it disabled", () => {
  tick(CAP + 5);
  f.comments.push(['someone-else', `/cap ${CAP * 4}`]);
  f.comments.push(['maintainer', `please /cap ${NEW_CAP}`]);
  tick();
  assert.deepEqual(w.limits(), [CAP, WARN]);

  f.comments.push(['maintainer', ` /cap $${NEW_CAP} `]);
  tick();
  assert.deepEqual(w.limits(), [NEW_CAP, NEW_WARN]);
  // Workflow 3 was disabled before the stop, so it stays disabled.
  assert.deepEqual(f.flowStates(), { 1: 'active', 2: 'active', 3: 'disabled_manually' });
  assert.equal(state.stopped, null);
  assert.ok(f.dispatched.at(-1)?.includes(`CI is back on: ${dollars(CAP + 5)} of its ${whole(NEW_CAP)} cap`));

  tick(NEW_WARN + 5);
  assert.ok(f.dispatched.at(-1)?.includes(`CI has spent ${dollars(NEW_WARN + 5)} of its ${whole(NEW_CAP)} cap`));
});

test('unread spend is reported after ten minutes, and once', () => {
  f.fail.add('spend');
  tick(undefined, 10);
  assert.equal(f.dispatched.length, 0);
  tick(undefined, 5);
  assert.equal(f.dispatched.length, 1);
  assert.ok(f.dispatched[0]?.includes("hasn't read Blacksmith's spend for 10 minutes"));

  f.fail.delete('spend');
  tick(WARN / 10);
  assert.ok(f.dispatched.at(-1)?.includes(`reads Blacksmith's spend again: ${dollars(WARN / 10)}`));
});

test('a stop that fails is reported and tried again', () => {
  f.fail.add('stuck');
  tick(CAP + 10, 3);
  assert.equal(f.dispatched.length, 1);
  assert.ok(f.dispatched[0]?.includes("couldn't stop it"));
  assert.ok(!('stopped' in state));

  f.fail.delete('stuck');
  tick();
  assert.ok(state.stopped);
  assert.ok(f.dispatched.at(-1)?.includes('CI is stopped'));
});

test('an alert that fails waits for the next minute', () => {
  f.fail.add('alert');
  tick(WARN + 10, 2);
  assert.equal(state.outbox?.length, 1);

  f.fail.delete('alert');
  tick();
  assert.deepEqual(state.outbox, []);
  assert.equal(f.dispatched.length, 1);
});

test('a new month turns CI back on and warns again', () => {
  tick(CAP + 5);
  f.now = new Date(Date.UTC(2026, 10, 1, 0, 1));
  tick(1);
  assert.equal(state.stopped, null);
  assert.equal(state.warned, false);
  assert.ok(f.dispatched.at(-1)?.includes('CI is back on: $1.00'));
});

test('report mode tells once and stops nothing', () => {
  writeConfig({ repos: [REPO], alerts_repo: ALERTS, cap: CAP, warn: WARN });
  tick(CAP + 5, 3);
  assert.deepEqual(f.flowStates(), { 1: 'active', 2: 'active', 3: 'disabled_manually' });
  assert.deepEqual(f.cancelled, []);
  assert.equal(f.dispatched.length, 1);
  assert.ok(f.dispatched[0]?.includes('only reports'));
});

test("stop mode needs a list, and stops only what's listed", () => {
  writeConfig({ repos: [REPO], alerts_repo: ALERTS, cap: CAP, mode: 'stop' });
  assert.throws(() => w.config(), /needs stop_workflows/);
  writeConfig({ repos: [REPO], alerts_repo: ALERTS, cap: CAP, warn: WARN, mode: 'stop', stop_workflows: ['w2.yml'] });
  tick(CAP + 5);
  assert.deepEqual(f.flowStates(), { 1: 'active', 2: 'disabled_manually', 3: 'disabled_manually' });
  assert.deepEqual(f.cancelled, [8]);
  assert.deepEqual(state.disabled, { [REPO]: [2] });
});

test('a run a cancel leaves active fails the next hold', () => {
  f.stuckRuns.add(7);
  tick(CAP + 5);
  assert.ok(state.stopped);
  assert.deepEqual(state.lingering, [7]);
  assert.throws(() => w.stop(state), /runs still active after cancelling: 7/);
});

test('GitHub failing while reading comments still stops CI', () => {
  tick(WARN + 10);
  f.fail.add('gh');
  tick(CAP + 10);
  f.fail.delete('gh');
  tick();
  assert.ok(state.stopped);
});

// The lock and the command line.

test('alerts show amounts to the cent and the cap to the dollar', () => {
  assert.equal(w.dollars(850.1), '$850.10');
  assert.equal(w.dollars(0), '$0.00');
  assert.equal(w.whole(1275), '$1275');
  assert.equal(w.whole(1499.6), '$1500');
});

test('the lock saves the state only when its body returns, and lets go either way', () => {
  w.locked((s) => {
    s.warned = true;
  });
  assert.throws(() => w.locked((s) => {
    s.reported = true;
    throw new w.Exit('no');
  }), /no/);
  assert.deepEqual(w.locked((s) => ({ ...s })), { warned: true });
});

test("the command line takes each command and cap's amount and warning, and refuses anything else with code 2", () => {
  assert.deepEqual(w.parseArgs(['check']), { command: 'check' });
  assert.deepEqual(w.parseArgs(['cap', '1200']), { command: 'cap', usd: 1200 });
  assert.deepEqual(w.parseArgs(['cap', '--warn', '900', '1200']), { command: 'cap', usd: 1200, warn: 900 });
  assert.deepEqual(w.parseArgs(['cap', '1200', '--warn=900']), { command: 'cap', usd: 1200, warn: 900 });
  assert.ok('help' in w.parseArgs(['--help']));
  for (const bad of [[], ['stop'], ['cap'], ['cap', 'lots'], ['cap', '1200', '--warn', 'lots'], ['cap', '1200', '1300'], ['check', '--warn', '9'], ['check', 'extra']]) {
    assert.throws(() => w.parseArgs(bad), (e: unknown) => e instanceof w.Exit && e.code === 2);
  }
});
