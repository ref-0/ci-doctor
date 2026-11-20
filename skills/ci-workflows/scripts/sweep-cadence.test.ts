/**
 * Tests for sweep-cadence.ts: replaying a cadence as the sweep template runs it, pricing it, telling
 * a full sweep from a quiet slot, and reading GitHub in full. No network: `main` gets a fake `gh`.
 *
 * Runs: `node --test sweep-cadence.test.ts` from this folder (Node 24).
 */
import { deepStrictEqual, equal, match, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bisectSteps, type Commit, commitPages, firstParents, kindOf, main, merges, named, parseOption, perDay, priced, replay, runsOf } from './sweep-cadence.ts';

const hour = 3600;
const day = 24 * hour;
const at = (s: number) => new Date(s * 1000).toISOString();

describe('replay, as the sweep template runs', () => {
  it('sweeps at fixed slots, and a slot with no merge since is quiet', () => {
    // Two days; merges at 1h and 2h on day one only.
    const played = replay([1 * hour, 2 * hour], 0, 2 * day, { merges: 0, hours: 24 });
    deepStrictEqual(played, { sweeps: 2, quiet: 1, early: 0, spans: [2, 0], pending: 0 });
  });

  it("keeps the next slot after an early sweep, as a cron does", () => {
    // N=2: merges at 22h and 23h sweep early at 23h; the slot at 24h still runs, quiet, then 48h.
    const played = replay([22 * hour, 23 * hour, 30 * hour], 0, 2 * day, { merges: 2, hours: 24 });
    deepStrictEqual(played, { sweeps: 3, quiet: 1, early: 1, spans: [2, 0, 1], pending: 0 });
  });

  it('counts a merge in one sweep, none outside the window, and the ones still waiting at its end', () => {
    const merged = [-hour, 3 * hour, 30 * hour, 47 * hour, 3 * day];
    const played = replay(merged, 0, 2 * day, { merges: 0, hours: 36 });
    deepStrictEqual([played.spans, played.pending], [[2], 1]);
  });
});

describe('pricing an option', () => {
  const cost = { full: 100, fullVcpu: 600, quiet: 2, quietVcpu: 4 };

  it('scales a window to 30 days and charges a quiet slot only its plan', () => {
    const row = priced({ merges: 0, hours: 24 }, { sweeps: 10, quiet: 4, early: 0, spans: [3, 0, 0, 5, 0, 0, 1, 2, 8, 4], pending: 0 }, 10, cost);
    if (!row.available) throw new Error('unavailable');
    equal(row.sweepsPerMonth, 30);
    equal(row.quietPerMonth, 12);
    equal(row.jobMinutesPerMonth, (6 * 100 + 4 * 2) * 3);
    equal(row.vcpuMinutesPerMonth, (6 * 600 + 4 * 4) * 3);
    equal(row.hiddenMax, 8);
    equal(row.bisectMax, 3);
  });

  it('marks an option unavailable when the window holds fewer than two of its slots', () => {
    // One day, six merges: a weekly option would otherwise price at 0 minutes and 0 hidden.
    const merged = [1, 2, 3, 4, 5, 6].map((h) => h * hour);
    const row = priced({ merges: 50, hours: 168 }, replay(merged, 0, day, { merges: 50, hours: 168 }), 1, cost);
    deepStrictEqual(row, { option: { merges: 50, hours: 168 }, available: false, why: 'needs a window of at least 14 days (--days)' });
  });

  it('counts the merges still waiting at the window’s end as hidden', () => {
    const row = priced({ merges: 0, hours: 24 }, { sweeps: 2, quiet: 0, early: 0, spans: [1, 2], pending: 9 }, 2, cost);
    if (!row.available) throw new Error('unavailable');
    deepStrictEqual([row.hiddenMax, row.bisectMax], [9, 4]);
  });

  it('prints no vCPU-minutes when a label has none', () => {
    const row = priced({ merges: 0, hours: 24 }, { sweeps: 2, quiet: 0, early: 0, spans: [1, 1], pending: 0 }, 30, { ...cost, fullVcpu: null });
    equal(row.available && row.vcpuMinutesPerMonth, null);
  });

  it('takes about log2 of the merges to bisect them', () => {
    deepStrictEqual([0, 1, 2, 3, 8, 9, 100].map(bisectSteps), [0, 0, 1, 2, 3, 4, 7]);
  });

  it('names an option the way the skill says it, and reads it as merges:hours', () => {
    equal(named({ merges: 25, hours: 24 }), 'after 25 merges or 24 hours, whichever comes first');
    equal(named({ merges: 0, hours: 168 }), 'every 168 hours');
    deepStrictEqual(parseOption('40:12'), { merges: 40, hours: 12 });
    throws(() => parseOption('40'), /merges:hours/);
  });

  it('counts merges a day', () => {
    deepStrictEqual(perDay([hour, 2 * hour, day + hour], 0, 3), { mean: 1, median: 1, busiest: 2 });
  });
});

