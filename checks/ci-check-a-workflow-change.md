<!--
What: a check that a change to CI's workflows, actions, selector or shard script was tried against real output before it merges.
Where: read by an agent changing or reviewing anything that decides what CI runs.
Configure: your selector script, shard script, gate job (<gate-job>) and the budgets file `.agents/repo/ci.md` names.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Check a change to CI against real output

**Moment:** build and review · **Concern:** tests and CI

Applies to changes to workflows, composite actions, the script that selects checks and the script that packs shards.

## Check

- [ ] Every shell and `jq` step the plan feeds was run locally, on `git ls-files` and the selector's real output, trailing slashes included.
- [ ] Path matching uses `git ls-files -- <paths>`, not a hand-rolled prefix test.
- [ ] Every new job, and every new plan output a job's `if:` reads, is wired the way the repo's selector needs, as `.agents/repo/ci.md` records it: registered in the planner and its job-selection checks where it registers jobs, and in the gate's `needs:`, so the gate (`<gate-job>`) waits for it. The selector's fallback for an unknown path, such as selecting every job, is tested with the sentinel cases ci.md lists.
- [ ] Each dependency is expressed through `needs:` or the wait helper, and changing a dependency selects the jobs that wait for it.
- [ ] Each `needs:` names a job ID (the key under `jobs:`), and each name the wait helper looks up matches the key it reads, a job's displayed `name:` as the run lists it, matrix suffix included, where it reads names.
- [ ] Each command substitution whose failure matters is its own assignment, `x=$(cmd)`, with its exit status checked (`set -e`, or `|| exit 1`). Pipelines whose failure matters run under `set -o pipefail` too: that's a separate setting.
- [ ] Helpers a job runs on an older commit come from `github.workflow_sha`, not the checked-out ref.
- [ ] Concurrency groups are per run kind, so a run by hand can't cancel a pull request's run.
- [ ] A rerun can't cancel a newer run, and a later incremental run checks every commit since the newest passing ancestor, including commits of failed or cancelled runs. Both orders of start-up and cancellation are tested.
- [ ] A parser of a PR body or a comment counts every prefixed line, including ones in code blocks.
- [ ] Before merge: [what was tried](ci-read-what-was-tried.md) was read, and the PR states the change's modelled effect on a full and a small run's time and its cost a month (cost a run × runs a month), which of those numbers its own run observed, and which normal run will observe the rest. A full run's numbers come from fresh elapsed times over a checked inventory, not from replays.
- [ ] The budgets file holds a budget for every job: its p95 plus 15%, rounded up to 5 s.
- [ ] Every job whose work or runner changes has its budget recomputed from measured runs, with those runs recorded beside it, or marked provisional with the evidence still needed before merge as ci.md requires, and the budgets' completeness test passes. A budget is raised only for a change that buys work or service, never to quiet the health report.
- [ ] The PR's monthly projection counts full and small runs by how often each happens.

## How

- Run the plan's commands on a real diff before pushing, and print the selector's output for it. Then replay a handful of real pull requests' diffs through the old and the new version, and read each decision that changed.
- Replay one real diff for each case above: a new job, a new plan output, a dependency change, and a rerun racing a newer run.
- To try a workflow change on its branch by hand, where ci.md approves that dispatch, pass `--ref <branch>`, which picks the workflow, and `-f ref=<branch>`, which picks the code, only if the workflow declares a `ref` input, as [manual runs](../skills/ci-merge-workflow/references/manual-runs.md) says.
- After merge, read the health workflow's report, where your repo has one: it flags a job over its budget, and a test shard whose p95 passes a threshold (110 s here, a policy value), since past 120 s every shard bills a third minute at once.
- Read the first real run's job list and log, as [check what CI ran](check-what-ci-ran.md) says.

## Why

In the source repo:

- A filter for one app's folder matched nothing, because the plan prints folders with a trailing slash.
- Container test parts failed on refs that predated a helper, until helpers came from `workflow_sha`.
- Body parsers dropped real lines that sat in code blocks.
- Vitest's test path filter matches path parts, so a short name picked other files too.
- About 20 PRs together took a full run to well under half its time, and a small one to about half. Then deep property tests ran on every full run, on 2 vCPU and ending last, unnoticed until they moved to the daily sweep. Per-job budgets and a daily health check were added so the next slip is flagged.

## Pointed at from

- [`ci-workflows`](../skills/ci-workflows/references/change-checks.md), while you build a CI change and before it merges.
- [`ci-workflows`](../skills/ci-workflows/references/selection.md), on changing selection.
