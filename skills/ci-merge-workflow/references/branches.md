<!--
What: opening a PR as a draft, a stacked PR, and updating a PR's branch from its base before marking it ready.
Where: read by an agent that opens a PR as a draft or on another's branch, or updates a branch before marking it ready.
Configure: whether CI runs ready PRs only against `main`, and what CI checks against the base, such as migration ids, in your repo's `.agents/repo/ci.md`.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Drafts, stacks and branch updates

Part of the [`ci-merge-workflow`](../SKILL.md) skill: opening the draft, a stacked PR, and the update before marking ready. Read it when you open a PR, when it needs another's code, and before marking it ready.

## Open the draft

Push the branch and open the PR as a draft:

```sh
gh pr create --repo <org>/<repo> --draft --title "<area>: <what changes>" --body-file <body-file>
```

Where the repo skips CI on drafts, a draft runs none, or only a gate that shows skipped.

## A stacked PR

A PR that needs another's code is stacked on it: start its branch from the parent's tip and pass `--base <parent-branch>`. Its target is then the parent, not `main`, until the parent merges.

## Update the branch before ready

Find the PR's target, `<base>`: `gh pr view <pr> --repo <org>/<repo> --json baseRefName`. Update the branch from `origin/<base>`, merged rather than rebased where the repo allows it, so the reviewed commits stay, and push. After each update, `git diff --stat origin/<base>...HEAD` must list only the files the PR meant to change: a bad conflict resolution can revert another's work. Where ci.md says CI runs ready PRs only against `main`, a stacked PR stays a draft until its parent merges; then retarget it to `main`, update it, check that diff, and only then mark it ready. Check again anything CI checks against the base as it was when the run started, such as migration ids, as ci.md lists them. Every dependency from another of your repos is at a released version, as [releases](releases.md) says.

When two open PRs change one shared test helper, the second to merge updates its branch and reruns its type check.
