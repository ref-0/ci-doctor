/**
 * Tests for ci-time.ts, on synthetic jobs: no network, no `gh`. The Blacksmith adapter's own tests are
 * in the blacksmith topic's scripts/blacksmith-bill.test.ts, so these run without that skill; the one
 * that loads it skips when it isn't installed beside this one.
 *
 * Runs: `node --test ci-time.test.ts` from this folder (Node 24).
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { deepStrictEqual, equal, match, notEqual, ok } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { billedMinutes, FILE, type Job, jobRows, loadAdapter, quantile, report, vcpu, vcpus, wall } from './ci-time.ts';

const here = dirname(fileURLToPath(import.meta.url));

const job = (name: string, start: string, end: string, labels = ['blacksmith-8vcpu-ubuntu-2404'], conclusion = 'success'): Job => ({
  name, started_at: `2026-01-01T00:${start}Z`, completed_at: `2026-01-01T00:${end}Z`, labels, conclusion,
});

describe('minutes', () => {
  it('rounds each started minute up', () => {
    deepStrictEqual([0, 1, 60, 61, 119, 120].map(billedMinutes), [0, 1, 1, 2, 2, 2]);
  });
});

describe('runners', () => {
  it('maps labels to vCPUs', () => {
    equal(vcpus(['blacksmith-8vcpu-ubuntu-2404-arm']), 8);
    equal(vcpus(['ubuntu-latest']), 2);
    equal(vcpus(['ubuntu-24.04-16-cores']), 16);
    equal(vcpus(['self-hosted', 'linux']), null);
    equal(vcpus([]), null);
  });
});

describe('rows', () => {
  const jobs = [
    job('Plan', '00:00', '00:20', ['blacksmith-2vcpu-ubuntu-2404']),
    job('Tests 1/2', '00:30', '02:10'),
    job('Tests 2/2', '00:30', '01:20'),
    job('Skipped', '00:00', '00:00', undefined, 'skipped'),
    job('CI result', '02:10', '03:00', ['blacksmith-2vcpu-ubuntu-2404']),
  ];

  it('estimates from labels', () => {
    const rows = jobRows(7, jobs);
    deepStrictEqual(rows.map((r) => r.name), ['Plan', 'Tests 1/2', 'Tests 2/2', 'CI result']);
    deepStrictEqual(rows.map((r) => r.vcpuMinutes), [2, 16, 8, 2]);
    ok(!rows.some((r) => r.fromBill));
  });

  it('lets the bill win over the estimate', () => {
    const rows = jobRows(7, jobs, { '7': { 'Tests 1/2': 24 } });
    equal(rows[1]?.vcpuMinutes, 24);
    ok(rows[1]?.fromBill);
  });

  it('leaves the gate out of the checks span and ends to gate at it', () => {
    deepStrictEqual(wall(jobRows(7, jobs)), { checks: 130, last: 'Tests 1/2', toGate: 180 });
    equal(wall(jobRows(7, jobs.slice(0, 3))).toGate, null);
  });

  it('counts unmapped labels and splits the bill from the estimate', () => {
    const rows = jobRows(9, [job('Plan', '00:00', '00:20', ['self-hosted']), job('Tests 1/1', '00:30', '01:20')], { '9': { 'Tests 1/1': 12 } });
    const [header = ''] = report([{ databaseId: 9, event: 'pull_request', conclusion: 'success', createdAt: 'x' }], rows);
    ok(header.includes("1 jobs on labels RUNNERS doesn't map"), header);
    ok(header.includes('12 from a bill (every attempt) and 0 estimated'), header);
    ok(!header.includes('list price'), header);
  });

  it('prints money only when every label is priced', () => {
    const prices = [[/8vcpu/, 0.5]] as const;
    deepStrictEqual(jobRows(7, jobs.slice(1, 3), null, prices).map((r) => r.cost), [1.0, 0.5]);
    equal(jobRows(7, jobs.slice(1, 2), { '7': { 'Tests 1/2': 24 } }, prices)[0]?.cost, 1.5);
    const mixed = jobRows(7, jobs, null, prices);
    const [header = ''] = report([{ databaseId: 7, event: 'pull_request', conclusion: 'success', createdAt: 'x' }], mixed);
    ok(header.includes('no money total: 2 of 4 jobs'), header);
  });

  it('reads file lines with or without a project', () => {
    const log = '✓ server src/a.test.ts (3 tests) 1200ms\n'
      + ' ✓ src/b.spec.tsx (1 test) 40ms\n'
      + '✓ src/c.ts (1 test) 5ms\n';
    deepStrictEqual([...log.matchAll(FILE)].map((m) => m.slice(1)), [['src/a.test.ts', '3', '1200'], ['src/b.spec.tsx', '1', '40']]);
  });

  it('takes the nearest rank', () => {
    equal(quantile([5, 1, 3, 2, 4], 0.5), 3);
    equal(quantile(Array.from({ length: 10 }, (_, i) => i + 1), 0.9), 9);
  });
});

describe('vCPU-minutes', () => {
  it('prints whole numbers bare and others to one decimal', () => {
    deepStrictEqual([0, 24, 12.5, 2 / 3, 1234567].map(vcpu), ['0', '24', '12.5', '0.7', '1234567']);
  });
});

describe('the billing adapter', () => {
  const sibling = join(here, '..', '..', 'blacksmith', 'scripts', 'blacksmith-bill.ts');

  it('loads the blacksmith skill installed beside this one', { skip: !existsSync(sibling) && 'no blacksmith skill beside ci-workflows' }, async () => {
    const adapter = await loadAdapter('blacksmith');
    equal(typeof adapter.billed, 'function');
    equal(typeof adapter.cpu, 'function');
  });

  it('says where it looked when the adapter is missing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ci-time-'));
    const done = spawnSync(process.execPath, [join(here, 'ci-time.ts'), '--repo', 'o/r', '--bill', 'blacksmith', '--adapter-dir', empty], { encoding: 'utf8' });
    equal(done.status, 1);
    match(done.stderr, /--bill blacksmith: no blacksmith-bill\.ts found/);
  });
});

describe('the command line', () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(here, 'ci-time.ts'), ...args], { encoding: 'utf8' });

  it('prints its help', () => {
    const done = cli('--help');
    equal(done.status, 0);
    match(done.stdout, /--bill blacksmith/);
  });

  it('refuses a provider it has no adapter for, and a count that is not a number, as usage errors', () => {
    const provider = cli('--repo', 'o/r', '--bill', 'other');
    equal(provider.status, 2);
    match(provider.stderr, /no adapter for "other"/);
    const runs = cli('--runs', 'many');
    equal(runs.status, 2);
    notEqual(runs.stderr, '');
  });
});
