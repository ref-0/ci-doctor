/**
 * Tests for sweep-cadence.ts: cron schedules and their slots, replaying and pricing them, telling
 * a full sweep from a quiet slot, and reading GitHub in full. No network: `main` gets a fake `gh`.
 *
 * Runs: `node --test sweep-cadence.test.ts` from this folder (Node 24).
 */
import { deepStrictEqual, equal, match, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bisectSteps, type Commit, commitPages, firstParents, kindOf, longestGap, main, merges, parseCron, parseSlot, perDay, priced, replay, runsOf, schedules, slotIn, slotsOf } from './sweep-cadence.ts';

const hour = 3600;
const day = 24 * hour;
const at = (s: number) => new Date(s * 1000).toISOString();

describe('cron schedules', () => {
  const at0 = Date.UTC(2026, 10, 2) / 1000; // Monday 2 November 2026, 00:00 UTC

  it('places slots at the cron’s own time of day, not from the window’s start', () => {
    // A window that starts at 10:00: the daily 02:41 slot is the next day's, not 10:00 + 24 hours.
    deepStrictEqual(slotsOf(parseCron('41 2 * * *'), at0 + 10 * hour, at0 + 2 * day), [at0 + day + 2 * hour + 41 * 60]);
  });

  it('builds the default schedules at the slot’s time of day', () => {
    deepStrictEqual(
      schedules({ hour: 14, minute: 5, from: 'x' }).map((s) => s.cron),
      ['5 2,8,14,20 * * *', '5 2,14 * * *', '5 14 * * *', '5 14 */2 * *', '5 14 * * 1'],
    );
  });

  it('reads every 2 days as cron does, and weekly on its weekday', () => {
    const twoDays = slotsOf(parseCron('0 0 */2 * *'), at0, at0 + 6 * day).map((t) => new Date(t * 1000).getUTCDate());
    deepStrictEqual(twoDays, [3, 5, 7]);
    deepStrictEqual(slotsOf(parseCron('0 3 * * 1'), at0, at0 + 14 * day), [at0 + 3 * hour, at0 + 7 * day + 3 * hour]);
    // A 30-day month's 29th to the next 1st is two days; a 31-day month's 31st to the 1st is one.
    equal(longestGap(parseCron('0 0 */2 * *')), 2 * day);
    equal(longestGap(parseCron('0 0 * * 1')), 7 * day);
    equal(longestGap(parseCron('5 2,8,14,20 * * *')), 6 * hour);
    throws(() => parseCron('0 0 * *'), /five fields/);
    throws(() => parseCron('0 25 * * *'), /out of range/);
  });

  it('takes the slot from --slot, the workflow’s SWEEP_AT or its first cron, in that order', () => {
    deepStrictEqual(parseSlot('02:41'), { hour: 2, minute: 41, from: '--slot' });
    throws(() => parseSlot('2:61'), /HH:MM/);
    const workflow = "on:\n  schedule:\n    - cron: '41 2 * * *'\n    - cron: '41 8,14,20 * * *'\nenv:\n  SWEEP_AT: '03:17'\n";
    deepStrictEqual(slotIn(workflow, 'sweep.yml'), { hour: 3, minute: 17, from: "sweep.yml's SWEEP_AT" });
    deepStrictEqual(slotIn(workflow.replace(/env:[\s\S]*/, ''), 'sweep.yml'), { hour: 2, minute: 41, from: "sweep.yml's first cron" });
    equal(slotIn('on: push\n', 'sweep.yml'), undefined);
  });
});

describe('replaying a schedule', () => {
  it('counts the merges each slot checks, a quiet slot, and those still waiting at the end', () => {
    // Slots at 2h and 26h; merges at 1h and 1.5h, none by 26h, then one at 30h.
    deepStrictEqual(replay([1 * hour, 1.5 * hour, 30 * hour], [2 * hour, 26 * hour], 0, 36 * hour), { sweeps: 2, quiet: 1, spans: [2, 0], pending: 1 });
  });

  it('counts the merges since the slot before the window in its first slot, so it isn’t quiet by the window’s edge', () => {
    // Weekly slots at day 7 and 14; the window starts at day 5, after a merge at day 3.
    deepStrictEqual(replay([3 * day, 10 * day], [7 * day, 14 * day], 5 * day, 15 * day, 0).spans, [1, 1]);
    deepStrictEqual(replay([3 * day, 10 * day], [7 * day, 14 * day], 5 * day, 15 * day).spans, [0, 1]);
  });

  it('counts each merge once, a push of several as several, and none outside the window', () => {
    // Three first-parent commits pushed at once are three merges a bisect walks.
    deepStrictEqual(replay([-hour, 3 * hour, 3 * hour, 3 * hour, 3 * day], [12 * hour], 0, day).spans, [3]);
  });
});