describe('a full sweep, a quiet slot, or neither', () => {
  const job = (name: string, conclusion = 'success') => ({ name, conclusion, started_at: at(0), completed_at: at(120 * 60), labels: ['ubuntu-24.04'] });

  it('tells them apart by whether a test job ran, not by how many jobs started', () => {
    // One 120-minute test job is a full run; plan and result alone are a quiet one.
    equal(kindOf('success', [job('Plan'), job('Tests 1/1'), job('CI result')], ['Tests']), 'full');
    equal(kindOf('success', [job('Plan'), job('Tests 1/4', 'skipped'), job('CI result')], ['Tests']), 'quiet');
    equal(kindOf('failure', [job('Plan', 'failure')], ['Tests']), 'unknown');
    equal(kindOf('cancelled', [], ['Tests']), 'unknown');
  });
});

/** Commits on a branch: m1..m3 on the first-parent line, m2 merging a branch of ten commits. */
const history = (base: number): Commit[] => {
  const c = (sha: string, parents: string[], t: number): Commit => ({ sha, parents: parents.map((p) => ({ sha: p })), commit: { committer: { date: at(t) } } });
  return [
    c('m3', ['m2'], base + 3 * hour),
    c('m2', ['m1', 'b10'], base + 2 * hour),
    ...Array.from({ length: 10 }, (_, i) => c(`b${10 - i}`, [i === 9 ? 'old' : `b${9 - i}`], base + hour + i)),
    c('m1', ['old'], base + hour),
    c('old', [], base - hour),
  ];
};

describe('merges, as first-parent commits', () => {
  it('counts a merged branch of ten commits once, and stops at the window’s start', () => {
    equal(firstParents(history(0), 'm3', 0).length, 3);
  });

  it('reads every page of commits, and refuses a window past its pages', () => {
    const many = Array.from({ length: 250 }, (_, i): Commit => ({ sha: `c${i}`, parents: [{ sha: `c${i + 1}` }], commit: { committer: { date: at(10_000 - i) } } }));
    const fake = (...args: string[]) => {
      const path = args[2] ?? '';
      if (path.endsWith('/commits/main')) return JSON.stringify(many[0]);
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1]);
      return JSON.stringify(many.slice((page - 1) * 100, page * 100));
    };
    equal(merges(fake, 'o/r', 'main', 0).length, 250);
    throws(() => merges(fake, 'o/r', 'main', 0, 2), /more than 200 commits in the window/);
    equal(commitPages, 100);
  });
});

