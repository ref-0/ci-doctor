<!--
What: the order of work for pruning one subsystem's whole test surface in one PR.
Where: read by an agent before it starts a test-pruning campaign.
Configure: your repo's permitted local checks, in its AGENTS.md commands block.
Reference implementation from a production monorepo; adapt to your repo. Adapted from openclaw (MIT); see UPSTREAM.md.
-->

# Test-pruning campaign

The Telegram examples are upstream openclaw history, not paths or tooling in your repo. Use the commands block of your repo's `AGENTS.md` for permitted checks: name test files, leave builds and what it keeps off your machine to CI, and never run a subsystem suite locally.

Campaign mode prunes one subsystem's whole test surface in one PR: a plugin
such as `extensions/telegram`, or one core area. The value bar, retention bar,
candidate evidence, and validation in [SKILL.md](SKILL.md) apply to every
lane. This file adds the order of work and the lessons of a full campaign.
Each step ends on its completion criterion; do not start the next step early.

## 1. Baseline

Record the subsystem's test and support line counts and every test file's
pass/fail state at a pinned `main` SHA. Take each file's state from CI's
records of runs that executed it at that SHA, not from runs that replayed it
from a cache. Fill the gaps with the named-file checks the repo's machine
policy permits, and mark each file still without a result "unknown" before
planning any cut; an unknown file gets no `D`. Keep baseline failures in their
own list: in the Telegram campaign, all three were real delivery bugs, not
stale tests.

Done when every in-scope test file has a recorded baseline result or an
explicit "unknown".

## 2. Lanes and inventory

Split the surface into **lanes** along production owner boundaries, not file
prefixes. For Telegram these were accounts, commands, context, dispatch,
inbound, outbound, persistence, transport, shared, harness, and live/QA
scenarios. Include the subsystem's cases at shared core boundaries and its QA
and live-proof harness tests.

Done when every test file and QA scenario the subsystem owns belongs to exactly
one lane.

## 3. Read-only ledger per lane

Give each lane to its own read-only agent where you can run them in
parallel; a single agent works the lanes one after another, with the same
ledger. The agent reads every assigned test
in full, including parameter tables. It also reads the production owners and
their entry points, callers, history, and CI routing. Each test declaration
goes into a written **ledger** with one mark. An `it.each` is one declaration
unless its rows need different marks; then mark each row.

- `R`: retain, naming the contract and the bug it catches; a retained test that
  only moves to a better-named file stays `R` with the move noted;
- `F`: retain the contract but repair the assertion, such as a vacuous negative
  that passes when only one of several items is missing;
- `C`: consolidate, naming the owner that absorbs the assertion first: a sibling
  table case, a stronger boundary suite, or the shared owner in another package;
- `D`: delete, naming the proof that remains, or why no contract exists.

Judge a test by its assertions, not its name. One Telegram test named for
retiring a progress window asserted the window was _not_ cleared.

Done when every declaration in the lane has a mark and an evidence line.

## 4. Layer plan per lane

Treat the per-test ledger as input, not as the edit list. A second read-only
pass, starting from the ledger, looks for the redundant **layer**. In Telegram,
several dispatch suites replayed the same shared compositor through one mocked
preview, around stronger real-stream and HTTP-fixture suites. Name the
**keeper** suite for each contract. Prefer the real transport boundary with a
fake network over a mocked collaborator. Correct any ledger errors this pass
finds.

Done when each lane plan names its retired files, its keeper per contract, the
assertions to carry into keepers, and the test-only production seams unlocked.

## 5. Cutover

Edit lane by lane. Serialize changes to shared harnesses and support files
through one owner. With each lane, remove the test-only production seams it
unlocks: injection parameters, getters, reset exports, and indirection layers.
Register moved suites in CI routing and test inventories. Update line-cap baselines only if the target repo has them. Put durable test-ownership rules in the subsystem's
`AGENTS.md`, drawn from mistakes this campaign actually found.

Done when every lane plan is applied and each lane's keepers pass.

## 6. Preservation review

This is a separate coverage audit owned by the campaign lead, not a PR review round ([`review-gate`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/review-gate/references/tests-reviewer.md)'s, where the repo adopted it). Use at most one independent pass per boundary group; the lead resolves gaps with source evidence and mutation checks, without repeated review rounds.

Before claiming completion, have independent reviewers compare deleted
coverage against the keepers, one reviewer per boundary group. This review is
required whenever the campaign deletes or consolidates a test; a single agent
without another reviewer stops here and reports the campaign blocked on it,
with the ledger and lane plans, rather than reviewing its own deletions. They look for
contracts that lost their only proof. They also look for new assertions that
cannot fail, such as a rejection row the production code never reaches. The
Telegram review found nine real gaps and one unreachable assertion.

For each restored contract, make one deliberate **mutation** of the production
owner and confirm the keeper goes red. Then restore the source byte for byte.

Done when every reported gap is restored or rejected with source evidence, and
every restored contract has a caught mutation.

## 7. Product defects

A baseline failure that survives into a keeper is a bug report. Fix it at its
owner as a separate commit, and prove it through the real user flow, with a
**control** run that reverts the fix and shows the old behavior. Record
unrelated product discrepancies you find as follow-ups instead of fixing them
in the campaign.

Done when each repaired defect has a failing control and a passing candidate
on the same harness.

## 8. Reconcile and hand off

Campaigns outlive many `main` commits. Merge `main` rather than rebasing a
long, many-commit campaign. When `main` modified a file the campaign
deleted, keep the deletion. Port the new contract into the keeper instead, and
confirm every new regression `main` added still has a home. Name each affected test file for focused checks and use the PR's CI run for the broader suite. Repeat live proof in an authorized environment on the merged head.

Expect review tooling to see a truncated file list on a diff this large.
Record maintainer decisions for generic compatibility flags in the PR evidence
rather than editing gates.

Hand off with the [audit handoff](references/audit-workflow.md#handoff), plus:

- baseline and final test/support line counts, with production counted separately;
- lanes, retired layers, and keepers;
- preservation gaps found and their mutations;
- product defects with control and candidate proof.