describe('pricing a schedule', () => {
  const cost = { full: 100, fullVcpu: 600, quiet: 2, quietVcpu: 4 };
  const daily = { cron: '0 0 * * *', name: 'daily' };

  it('scales a window to 30 days and charges a quiet slot only its plan', () => {
    const row = priced(daily, { sweeps: 10, quiet: 4, spans: [3, 0, 0, 5, 0, 0, 1, 2, 8, 4], pending: 0 }, day, 10, cost);
    if (!row.available) throw new Error('unavailable');
    equal(row.sweepsPerMonth, 30);
    equal(row.quietPerMonth, 12);
    equal(row.jobMinutesPerMonth, (6 * 100 + 4 * 2) * 3);
    equal(row.vcpuMinutesPerMonth, (6 * 600 + 4 * 4) * 3);
    equal(row.hiddenMax, 8);
    equal(row.bisectMax, 3);
  });

  it('marks a schedule unavailable when the window holds less than twice its longest gap', () => {
    const weekly = { cron: '0 0 * * 1', name: 'weekly, Mondays' };
    deepStrictEqual(priced(weekly, { sweeps: 0, quiet: 0, spans: [], pending: 6 }, 7 * day, 1, cost), {
      schedule: weekly, available: false, why: 'needs a window of at least 14 days (--days)',
    });
  });

  it('counts the merges still waiting at the window’s end as hidden', () => {
    const row = priced(daily, { sweeps: 2, quiet: 0, spans: [1, 2], pending: 9 }, day, 2, cost);
    if (!row.available) throw new Error('unavailable');
    deepStrictEqual([row.hiddenMax, row.bisectMax], [9, 4]);
  });

  it('prints no vCPU-minutes when a label has none', () => {
    const row = priced(daily, { sweeps: 2, quiet: 0, spans: [1, 1], pending: 0 }, day, 30, { ...cost, fullVcpu: null });
    equal(row.available && row.vcpuMinutesPerMonth, null);
  });

  it('takes about log2 of the merges to bisect them, and counts merges a day', () => {
    deepStrictEqual([0, 1, 2, 3, 8, 9, 100].map(bisectSteps), [0, 0, 1, 2, 3, 4, 7]);
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
  const fake = (sweepJobs: Record<number, object[]>, workflow?: string) => (...args: string[]) => {
    if (args[2] === '-H') {
      if (workflow === undefined || !(args[4] ?? '').includes('/contents/.github/workflows/sweep.yml?ref=main')) throw new Error('gh: Not Found (HTTP 404)');
      return workflow;
    }
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

  const sweeps = {
    1: [job('Plan', 1), job('Tests 1/2', 30), job('Tests 2/2', 30), job('CI result', 1)],
    2: [job('Plan', 1), job('CI result', 1)],
  };

  it('prices full sweeps by the runs that ran tests, and quiet slots by those that ran none', () => {
    const out = printed(args, fake(sweeps, "env:\n  SWEEP_AT: '02:41'\n"));
    match(out, /4 merges \(first-parent commits\)/);
    match(out, /A full sweep: 62 job-minutes, 124 vCPU-minutes, the median of 1 passing runs that ran tests. A slot with nothing new: 2 job-minutes, the median of 1 passing runs that ran none/);
    match(out, /Slots at 02:41 UTC, from \.github\/workflows\/sweep\.yml's SWEEP_AT\./);
    // 28 slots in 28 days, scaled to a 30-day month.
    match(out, /\| daily \| `41 2 \* \* \*` \| 30 \(/);
    match(out, /\| weekly, Mondays \| `41 2 \* \* 1` \| 4 \(/);
  });

  it('takes --slot over the workflow, says when it assumed one, and prices a cron given', () => {
    match(printed([...args, '--slot', '14:05'], fake(sweeps, "env:\n  SWEEP_AT: '02:41'\n")), /Slots at 14:05 UTC, from --slot\.[\s\S]*\| every 6 hours \| `5 2,8,14,20 \* \* \*`/);
    match(printed(args, fake(sweeps)), /Slots at 00:00 UTC, from an assumption: no SWEEP_AT or cron/);
    const out = printed([...args, '--option', '0 6 * * 1,4'], fake(sweeps));
    match(out, /\| 0 6 \* \* 1,4 \| `0 6 \* \* 1,4` \| 9 \(/);
    equal(out.includes('every 6 hours'), false);
  });

  it('says there is not enough evidence when no sweep in the window ran a test job', () => {
    throws(() => printed(args, fake({ 1: [job('Plan', 1), job('CI result', 1)], 2: [job('Plan', 1)] })), /not enough evidence: no successful sweep run/);
  });
});
