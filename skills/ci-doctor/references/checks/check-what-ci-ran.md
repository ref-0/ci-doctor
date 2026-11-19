<!--
What: a check that the run a PR merges on tested its exact head, against the intended base, with the coverage it needed.
Where: read by an agent before marking a PR ready and before merging it.
Configure: your gate job's name (<gate-job>) and what a PR's run leaves to later tiers, in `.agents/repo/ci.md`.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Check what CI actually ran on the exact head

**Moment:** before merge · **Concern:** tests and CI

## Check

- [ ] GitHub's PR head matches the pushed SHA before the PR is marked ready.
- [ ] The chosen run tested that head against the PR's actual target, `main` or a stacked PR's parent, and completed with the gate job passed, not skipped. In a merge queue, the queue's run on its own SHA is the one that counts.
- [ ] Any change since the reviewed head is only finding fixes and CI fixes, each named in the Verification comment.
- [ ] A slow or container file the change reaches only through a bundle, which a PR's run leaves to `main`'s sweep, ran by hand first if the change is risky to it.
- [ ] The plan and job results show the coverage needed, with skipped work explained.
- [ ] A change to CI's selectors or declaration parsers passed [check a change to CI against real output](ci-check-a-workflow-change.md).
- [ ] The intermediate version is safe to deploy on its own, including enforcement and replacement flows.

## How

Follow [`ci-merge-workflow`](../../../ci-merge-workflow/SKILL.md). Find the target with `gh pr view <pr> --repo <org>/<repo> --json baseRefName,headRefOid`, update the reviewed branch from `origin/<base>` and push before marking it ready, and compare `headRefOid` with the pushed SHA. A stacked PR whose target has no ready-run CI, as `.agents/repo/ci.md` says, stays a draft until its parent merges and it's retargeted. Compare the reviewed head with this one: `git diff --stat <reviewed-sha>..<head>`.

Use `gh pr checks <pr> --repo <org>/<repo>` and `gh run view <run-id> --repo <org>/<repo> --json status,conclusion,jobs`. Read the plan job's log for its `HEAD is now at … Merge <head> into <base>` line. A skipped draft run on the same SHA is not a pass, though GitHub's required-check setting can accept it.

Where a PR's run selects only the slow files its diff changes, or whose own imports it changes, run a file it reaches only through a bundle by hand, as [manual runs](../../../ci-merge-workflow/references/manual-runs.md) says. The repo's `.agents/repo/ci.md` says what each such file checks.

Post Verification with the run, head, tested base, job results and test totals. Whether a run still counts after the base moves, or after a cancellation, is [the decision table](../triage/ci-result.md#does-this-run-count). Then check `main` and the deploy after merging.

## Why

In the source repo, over a few weeks of CI work:

- In the first week, a PR broke `main` for hours because its container tests had not run on the PR.
- From the third week, PRs left far files to `main`'s frequent sweeps: over the three days before, every real catch on a PR was in a file it changed or one that imports it, and each far failure was a flake.
- Measuring import-based selection on 20 merges found over a dozen files with dependencies it missed. Following container imports too far instead selected nearly three times the jobs across the same PRs.
- In the first two weeks, a skipped draft run hid a passing ready run for a while, and a PR's push and ready events tested the old head.
- Design reviews also caught blockers accepted before enforcement, and a connection flow deleted before its replacement, although every merge deploys.

## Pointed at from

- The repo's `AGENTS.md`, through the snippet's Working here line on merging.
- [`ci-merge-workflow`](../../../ci-merge-workflow/SKILL.md) and [`ci-workflows`](../ci-workflows/references/change-checks.md).
