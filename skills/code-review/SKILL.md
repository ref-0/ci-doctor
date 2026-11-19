---
name: code-review
description: "Review a pull request while it's a draft, before its one CI run: what gets a review, planning reviewers by what the change reaches, rounds, checking findings, the tests reviewer, and the record CI's gate checks with review-record.ts. For merging, use ci-merge-workflow; a test's value, test-audit."
---

<!--
What: the review procedure a PR goes through before its one CI run: what gets a review, planning reviewers, rounds, findings and the record the gate reads.
Where: read by the agent that runs a PR's review, before it marks the PR ready.
Configure: your repo's `.agents/repo/review.md` (template: the ci-doctor hub's references/agent-knowledge/repo-facts/review.md), its review list, and the CONFIG block of scripts/review-record.ts, kept at <review-checker>.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Code review before the one run

A PR is reviewed while it's a draft, so its one CI run checks the reviewed code. Read the repo's `.agents/repo/review.md` first (template: [`repo-facts/review.md`](../ci-doctor/references/agent-knowledge/repo-facts/review.md)): its systems, review list, review model and account, accepted types and checker. It wins on policy. [guide section 15](../../docs/pages/15-the-agent-workflow-around-ci.md) says why. [`ci-merge-workflow`](../ci-merge-workflow/SKILL.md) takes the PR from here to merged.

## What gets a review

- **A system where a miss is a security hole, loses data or is hard to undo:** sign-in, tokens, secrets and permissions; anything that writes the record of who did what; contracts at the repo's boundaries; stored state and migrations; a bounded model's rules, breaks and bounds; a spike's results when they decide what gets built. The repo's review list names these paths, and the gate reads the base branch's copy, so a PR can't take its own files off it.
- **A change to one of those paths** gets a review whatever kind it is, a refactor or a move included, unless it's a typo, a comment or a small fix: then the body says `No review: low risk.`, and covers at most the low-risk line limit of those paths (20 here).
- **A large change** gets a code quality reviewer, whatever it touches: at least 300 net lines of production source (`largeChange` in the checker), counted from the merge base with the PR's target, leaving out tests, fixtures, generated files and models. A move or a split adds about as many lines as it deletes, so it stays under. Count it from the repo's root with `BASE=<base> node <review-checker> --count`, on Node 24, where `<review-checker>` is the path review.md names. A `No review:` line doesn't cover a large change.
- **Test code** gets one [tests reviewer](references/tests-reviewer.md), in round 1 only. Only `No review: low risk`, within the line limit, covers it.
- **Everything else** gets behaviour checks instead: run it, read its output, show the screen. Its body has a line that starts `No review:` and says why, such as `No review: not an important system.`

## Before you start

- **The model and account are the repo's choice,** as review.md names them, signed in by a person with their own authorized account. Check the CLI's sign-in with its status command. If it isn't signed in, stop and ask a person. Never sign in yourself, and never ask for, paste, print or read a token or credentials file.
- **Name the session** for the PR and the short commit it starts at, such as `<pr>-<head-sha>`, and write its files under that name, so a session never reads an earlier one's output as its own.
- **At a usage limit,** ask before going on without a review.
- **Check for collisions:** `gh pr list --repo <org>/<repo> --search "<file>"` for each file. Look for the same lines, a heading this PR renames (search for links to it) or a table it reflows for one row. Narrow the change, stack on the other PR, or say which merges first. Check again before the last push.

## 1. Plan the reviewers

Read the diff. Give each area the change reaches a reviewer of the type that fits it: red team for a token, system design for a lease, storage for a migration, program design for a contract, fuzzing for a parser, bounded verification for a model's rules, stress test for inputs, experiment and skeptic for a spike's results. A type that reaches several areas gets one reviewer per area. Use 1 to 8 reviewers a round.

- **Each reviewer is one type, in a run of its own,** with its own prompt. Never give one run two types: the record holds each entry to one type.
- **Consider every type in the checker's `consideredTypes`** on a change to the review list's paths: run it, or name it on the `Not run:` line with what the change doesn't reach. The checker fails a session that leaves one out.
- **Every review runs at the effort review.md names** (`high` here). The checker counts no session at another.
- **A reviewer reviews the pushed head,** in a fresh checkout at that commit, never a working tree that's still changing.

## 2. Run rounds, at most three

Keep the PR a draft. Keep a ledger of the reviewers, the types not run and why, and every finding, written before the first reviewer starts, so a restart can resume from it.

- **Round 1** runs every planned reviewer at once, each on its scope.
- **Round 2** runs again only the reviewers whose findings a fix answered, on those fixes alone, when a fix changed behaviour, added a step or touched code near a finding. Small local fixes, a word or a guard, you check yourself. Tests and code quality reviewers get no round 2: tests check their fixes.
- **Round 3** runs only the reviewers that found a P0 or P1 in round 2, on those fixes alone. Nothing after it.
- The session ends after round 1 when it found nothing or every fix was small, after round 3 when round 2 found a P0 or P1, and after round 2 otherwise.

## 3. Check each finding

1. **Reproduce it** with a failing test, a command or a code trace. Agreement is not evidence. Without a real consumer and a reproduction, dismiss it.
2. **Check scope.** Untouched work goes in a follow-up issue.
3. **Rate it P0 to P3** and give it a state:
   - **Fixed:** on the PR's branch, with a regression that fails before and passes after. Fix every in-scope P0 and P1 in the PR.
   - **Filed:** real but out of scope or below P1, as an issue linked from the PR.
   - **Kept:** retained on purpose by a brief or a decision: name the reason and who decided.
   - **Dismissed:** wrong, unreproducible or unreachable: say why, in a sentence of evidence.
   - **Question:** needs a person's decision. Keep working and ask at the end.

Reopen a finding only with evidence its dismissal was wrong or its fix failed. Two reviewers reporting one defect get one row.

## 4. Post the record

Post one comment for the session, before marking ready, in [the record's format](references/record.md). Validate it first with `node <review-checker> --comment <file>`, adding `--covered` when the change touches the review list. Then mark ready, as [`ci-merge-workflow`](../ci-merge-workflow/SKILL.md#3-read-the-prs-ci-result)'s step 3 says.

**The reviewed head is fixed.** The session's first line names the commit its last round reviewed. A later push that changes reviewed code for a new reason, not a finding's fix or a CI fix, starts a new session with its own comment. A CI fix is checked against the findings it touches, not by a new session. Say in the Verification comment what changed since the reviewed head.

**The gate checks the record, not the head.** The checker checks the record's format and reviewer types, from members' comments; it doesn't check that a session covers the head CI tested. So before merging, run `git diff --stat <reviewed-sha>..<head-sha>`: it may hold only finding fixes and CI fixes, each named in the Verification comment. Anything else starts a new session.

## Related

- [`ci-merge-workflow`](../ci-merge-workflow/SKILL.md): the draft, the one CI run, the Verification comment and the merge.
- [`test-audit`](../test-audit/SKILL.md): whether a test is worth keeping; the tests reviewer applies its authoring gate.
- [`verify-evidence`](../ci-doctor/references/verify-evidence/TOPIC.md): for a spike's results, the experiment and skeptic reviewers' bar.
- [`proof-tiers`](../proof-tiers/SKILL.md): a change to a model's rule, break or bound.
