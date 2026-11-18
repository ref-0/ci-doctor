/**
 * ci-budgets.test.ts: every job a ready pull request can run has a budget, on a runner its budget
 * allows, and no budget names a job that's gone.
 *
 * Runs: `node --test scripts/budgets/` (or move it into your test runner). Keep it in the tests
 * every pull request that touches `.github/workflows/` runs.
 * Configure: `workflowsDirectory` below, if your workflows aren't at the repo root.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';

import { budgetProblems, budgets, budgetSeconds, type Budget } from './ci-budgets.ts';
import { pullRequestJobs, workflowsIn } from './ci-jobs.ts';

/** Where the repo's workflows are, from this file. */
const workflowsDirectory = new URL('../../.github/workflows/', import.meta.url);

/** A pull request's workflow, `ci.yml`, that calls `builds.yml`, as `pullRequestJobs` reads them. */
const fixture = (file: string) => {
  const workflows = new Map([
    [
      'ci.yml',
      `name: CI
on:
  pull_request:
    branches: [main]
  workflow_dispatch:
    inputs:
      sweep:
        type: boolean
        default: false
jobs:
  plan:
    name: Plan
    runs-on: blacksmith-2vcpu-ubuntu-2404
    outputs:
      runner: \${{ steps.plan.outputs.runner || 'blacksmith-8vcpu-ubuntu-2404' }}
    steps:
      - name: Which runner
        id: plan
        run: |
          if [ -n "$FEW" ]; then
            echo 'runner=blacksmith-2vcpu-ubuntu-2404' >> "$GITHUB_OUTPUT"
          else
            echo 'runner=blacksmith-16vcpu-ubuntu-2404' >> "$GITHUB_OUTPUT"
          fi
  # Started only by the sweep, so a pull request never runs it.
  deeper:
    name: Deeper
    needs: plan
    if: github.event_name == 'schedule' || inputs.sweep
    runs-on: blacksmith-32vcpu-ubuntu-2404
  tests:
    name: Tests \${{ matrix.shard }}
    needs: plan
    runs-on: \${{ needs.plan.outputs.runner }}
    strategy:
      matrix:
        shard: [1, 2]
  proof:
    name: Proof, \${{ matrix.machine }}
    needs: plan
    runs-on: \${{ matrix.machine == 'mac' && 'blacksmith-6vcpu-macos-26' || 'blacksmith-2vcpu-ubuntu-2404' }}
    strategy:
      matrix:
        machine: \${{ fromJSON(needs.plan.outputs.machines) }}
  builds:
    name: Builds
    needs: plan
    uses: ./.github/workflows/builds.yml
    with:
      mac: false
`,
    ],
    [
      'builds.yml',
      `name: Builds
on:
  workflow_call:
    inputs:
      mac:
        type: boolean
        default: true
jobs:
  linux:
    name: Linux on \${{ matrix.arch }}
    strategy:
      matrix:
        arch: [x64, arm64]
        include:
          - arch: arm64
            arm: -arm
    runs-on: blacksmith-4vcpu-ubuntu-2404\${{ matrix.arm }}
  mac:
    name: macOS
    if: inputs.mac
    runs-on: blacksmith-6vcpu-macos-26
`,
    ],
    [
      'recheck.yml',
      `name: Recheck
on:
  issue_comment:
jobs:
  recheck:
    if: github.event_name == 'issue_comment'
    runs-on: blacksmith-2vcpu-ubuntu-2404
`,
    ],
  ]);
  const text = workflows.get(file);
  if (text === undefined) throw new Error(`no ${file} in the fixture`);

  return text;
};

const budget = (job: string, ...runners: ReadonlyArray<string>): Budget => ({
  workflow: job === 'linux' ? 'builds.yml' : 'ci.yml',
  job,
  why: "The fixture's.",
  legs: runners.map((runner) => ({ runner, seconds: 60 })),
});

describe('CI budgets', () => {
  const real = budgets.length > 0 && existsSync(workflowsDirectory);

  it(
    'gives every job a pull request can run a budget, on a runner its budget allows',
    { skip: real ? false : 'fill in `budgets` in ci-budgets.ts first' },
    () => {
      assert.deepEqual(budgetProblems(pullRequestJobs(workflowsIn(workflowsDirectory))), []);
    },
  );

  it("names a job with no budget, a runner past a job's budget and a budget whose job is gone", () => {
    const jobs = pullRequestJobs({ read: fixture, files: ['ci.yml', 'builds.yml', 'recheck.yml'] });
    // The plan has none.
    const held = [
      // The plan can choose 16 vCPU, past the 8 allowed.
      budget('tests', 'blacksmith-8vcpu-ubuntu-2404', 'blacksmith-2vcpu-ubuntu-2404'),
      // Each machine the plan could choose, Linux and the Mac, within its budget.
      budget('proof', 'blacksmith-2vcpu-ubuntu-2404', 'blacksmith-6vcpu-macos-26'),
      // x64's leg is allowed and arm64's isn't: Arm is a platform of its own.
      budget('linux', 'blacksmith-4vcpu-ubuntu-2404'),
      budget('slow-tests', 'blacksmith-4vcpu-ubuntu-2404'),
    ];

    assert.deepEqual(budgetProblems(jobs, held), [
      "ci.yml's job plan can run on a pull request and has no budget",
      "ci.yml's job tests can run on blacksmith-16vcpu-ubuntu-2404, more than its budget allows: blacksmith-8vcpu-ubuntu-2404, blacksmith-2vcpu-ubuntu-2404",
      "builds.yml's job linux can run on blacksmith-4vcpu-ubuntu-2404-arm, more than its budget allows: blacksmith-4vcpu-ubuntu-2404",
      "the budget for ci.yml's job slow-tests names no job a pull request can run",
    ]);
  });

  it("leaves out a job only the sweep runs, and a called workflow's job its caller turns off", () => {
    const jobs = pullRequestJobs({ read: fixture, files: ['ci.yml', 'builds.yml', 'recheck.yml'] });

    assert.deepEqual(
      jobs.map((job) => `${job.workflow}#${job.id}`),
      ['ci.yml#plan', 'ci.yml#tests', 'ci.yml#proof', 'builds.yml#linux'],
    );
  });

  it('sets a budget at the p95 plus 15%, rounded up to 5 s', () => {
    assert.equal(budgetSeconds([10, 12, 14, 16]), 20);
    assert.equal(budgetSeconds([100]), 115);
    assert.equal(budgetSeconds([71]), 85);
  });
});
