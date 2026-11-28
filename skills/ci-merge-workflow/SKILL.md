---
name: ci-merge-workflow
description: "Takes a pull request from draft to merged by the repo's merge path, then checks main, the deploy and the release. Use when opening, readying or merging a PR, dispatching CI by hand, or shipping a release. Not for a review (review-gate); a failed check (ci-doctor); a flaky test (fix-flaky-test)."
metadata:
  version: "0.4.0"
---

<!--
What: the CI side of a pull request's life: draft, review, one CI run, merge, and the checks after.
Where: read by a coding agent that opens, reviews or merges a pull request, or runs CI by hand.
Configure: your repo's facts file, `.agents/repo/ci.md`, from the agent-knowledge skill's templates/repo-facts/ci.md.
Reference implementation from a production monorepo; adapt to your repo.
-->

# From draft to merged on one CI run

Read `.agents/repo/ci.md` first (template: [`repo-facts/ci.md`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/agent-knowledge/templates/repo-facts/ci.md)). Its Entry points and gate names the workflow and its gate job, its Selection and tiers says what a run checks and what waits, and its Merge, releases and deploy says the merge rules. `<org>/<repo>` below is your repo's slug. The `ci-doctor` hub owns reading a run's result ([triage](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/triage/TOPIC.md)) and changes to the workflow ([ci-workflows](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-workflows/SKILL.md)), and [`review-gate`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/review-gate/SKILL.md), if the repo adopted it, the review before the run; this skill owns the gate, the merge and the checks after it. [guide section 15](https://ci-doctor.ref0.dev/guide/docs/pages/15-the-agent-workflow-around-ci.md) explains why a PR runs CI once.

**Use the repo's existing merge path.** ci.md's Merge, releases and deploy records its base branches, required checks, merge method, approvals and merge queue. The draft-then-one-run flow below is the source repo's. Where the repo runs CI on every push, keep that until the user approves a change, evaluated on its own with the work it avoids measured. Push, mark ready, rerun, dispatch and merge only as the plan authorized; stop at the first action outside it.

**Checks:** [check what CI ran](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/check-what-ci-ran.md), [run only the checks that decide something](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/run-only-checks-that-decide.md), and for a PR that changes CI, [check a change to CI against real output](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/ci-check-a-workflow-change.md).

## 1. Open it as a draft

When you open the PR, read [opening the draft](references/branches.md#open-the-draft); when it needs another's code, [a stacked PR](references/branches.md#a-stacked-pr).

It stays a draft through every review round, and is marked ready once, so CI runs once.

Run the tests your change touches locally, by file, while you work. Leave the full suite to the PR's one run.

## 2. Review it while it's a draft

Where the repo adopted [`review-gate`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/review-gate/SKILL.md), read [the review](references/review.md) before marking ready.

## 3. Read the PR's CI result

1. Update the branch from its base as [the update before ready](references/branches.md#update-the-branch-before-ready) says, and push.
2. Mark it ready with `gh pr ready <pr> --repo <org>/<repo>`. That starts its one run, on the PR merged into its base. Each push while ready starts another and cancels the last. Whether an old run still counts, and what to do when it doesn't, is [the decision table](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/triage/ci-result.md#does-this-run-count).

Read its result as the hub's [triage](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/triage/TOPIC.md) says: which job failed and on what line, whether the run counts, and the exceptions, such as a missing review record, a failure outside the PR's files, a cancelled run or a moving base.

When a property test fails, read [property tests in CI](references/property-tests.md).

When pull requests run no CI and the merge queue builds them, read [a queue-only repo](references/queue-only.md).

## 4. Run CI by hand

Only to answer what a local run can't, such as a failure CI shows and your machine doesn't, or proving a flake's fix. Read [manual runs](references/manual-runs.md) first.

## 5. Post Verification and merge

Merge only when the gate **passed**, not skipped, in a run on the current head after it was marked ready.

Before you merge, read [merging](references/merge.md): the `Verification:` comment, the gate's state and `mergeable`, the command, the method, a merge queue and a stack.

## 6. Check main and the deploy

After merging, read [after a merge](references/after-merge.md): the sweep, your merge's own run and the deploy. Near a release PR or workflow, read [releases](references/releases.md) first.

## Related

When the work turns to a review, the workflow, caches, runners or their cost, a slow or flaky test, or whether a test is worth keeping, read [related skills](references/related.md).
