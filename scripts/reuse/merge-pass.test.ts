/**
 * merge-pass.test.ts: which pull request a merge merged, its last run, whether that run passed the
 * component, and the commit it tested.
 *
 *     node --test scripts/reuse/merge-pass.test.ts
 *
 * Reference implementation from a production monorepo; adapt to your repo. In your repo, add a
 * test that every name in `passingJobs` and `planJob` is a job your workflows make (see
 * `pullRequestJobs` in ../budgets/ci-jobs.ts): a rename would leave every merge recording nothing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { recordPrefix } from '../flakes/records.ts';
import { componentPassed, type Job, lastRun, type Merged, mergedBy, parentsOf, passingJobs, planJob, type Pull, type Run, testedCommit } from './merge-pass.ts';

const repo = 'org/app';
const merge = 'a'.repeat(40);
const head = 'b'.repeat(40);
const tested = 'c'.repeat(40);

const pull = (overrides: Partial<Pull> = {}): Pull => ({
  number: 7,
  merged_at: '2026-01-05T03:35:39Z',
  merge_commit_sha: merge,
  base: { ref: 'main', repo: { full_name: repo } },
  head: { sha: head, ref: 'fix/branch', repo: { full_name: repo } },
  ...overrides,
});

describe('mergedBy', () => {
  it('finds the pull request a commit merged into main', () => {
    assert.deepEqual(mergedBy([pull()], merge, repo), { number: 7, head, branch: 'fix/branch' });
  });

  for (const [what, overrides] of [
    ['not merged', { merged_at: null }],
    ['merged by another commit', { merge_commit_sha: 'd'.repeat(40) }],
    ['merged into another branch', { base: { ref: 'next', repo: { full_name: repo } } }],
    ['from a fork', { head: { sha: head, ref: 'fix/branch', repo: { full_name: 'someone/app' } } }],
    ['from a deleted fork', { head: { sha: head, ref: 'fix/branch', repo: null } }],
  ] as const) {
    it(`finds none ${what}`, () => {
      assert.equal(mergedBy([pull(overrides)], merge, repo), undefined);
    });
  }

  it('finds none when two claim the commit', () => {
    assert.equal(mergedBy([pull(), pull({ number: 8 })], merge, repo), undefined);
  });
});

describe('lastRun', () => {
  const merged: Merged = { number: 7, head, branch: 'fix/branch' };
  const run = (id: number, overrides: Partial<Run> = {}): Run => ({
    id,
    event: 'pull_request',
    path: '.github/workflows/ci.yml',
    head_sha: head,
    head_branch: 'fix/branch',
    head_repository: { full_name: repo },
    ...overrides,
  });

  it('takes the newest run of the workflow on the final head', () => {
    assert.equal(lastRun([run(10), run(30), run(20)], merged, repo), 30);
  });

  for (const [what, overrides] of [
    ['another workflow', { path: '.github/workflows/other.yml' }],
    ['another event', { event: 'workflow_dispatch' }],
    ['an earlier head', { head_sha: tested }],
    ['another branch', { head_branch: 'fix/other' }],
    ['a fork', { head_repository: { full_name: 'someone/app' } }],
  ] as const) {
    it(`skips a newer run of ${what}, so the pull request's own last run counts`, () => {
      assert.equal(lastRun([run(10), run(30, overrides)], merged, repo), 10);
    });
  }

  it('finds none without runs', () => {
    assert.equal(lastRun([], merged, repo), undefined);
  });
});

describe('componentPassed', () => {
  const job = (name: string, conclusion = 'success', steps: ReadonlyArray<string> = []): Job => ({
    id: name.length,
    name,
    conclusion,
    steps: steps.map((step) => ({ name: step, conclusion: 'success' })),
  });
  const passing = (): ReadonlyArray<Job> => [{ id: 99, name: planJob, conclusion: 'success', steps: [] }, ...[...passingJobs].map(([name, steps]) => job(name, 'success', steps)), job('Tests 1/2')];

  it("passes when each job and step succeeded, and names the plan's job", () => {
    assert.deepEqual(componentPassed(passing()), { plan: 99 });
  });

  for (const name of passingJobs.keys()) {
    it(`fails when "${name}" was skipped, or didn't run`, () => {
      assert.deepEqual(componentPassed(passing().map((each) => (each.name === name ? { ...each, conclusion: 'skipped' } : each))), { why: `"${name}" ended skipped` });
      assert.deepEqual(componentPassed(passing().filter((each) => each.name !== name)), { why: `it didn't run "${name}"` });
    });
  }

  for (const [name, steps] of passingJobs) {
    for (const step of steps) {
      it(`fails when "${name}"'s step ${step} didn't pass`, () => {
        const jobs = passing().map((each) => (each.name === name ? { ...each, steps: (each.steps ?? []).map((ran) => (ran.name === step ? { ...ran, conclusion: 'skipped' } : ran)) } : each));

        assert.deepEqual(componentPassed(jobs), { why: `"${name}" didn't pass its step "${step}"` });
      });
    }
  }

  it('fails when a second job of the same name could stand in for one', () => {
    const [name = ''] = passingJobs.keys();

    assert.deepEqual(componentPassed([...passing(), job(name, 'failure')]), { why: `it has 2 jobs named "${name}"` });
  });

  it("fails without the plan's job", () => {
    assert.deepEqual(componentPassed(passing().filter((each) => each.name !== planJob)), { why: 'its plan job is unclear' });
  });
});

describe('testedCommit', () => {
  const record = (fields: Record<string, unknown>) => `2026-01-05T03:33:10.1Z ${recordPrefix}${JSON.stringify(fields)}\r`;

  it("reads the commit from the plan's record, past the step's script and other records", () => {
    const log = [
      `2026-01-05T03:33:09.9Z \u001b[36;1m}' | sed 's/^/${recordPrefix}/'\u001b[0m`,
      record({ kind: 'tests', files: [] }),
      record({ kind: 'plan', event: 'pull_request', pr: 7, sha: tested }),
      record({ kind: 'plan', sha: 'e'.repeat(40) }),
    ].join('\n');

    assert.equal(testedCommit(log), tested);
  });

  it('finds none in a log with no record, or a record with no sha', () => {
    assert.equal(testedCommit('2026-01-05T03:33:10.1Z Plan done'), undefined);
    assert.equal(testedCommit(record({ kind: 'plan', sha: 'HEAD' })), undefined);
  });
});

describe('parentsOf', () => {
  it("reads a merge's parents in order, and nothing from its message", () => {
    const commit = `tree ${'f'.repeat(40)}\nparent ${merge}\nparent ${head}\nauthor A\n\nMerge\nparent ${tested}\n`;

    assert.deepEqual(parentsOf(commit), [merge, head]);
  });
});
