<!--
What: the Verification comment, the gate's state before merging, the merge command, the merge method and queue, and merging a stack.
Where: read by an agent about to merge a PR whose gate passed.
Configure: the merge method, approvals and merge queue in your repo's `.agents/repo/ci.md`'s Merge, releases and deploy.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Merging

Part of the [`ci-merge-workflow`](../SKILL.md) skill: the Verification comment, the gate's state, the merge command, its method and a stack. Read it before you merge.

## The Verification comment

Post one comment that starts with `Verification:`, naming the run, the PR's head, the `main` it merged, each job's result with test and file totals, and what didn't run and why. The format is in the hub's [CI result](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/triage/ci-result.md#the-verification-comment).

## The gate's state

`gh pr checks` can exit 0 when every check was skipped, and GitHub's required-check setting can accept a skipped job, so read the state yourself. `gh pr view <pr> --repo <org>/<repo> --json mergeable` must answer `MERGEABLE`; `UNKNOWN` means ask again a minute later.

## The command

```sh
gh pr merge <pr> --repo <org>/<repo> <merge-method> --match-head-commit <full-head-sha>
```

Use the merge method ci.md names (`--merge`, `--squash` or `--rebase`) and the repo's approvals. Where the repo has a merge queue, merge through it: the queue's run tests its own SHA, and that run's gate is the one that counts. The source repo merged with `--merge` and never auto-merged. In a stack, merge from the bottom up and retarget each next PR to `main` first.
