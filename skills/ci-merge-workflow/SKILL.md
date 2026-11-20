---
name: ci-merge-workflow
description: "Takes a pull request from draft to merged by the repo's merge path, then checks main, the deploy and the release. Use when opening, readying or merging a PR, dispatching CI by hand, or shipping a release. Not for a review (review-gate); a failed check (ci-doctor); a flaky test (fix-flaky-test)."
metadata:
  version: "0.2.0"
---

<!--
What: the CI side of a pull request's life: draft, review, one CI run, merge, and the checks after.
Where: read by a coding agent that opens, reviews or merges a pull request, or runs CI by hand.
Configure: your repo's facts file, `.agents/repo/ci.md`, from the agent-knowledge skill's templates/repo-facts/ci.md.
Reference implementation from a production monorepo; adapt to your repo.
-->

# From draft to merged on one CI run

Read `.agents/repo/ci.md` first (template: [`repo-facts/ci.md`](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/agent-knowledge/templates/repo-facts/ci.md)). Its Entry points and gate names the workflow and its gate job, its Selection and tiers says what a run checks and what waits, and its Merge, releases and deploy says the merge rules. `<org>/<repo>` below is your repo's slug. The `ci-doctor` hub owns reading a run's result ([triage](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/triage/TOPIC.md)) and changes to the workflow ([ci-workflows](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-workflows/SKILL.md)), and [`review-gate`](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/review-gate/SKILL.md), if the repo adopted it, the review before the run; this skill owns the gate, the merge and the checks after it. [guide section 15](https://ci-doctor.ref0.dev/guide/docs/pages/15-the-agent-workflow-around-ci.md) explains why a PR runs CI once.

**Use the repo's existing merge path.** ci.md's Merge, releases and deploy records its base branches, required checks, merge method, approvals and merge queue. The draft-then-one-run flow below is the source repo's. Where the repo runs CI on every push, keep that until the user approves a change, evaluated on its own with the work it avoids measured. Push, mark ready, rerun, dispatch and merge only as the plan authorized; stop at the first action outside it.

**Checks:** [check what CI ran](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/checks/check-what-ci-ran.md), [run only the checks that decide something](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/checks/run-only-checks-that-decide.md), and for a PR that changes CI, [check a change to CI against real output](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/checks/ci-check-a-workflow-change.md).

## 1. Open it as a draft

Push the branch and open the PR as a draft:

```sh
gh pr create --repo <org>/<repo> --draft --title "<area>: <what changes>" --body-file <body-file>
```

Where the repo skips CI on drafts, a draft runs none, or only a gate that shows skipped. It stays a draft through every review round, and is marked ready once, so CI runs once. A PR that needs another's code is stacked on it: start its branch from the parent's tip and pass `--base <parent-branch>`. Its target is then the parent, not `main`, until the parent merges.

Run the tests your change touches locally, by file, while you work. Leave the full suite to the PR's one run.

## 2. Review it while it's a draft

Where the repo adopted [`review-gate`](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/review-gate/SKILL.md), follow it and the repo's `.agents/repo/review.md`: what gets reviewers and what gets behaviour checks and a `No review:` line, at most three rounds, and the session's comment in the record's format, checked with its `review-record.ts`, before marking ready.

## 3. Read the PR's CI result

1. Find the PR's target, `<base>`: `gh pr view <pr> --repo <org>/<repo> --json baseRefName`. Update the branch from `origin/<base>`, merged rather than rebased where the repo allows it, so the reviewed commits stay, and push. After each update, `git diff --stat origin/<base>...HEAD` must list only the files the PR meant to change: a bad conflict resolution can revert another's work. Where ci.md says CI runs ready PRs only against `main`, a stacked PR stays a draft until its parent merges; then retarget it to `main`, update it, check that diff, and only then mark it ready. Check again anything CI checks against the base as it was when the run started, such as migration ids, as ci.md lists them. Every dependency from another of your repos is at a released version, as [releases](references/releases.md) says.
2. Mark it ready with `gh pr ready <pr> --repo <org>/<repo>`. That starts its one run, on the PR merged into its base. Each push while ready starts another and cancels the last. Whether an old run still counts, and what to do when it doesn't, is [the decision table](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/triage/ci-result.md#does-this-run-count).

Read its result as the hub's [triage](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/triage/TOPIC.md) says: which job failed and on what line, whether the run counts, and the exceptions, such as a missing review record, a failure outside the PR's files, a cancelled run or a moving base.

When two open PRs change one shared test helper, the second to merge updates its branch and reruns its type check.

## 4. Run CI by hand

Only to answer what a local run can't, such as a failure CI shows and your machine doesn't, or proving a flake's fix. Read [manual runs](references/manual-runs.md) first.

## 5. Post Verification and merge

Post one comment that starts with `Verification:`, naming the run, the PR's head, the `main` it merged, each job's result with test and file totals, and what didn't run and why. The format is in the hub's [CI result](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/triage/ci-result.md#the-verification-comment).

Merge only when the gate **passed**, not skipped, in a run on the current head after it was marked ready. `gh pr checks` can exit 0 when every check was skipped, and GitHub's required-check setting can accept a skipped job, so read the state yourself. `gh pr view <pr> --repo <org>/<repo> --json mergeable` must answer `MERGEABLE`; `UNKNOWN` means ask again a minute later.

```sh
gh pr merge <pr> --repo <org>/<repo> <merge-method> --match-head-commit <full-head-sha>
```

Use the merge method ci.md names (`--merge`, `--squash` or `--rebase`) and the repo's approvals. Where the repo has a merge queue, merge through it: the queue's run tests its own SHA, and that run's gate is the one that counts. The source repo merged with `--merge` and never auto-merged. In a stack, merge from the bottom up and retarget each next PR to `main` first.

## 6. Check main and the deploy

After merging, read [after a merge](references/after-merge.md): the sweep, your merge's own run and the deploy. Near a release PR or workflow, read [releases](references/releases.md) first.

## Property tests in CI

A PR runs property tests from one fixed seed; `main`'s sweep runs them deeper from a new seed. Replay a failure's exact inputs and environment to tell a counterexample in the code from a nondeterministic harness. [`proof-tiers`' properties](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/proof-tiers/references/properties.md#how-ci-runs-them), if the repo adopted it, owns seeds and replay; [`fix-flaky-test`](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/fix-flaky-test/SKILL.md) owns intermittent failures.

## Related

- [`review-gate`](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/review-gate/SKILL.md), if the repo adopted it: the review and its record, before marking ready. Otherwise, the repo's own review process.
- [`ci-workflows`](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-workflows/SKILL.md): change the workflow, its jobs or tiers; [`cache-ci`](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/cache-ci/SKILL.md): caches; [`ci-runners`](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-runners/SKILL.md) for runners and cost.
- [`speed-up-tests`](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/speed-up-tests/SKILL.md): slow tests; [`fix-flaky-test`](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/fix-flaky-test/SKILL.md): flaky ones.
- [`test-audit`](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/test-audit/SKILL.md), if the repo adopted it: whether a test is worth keeping.
