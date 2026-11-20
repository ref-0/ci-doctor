<!--
What: the checks this skill follows, each in short, with a link to the whole check.
Where: read by an agent before it designs, builds or merges a change to CI.
Configure: nothing; the whole checks are in the ci-doctor hub's references/checks/.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The checks

Part of the [`ci-workflows`](../SKILL.md) skill. Each check is one rule; these are their short forms, enough to work from with this skill installed alone. Each whole check, with its commands and the incident behind it, is one link away. [Check a CI change](change-checks.md) says which applies at each moment.

## Before you design a change

- **[Measure CI before changing it](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/checks/ci-measure-before-changing-it.md).** Price spend by job and event over a complete window, with every attempt, at list price; measure latency over first attempts, with the clock named. Name the limiter from the job graph and step timestamps: queueing, setup, a wait on another job or the work. Model the change from those numbers before building it, and measure its own run the same way. Label every number observed, replayed or modelled.
- **[Read what was tried](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/checks/ci-read-what-was-tried.md).** Search the repo's register of what was tried and dropped before proposing an idea. A repeat says what has changed since, with new measurements. An idea you drop gets a row, with its date, result and the condition to try it again.
- **[Size a runner by its CPU](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/checks/ci-size-a-runner-by-its-cpu.md).** Read a job's median and p90 CPU and its peak memory over a few runs before resizing it. Move down only when the median stays low, the p90 isn't near saturation and the job isn't on the critical path; explain low CPU on a critical-path job first.

## While you build and review it

- **[Check a change to CI against real output](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/checks/ci-check-a-workflow-change.md).** Run every shell and `jq` step on real output; match paths with `git ls-files`; wire each new job into the selector and the gate's `needs:`; check each command substitution's exit status and use `pipefail`; take helpers from `github.workflow_sha`; keep concurrency groups per run kind; and replay real diffs through the old and new version. Before merge, state the change's effect on a full and a small run and its cost a month, and give every job a budget from measured runs.

## When a run is slow

- **[Keep slow test files out of the shards](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/checks/ci-keep-slow-files-out-of-the-shards.md).** No file eligible for the ordinary shards is over the shard cap, by fresh elapsed times. Split one that is, or shorten its waits. A file with no fresh time is listed, not assumed fast: a shard can't end before its longest file.

## Before it merges

- **[Check what CI actually ran](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/checks/check-what-ci-ran.md).** The run tested the PR's exact head against its actual target, and the gate job passed, not skipped. The plan and job results show the coverage needed, with skipped work explained.

## All the time

- **[Budget CI at list price](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/checks/budget-ci-at-list-price.md).** Budget ready-PR runs, runs by hand and scheduled sweeps, and compare the month's spend with the cap at list price, before free minutes. Set the provider's own budget and alerts.
- **[Run only the checks that decide something](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/checks/run-only-checks-that-decide.md).** Each check answers a question that affects the next action. Work in progress stays a draft; a run by hand is one of the repo's approved exceptions; nothing unneeded is left running.
- **Judge the evidence,** as the [`prove-it`](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/prove-it/SKILL.md) skill says: write the decision and the noise floor before measuring, compare like with like, and give every number its count, spread and limiter.
