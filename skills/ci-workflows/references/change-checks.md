<!--
What: which check applies at each moment of a change to CI.
Where: read by an agent before designing, implementing or merging a workflow change.
Configure: nothing.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Check a CI change

Part of the [`ci-workflows`](../SKILL.md) skill. Read before designing, implementing or merging a workflow change.

What to verify, and the measurements behind it, are in this repo's [`checks/`](../../../checks/README.md):

| When | Check |
| --- | --- |
| Before you design a change | [Measure CI before changing it](../../../checks/ci-measure-before-changing-it.md), [read what was tried](../../../checks/ci-read-what-was-tried.md) and [size a runner by its CPU](../../../checks/ci-size-a-runner-by-its-cpu.md) |
| While you build and review it | [Check a change to CI against real output](../../../checks/ci-check-a-workflow-change.md) |
| When a run is slow | [Keep slow test files out of the shards](../../../checks/ci-keep-slow-files-out-of-the-shards.md) |
| Before it merges | [Check a change to CI against real output](../../../checks/ci-check-a-workflow-change.md): its effect on a full and a small run, its cost a month and its budgets, where `.agents/repo/ci.md`'s Runners, budgets and records says. Then [check what CI ran](../../../checks/check-what-ci-ran.md) |
| All the time | [Budget CI at list price](../../../checks/budget-ci-at-list-price.md), and [run only the checks that decide something](../../../checks/run-only-checks-that-decide.md) |
