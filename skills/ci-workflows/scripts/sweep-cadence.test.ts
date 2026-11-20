/**
 * Tests for sweep-cadence.ts' arithmetic: replaying a cadence over merges, pricing it, and bisect
 * steps. No network: `main` gets a fake `gh`.
 *
 * Runs: `node --test sweep-cadence.test.ts` from this folder (Node 24).
 */
import { deepStrictEqual, equal, match, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bisectSteps, main, named, parseOption, perDay, priced, replay, text } from './sweep-cadence.ts';

const hour = 3600;
const day = 24 * hour;

describe('replay', () => {
  it('sweeps by the clock, and a slot with no merge since is quiet', () => {
    // Two days; merges at 1h and 2h on day one only.
    const played = replay([1 * hour, 2 * hour], 0, 2 * day, { merges: 0, hours: 24 });
    deepStrictEqual(played, { sweeps: 2, quiet: 1, spans: [2, 0] });
  });

  it('sweeps early once N merges land, whichever comes first', () => {
    const merged = [1, 2, 3, 4, 5].map((h) => h * hour);
    const played = replay(merged, 0, day, { merges: 2, hours: 24 });
    // After the 2nd and 4th merges, then the clock 24 hours after the 4th's sweep is past the window.
    deepStrictEqual(played, { sweeps: 2, quiet: 0, spans: [2, 2] });
  });

  it('counts a merge in only one sweep, and none outside the window', () => {
    const merged = [-hour, 3 * hour, 30 * hour, 3 * day];
    const { spans } = replay(merged, 0, 2 * day, { merges: 0, hours: 12 });
    deepStrictEqual(spans, [1, 0, 1, 0]);
  });
});

describe('pricing an option', () => {
  const cost = { full: 100, fullVcpu: 600, quiet: 2, quietVcpu: 4 };

  it('scales a window to 30 days and charges a quiet slot only its plan', () => {
    const row = priced({ merges: 0, hours: 24 }, { sweeps: 10, quiet: 4, spans: [3, 0, 0, 5, 0, 0, 1, 2, 8, 4] }, 10, cost);
    equal(row.sweepsPerMonth, 30);
    equal(row.quietPerMonth, 12);
    equal(row.jobMinutesPerMonth, (6 * 100 + 4 * 2) * 3);
    equal(row.vcpuMinutesPerMonth, (6 * 600 + 4 * 4) * 3);
    equal(row.hiddenMax, 8);
    equal(row.bisectMax, 3);
  });

  it('prints no vCPU-minutes when a label has none', () => {
    equal(priced({ merges: 0, hours: 24 }, { sweeps: 1, quiet: 0, spans: [1] }, 30, { ...cost, fullVcpu: null }).vcpuMinutesPerMonth, null);
  });

  it('takes about log2 of the merges to bisect them', () => {
    deepStrictEqual([0, 1, 2, 3, 8, 9, 100].map(bisectSteps), [0, 0, 1, 2, 3, 4, 7]);
  });

  it('names an option the way the skill says it', () => {
    equal(named({ merges: 25, hours: 24 }), 'after 25 merges or 24 hours, whichever comes first');
    equal(named({ merges: 0, hours: 168 }), 'every 168 hours');
  });

  it('reads an option as merges:hours', () => {
    deepStrictEqual(parseOption('40:12'), { merges: 40, hours: 12 });
    throws(() => parseOption('40'), /merges:hours/);
  });

  it('counts merges a day', () => {
    deepStrictEqual(perDay([hour, 2 * hour, day + hour], 0, 3), { mean: 1, median: 1, busiest: 2 });
  });
});

describe('main, with a fake gh', () => {
  it('reads merges, the sweeps and PR runs, and prints a row for each option', () => {
    const now = Math.floor(Date.now() / 1000);
    const at = (s: number) => new Date(s * 1000).toISOString();
    const job = (minutes: number, label = 'ubuntu-24.04') => ({ name: 'j', conclusion: 'success', started_at: at(now - 3600), completed_at: at(now - 3600 + minutes * 60), labels: [label] });
    const runs: Record<string, unknown> = {
      sweeps: { workflow_runs: [1, 2].map((id) => ({ id, display_title: 'CI on main, daily', event: 'workflow_dispatch', conclusion: 'success', created_at: at(now - id * 3600), head_branch: 'main' })) },
      prs: { workflow_runs: [{ id: 3, display_title: 'A change', event: 'pull_request', conclusion: 'success', created_at: at(now - 7200), head_branch: 'x' }] },
    };
    const fake = (...args: string[]) => {
      const path = args[2] ?? '';
      if (path.startsWith('search/issues')) return JSON.stringify({ items: [{ pull_request: { merged_at: at(now - 5 * 3600) } }, { pull_request: { merged_at: at(now - 2 * day) } }] });
      if (path.includes('event=pull_request')) return JSON.stringify(runs.prs);
      if (path.includes('/runs?')) return JSON.stringify(runs.sweeps);
      if (path.endsWith('jobs?per_page=50&page=1') && path.includes('/runs/3/')) return JSON.stringify({ total_count: 1, jobs: [job(10)] });
      if (path.includes('/jobs?')) return JSON.stringify({ total_count: 5, jobs: [job(30), job(30), job(20), job(10), job(10)] });
      if (path.includes('/releases')) return JSON.stringify([{ published_at: at(now - day), draft: false }]);
      throw new Error(`unexpected gh ${args.join(' ')}`);
    };
    const printed: string[] = [];
    const log = console.log;
    console.log = (line: string) => printed.push(line);
    try {
      main(['--repo', 'o/r', '--branch', 'main', '--days', '7', '--sweep-title', 'CI on main, ', '--option', '0:24'], fake);
    } finally {
      console.log = log;
    }
    const out = printed.join('\n');
    match(out, /2 merged pull requests/);
    match(out, /A full sweep: 100 job-minutes, 200 vCPU-minutes/);
    match(out, /10% of a full sweep, so selection skips about 90%/);
    match(out, /\| every 24 hours \| 30 \(/);
  });

  it('says so when PR runs cost about what a sweep does', () => {
    const lines = text({
      repo: 'o/r', branch: 'main', days: 7, merges: 7, perDay: { mean: 1, median: 1, busiest: 2 },
      sweep: { runs: 2, busy: 2, quietRuns: 0, quietMeasured: false, full: 20, fullVcpu: null, quiet: 2, quietVcpu: null },
      pr: { runs: 5, medianJobMinutes: 21, shareOfSweep: 1.05 }, releases: { count: 0, perWeek: 0 }, options: [],
    });
    match(lines.join('\n'), /PRs run about everything/);
  });
});
