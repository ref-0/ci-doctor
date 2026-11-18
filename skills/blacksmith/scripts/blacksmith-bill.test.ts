/**
 * Tests for the Blacksmith adapter, on synthetic records: no network, no `blacksmith` CLI.
 *
 * Runs: `node --test blacksmith-bill.test.ts` from this folder (Node 24).
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { billed, cpu, when } from './blacksmith-bill.ts';

describe('billed', () => {
  it("pages until since and adds a run's same-named jobs", () => {
    const pages = [
      {
        jobs: [
          { run_id: 1, job_name: 'Tests 1/2', billable_minutes: 16, created_at: '2026-01-02T00:00:00Z' },
          { run_id: 1, job_name: 'Tests 1/2', billable_minutes: 8, created_at: '2026-01-02T00:00:00Z' },
          { run_id: 2, job_name: 'Plan', billable_minutes: 2, created_at: '2026-01-02T00:00:00Z' },
        ],
        next_cursor: 'c',
      },
      { jobs: [{ run_id: 3, job_name: 'Plan', billable_minutes: 2, created_at: '2025-12-01T00:00:00Z' }], next_cursor: 'd' },
    ];
    const calls: string[][] = [];
    const run = (...args: string[]) => {
      calls.push(args);
      return JSON.stringify(pages[calls.length - 1]);
    };

    const since = when('2026-01-01T00:00:00Z');
    const now = when('2026-01-20T12:00:00Z');
    deepStrictEqual(billed('o/r', 'CI', new Set(['1', '3']), since, run, now), { '1': { 'Tests 1/2': 24 }, '3': { Plan: 2 } });
    equal(calls.length, 2);
    ok(calls[0]?.includes('20d'));
    ok(calls[1]?.includes('--cursor'));
  });
});

describe('cpu', () => {
  it('is null without metrics, and a p50 and p90 with them', () => {
    equal(cpu(5, () => JSON.stringify({ vm_metrics: null })), null);
    equal(cpu(5, () => JSON.stringify({ vm_metrics: { cpu: { aggregates: { p50: 41.2, p90: 77.9 } } } })), 'CPU p50 41%, p90 78%');
  });

  it('is null when the command fails', () => {
    equal(cpu(5, () => {
      throw new Error('blacksmith: exit 1');
    }), null);
  });
});