describe('listing runs', () => {
  it('pages past other runs to find a weekly sweep, and leaves out runs before the window', () => {
    const start = 1_000_000;
    const push = (id: number) => ({ id, display_title: 'Types on main', event: 'push', conclusion: 'success', created_at: at(start + 10 * day - id), head_branch: 'main' });
    const pages = [0, 1, 2].map((p) => ({ workflow_runs: Array.from({ length: 100 }, (_, i) => push(p * 100 + i + 1)) }));
    pages.push({ workflow_runs: [
      { id: 900, display_title: 'CI on main, daily', event: 'workflow_dispatch', conclusion: 'success', created_at: at(start + day), head_branch: 'main' },
      // The same day as the window's start, but before it: the API's date filter lets it through.
      { id: 901, display_title: 'CI on main, daily', event: 'workflow_dispatch', conclusion: 'success', created_at: at(start - hour), head_branch: 'main' },
    ] });
    const fake = (...args: string[]) => JSON.stringify(pages[Number(/[?&]page=(\d+)/.exec(args[2] ?? '')?.[1]) - 1] ?? { workflow_runs: [] });
    const { runs, truncated } = runsOf(fake, 'o/r', 'ci.yml', '', start, (r) => r.display_title.startsWith('CI on main, '), 10);
    deepStrictEqual([runs.map((r) => r.id), truncated], [[900], false]);
  });
});

describe('main, with a fake gh', () => {
  const now = 100 * day;
  const job = (name: string, minutes: number) => ({ name, conclusion: 'success', started_at: at(now - day), completed_at: at(now - day + minutes * 60), labels: ['ubuntu-24.04'] });
  const fake = (sweepJobs: Record<number, object[]>) => (...args: string[]) => {
    const path = args[2] ?? '';
    if (path.endsWith('/commits/main')) return JSON.stringify({ sha: 'm3' });
    if (path.includes('/commits?')) return JSON.stringify(history(now - 20 * day));
    if (path.includes('event=pull_request')) return JSON.stringify({ workflow_runs: [{ id: 3, display_title: 'A change', event: 'pull_request', conclusion: 'success', created_at: at(now - 2 * hour), head_branch: 'x' }] });
    if (path.includes('/runs?')) {
      return JSON.stringify({ workflow_runs: Object.keys(sweepJobs).map((id) => ({ id: Number(id), display_title: 'CI on main, daily', event: 'workflow_dispatch', conclusion: 'success', created_at: at(now - Number(id) * hour), head_branch: 'main' })) });
    }
    const jobs = /runs\/(\d+)\/jobs/.exec(path);
    if (jobs) {
      const list = Number(jobs[1]) === 3 ? [job('Tests 1/1', 10)] : (sweepJobs[Number(jobs[1])] ?? []);
      return JSON.stringify({ total_count: list.length, jobs: list });
    }
    if (path.includes('/releases')) return JSON.stringify([]);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const printed = (args: string[], run: ReturnType<typeof fake>) => {
    const out: string[] = [];
    const log = console.log;
    console.log = (line: string) => out.push(line);
    try {
      main(args, run, now);
    } finally {
      console.log = log;
    }
    return out.join('\n');
  };
  const args = ['--repo', 'o/r', '--branch', 'main', '--days', '28', '--sweep-title', 'CI on main, ', '--test-job', 'Tests'];

  it('prices full sweeps by the runs that ran tests, and quiet slots by those that ran none', () => {
    const out = printed([...args, '--option', '0:24'], fake({
      1: [job('Plan', 1), job('Tests 1/2', 30), job('Tests 2/2', 30), job('CI result', 1)],
      2: [job('Plan', 1), job('CI result', 1)],
    }));
    match(out, /4 merges \(first-parent commits\)/);
    match(out, /A full sweep: 62 job-minutes, 124 vCPU-minutes, the median of 1 passing runs that ran tests. A slot with nothing new: 2 job-minutes, the median of 1 passing runs that ran none/);
    match(out, /\| every 24 hours \| 30 \(/);
  });

  it('says there is not enough evidence when no sweep in the window ran a test job', () => {
    throws(() => printed(args, fake({ 1: [job('Plan', 1), job('CI result', 1)], 2: [job('Plan', 1)] })), /not enough evidence: no successful sweep run/);
  });
});
