<!--
What: which check applies at each moment of a change to CI.
Where: read by an agent before designing, implementing or merging a workflow change.
Configure: nothing.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Check a CI change

Part of the [`ci-workflows`](../SKILL.md) skill. Read before designing, implementing or merging a workflow change.

What to verify, and the measurements behind it, are in the hub's [checks](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/README.md):

| When | Check |
| --- | --- |
| Before you design a change | [Measure CI before changing it](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/ci-measure-before-changing-it.md), [read what was tried](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/ci-read-what-was-tried.md) and [size a runner by its CPU](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/ci-size-a-runner-by-its-cpu.md) |
| While you build and review it | [Check a change to CI against real output](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/ci-check-a-workflow-change.md) |
| When a run is slow | [Keep slow test files out of the shards](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/ci-keep-slow-files-out-of-the-shards.md) |
| Before it merges | [Check a change to CI against real output](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/ci-check-a-workflow-change.md): its effect on a full and a small run, its cost a month and its budgets, where `.agents/repo/ci.md`'s Runners, budgets and records says. Then [check what CI ran](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/check-what-ci-ran.md) |
| All the time | [Budget CI at list price](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/budget-ci-at-list-price.md), and [run only the checks that decide something](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/run-only-checks-that-decide.md) |

## A job's runner and budget

Each job a pull request can run has a runner and a budget, where the repo keeps them, as ci.md's Runners, budgets and records says. A change that adds a job, or moves one's time or runner, updates them, and its pull request states its modelled effect on a full and a small run's time and its cost a month, which numbers are observed, and which normal run will observe the rest.

A pull request that changes a workflow runs its own version, so its run is the test. A run by hand runs the workflow from the branch it's started on, `--ref`.

## A step that must not gate

A step marked `continue-on-error`, such as one that files flakes or posts a report, can fail every run unseen. One read an empty tree unnoticed: an earlier sparse, blob-less checkout used the workspace, so its own full checkout landed on a clone already at its commit and restored nothing.

- **Give every sparse checkout its own folder,** and make the last checkout before the step a full one into the workspace.
- **Test the workflow's shape:** a test over the workflow file that each step's scripts exist after the last checkout before it, and that no sparse checkout shares the workspace.
- **Read the step's `outcome`,** not its `conclusion`, in a step after it, and post a warning to the run's summary when the checkout, setup or the step itself failed. The run stays green.

