---
name: review-gate
description: "The review gate in CI, for a repo that adopted it (.agents/repo/review.md): a draft reviewed before its one CI run, what the gate requires, the tests reviewer, and the record CI's result job checks with review-record.ts. Otherwise follow the repo's own review. Merging: ci-merge-workflow; a test's value: test-audit."
---

<!--
What: the review gate in CI: a PR reviewed while it's a draft, what the gate requires, the tests reviewer, and the record CI's result job checks.
Where: read by the agent that runs a PR's review, before it marks the PR ready.
Configure: your repo's `.agents/repo/review.md` (template: the ci-doctor hub's references/agent-knowledge/repo-facts/review.md), its review list, and the checker's settings in `.agents/repo/review-record.json`, for scripts/review-record.ts, kept at <review-checker>.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The review gate before the one CI run

A PR is reviewed while it's a draft, so its one CI run tests reviewed code, and CI's result job fails a ready PR without a valid review record. This skill is that gate: what it requires, the tests reviewer, the record and the reviewed head. **Use it only if the repo adopted the gate,** with `.agents/repo/review.md` (template: [`repo-facts/review.md`](../ci-doctor/references/agent-knowledge/repo-facts/review.md)). Otherwise the repo's own review process applies, and nothing here does.

Who reviews, with which reviewer types and in how many rounds is the repo's own choice, written in review.md and the checker's settings, and it wins on policy. [Guide section 15](../../docs/pages/15-the-agent-workflow-around-ci.md#how-we-run-a-review) describes the review we ran: reviewers by what a change reaches, up to three rounds, and how each finding is checked. [`ci-merge-workflow`](../ci-merge-workflow/SKILL.md), if the repo adopted it, takes the PR from here to merged; otherwise the repo's own merge path does.

## What the gate requires

The checker, `review-record.ts`, reads the repo's settings in `.agents/repo/review-record.json`. From the repo's root, on Node 24, `BASE=<base> node <review-checker> --count` says which of these a PR is, where `<review-checker>` is the path review.md names.

- **A change to the review list's paths** (`.agents/repo/review-paths.txt`, read from the base branch, so a PR can't take its own files off it) gets a review, whatever kind of change it is. Every type in the settings' `consideredTypes` is either run or named on the record's `Not run:` line. Only a typo, a comment or a small fix within the low-risk line limit (`lowRiskLines`, 20 here) skips it, with `No review: low risk.` in the body.
- **A large change,** at least `largeChange` net lines of production source (300 here) from the merge base, tests, fixtures, generated files and models left out, gets a code quality reviewer, whatever it touches. A `No review:` line doesn't cover it.
- **Test code** (`testCode`'s globs) gets one [tests reviewer](references/tests-reviewer.md). Only `No review: low risk`, within the line limit, covers it.
- **Everything else** gets behaviour checks instead: run it, read its output, show the screen. Its body has a line that starts `No review:` and says why, such as `No review: not an important system.`

## Run the review

- **The model, account and effort are review.md's,** signed in by a person with their own authorized account. Check the CLI's sign-in with its status command. If it isn't signed in, stop and ask a person. Never sign in yourself, and never ask for, paste, print or read a token or credentials file. At a usage limit, ask before going on without a review.
- **Each reviewer is one of the settings' `reviewTypes`,** in a run of its own, at the effort the checker requires. The record holds each entry to one type.
- **A reviewer reviews the pushed head,** in a fresh checkout at that commit, never a working tree that's still changing.
- **Each finding gets a severity, P0 to P3, and a state** (fixed, filed, kept, dismissed or a question), as [the record](references/record.md) lists them. Fix every in-scope P0 and P1 in the PR, each with a regression test that fails before and passes after.

## Post the record

Post one comment for the session, before marking ready, in [the record's format](references/record.md). Validate it first with `node <review-checker> --comment <file>`, adding `--covered` when the change touches the review list. Then mark ready, as [`ci-merge-workflow`](../ci-merge-workflow/SKILL.md#3-read-the-prs-ci-result)'s step 3 says if the repo adopted it, or by the repo's own merge path.

## The reviewed head

**It's fixed.** The session's first line names the commit its last round reviewed. A later push that changes reviewed code for a new reason, not a finding's fix or a CI fix, starts a new session with its own comment. A CI fix is checked against the findings it touches, not by a new session. Say in the Verification comment what changed since the reviewed head.

**The gate checks the record, not the head.** The checker checks the record's format and reviewer types, from members' comments; it doesn't check that a session covers the head CI tested. So before merging, run `git diff --stat <reviewed-sha>..<head-sha>`: it may hold only finding fixes and CI fixes, each named in the Verification comment. Anything else starts a new session.

## Related

- [`ci-merge-workflow`](../ci-merge-workflow/SKILL.md), if the repo adopted it: the draft, the one CI run, the Verification comment and the merge.
- [`test-audit`](../test-audit/SKILL.md), if the repo adopted it: whether a test is worth keeping; the tests reviewer applies its authoring gate.
- [`proof-tiers`](../proof-tiers/SKILL.md), if the repo adopted it: a change to a model's rule, break or bound.
