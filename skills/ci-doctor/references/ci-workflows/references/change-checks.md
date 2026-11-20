<!--
What: which check applies at each moment of a change to CI.
Where: read by an agent before designing, implementing or merging a workflow change.
Configure: nothing.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Check a CI change

Part of the [`ci-workflows`](../TOPIC.md) topic. Read before designing, implementing or merging a workflow change.

What to verify, and the measurements behind it, are in the hub's [checks](../../checks/README.md):

| When | Check |
| --- | --- |
| Before you design a change | [Measure CI before changing it](../../checks/ci-measure-before-changing-it.md), [read what was tried](../../checks/ci-read-what-was-tried.md) and [size a runner by its CPU](../../checks/ci-size-a-runner-by-its-cpu.md) |
| While you build and review it | [Check a change to CI against real output](../../checks/ci-check-a-workflow-change.md) |
| When a run is slow | [Keep slow test files out of the shards](../../checks/ci-keep-slow-files-out-of-the-shards.md) |
| Before it merges | [Check a change to CI against real output](../../checks/ci-check-a-workflow-change.md): its effect on a full and a small run, its cost a month and its budgets, where `.agents/repo/ci.md`'s Runners, budgets and records says. Then [check what CI ran](../../checks/check-what-ci-ran.md) |
| All the time | [Budget CI at list price](../../checks/budget-ci-at-list-price.md), and [run only the checks that decide something](../../checks/run-only-checks-that-decide.md) |

## A step that must not gate

A step marked `continue-on-error`, such as one that files flakes or posts a report, can fail every run unseen. One read an empty tree unnoticed: an earlier sparse, blob-less checkout used the workspace, so its own full checkout landed on a clone already at its commit and restored nothing.

- **Give every sparse checkout its own folder,** and make the last checkout before the step a full one into the workspace.
- **Test the workflow's shape:** a test over the workflow file that each step's scripts exist after the last checkout before it, and that no sparse checkout shares the workspace.
- **Read the step's `outcome`,** not its `conclusion`, in a step after it, and post a warning to the run's summary when the checkout, setup or the step itself failed. The run stays green.

