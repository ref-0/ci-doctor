---
name: test-audit
description: "Judges whether a test is worth having: gates new or changed tests, audits weak or duplicate ones, and test-only hooks in production code. Use when writing or reviewing tests, pruning a suite, or asking what a test proves. Not for slow tests (speed-up-tests); flaky tests (fix-flaky-test); property tests (proof-tiers)."
metadata:
  version: "0.4.0"
---

<!--
What: one value bar for tests: a gate for new tests, an audit for existing ones, a campaign for a subsystem.
Where: read by an agent writing, changing, reviewing or sweeping tests.
Configure: your repo's commands block in AGENTS.md, and its `.agents/repo/ci.md`.
Reference implementation from a production monorepo; adapt to your repo. Adapted from openclaw (MIT); see UPSTREAM.md.
-->

# Test Audit

Three modes, one value bar. Authoring mode gates every new or changed test at
write time. Audit mode runs focused sweeps of tests that re-assert source,
duplicate stronger proof, couple behavior to implementation, or keep test-only
production seams alive. Continue broad audits as separate coherent follow-up
PRs; optimize for confidence, not deletion count. Campaign mode prunes one
whole subsystem's test surface (every test file a plugin or core area owns);
before starting one, read [CAMPAIGN.md](CAMPAIGN.md).

## Authoring gate

Before adding any test, answer four questions; a missing answer means do not
add it yet:

1. What observable behavior, invariant, or independent contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch that failure? Each contract has
   one primary test owner at the strongest boundary; another layer needs its
   own distinct risk, such as a transport or lifecycle failure the owner cannot
   reach. Prefer extending a table-driven case or shared fixture over a
   near-duplicate test; consolidate duplicated setup in the same change.
4. Does it need a production seam (export, flag, wrapper, injection hook) that no
   production caller needs? If yes, move the test to the real boundary instead.

Then check the test against every [junk pattern](references/junk-patterns.md); a match fails
the gate unless the [retention bar](references/junk-patterns.md#retention-bar) names the contract it
independently guards. A test that would break under behavior-preserving
refactoring is asserting implementation, not behavior; rewrite it at the
owning boundary before landing it.

Before keeping a test, ask whether it would still pass if every function it
imports returned `undefined`. If yes, it observes no behavior: call the subject
in the test body with one concrete input and assert the literal output or the
observable effect, or delete the test.

When the test covers a parser, a wire format, a limit or code that must agree with another implementation, read [generated input](references/property-tests.md).

Bug regression tests must fail on the pre-fix code for the intended reason and
pass after the owner-boundary repair. A regression test that never demonstrably
failed proves the mock, not the fix. One regression at the owner boundary
covers the bug; do not replay the same scenario at every layer it crosses.

A fixture seals only what the real producer seals, from the same source. Do not supply fields the real path never supplies. See [producer-faithful fixtures](references/fixtures.md) when writing such fixtures.

## Value bar

Tests justify their maintenance cost by protecting behavior, a credible
regression, or an independently meaningful contract. In an audit, an existing
test that must change for behavior-preserving source reorganization is suspect,
not automatically deletable; the authoring gate still rejects new ones.

When judging an existing test as a candidate, read [candidate evidence](references/audit-workflow.md#candidate-evidence) and [the retention bar](references/junk-patterns.md#retention-bar).

## Discovery

For an existing-test sweep, read [audit discovery, evidence and handoff](references/audit-workflow.md). Gather evidence before deleting and work in coherent batches.

## Validation

Never edit source or tests while a test runner is running in the checkout. This skill owns test value; [make the test fail first](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/make-the-test-fail-first.md) and [test the real boundary](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/test-the-real-boundary.md) are the checks behind it. [`prove-it`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/prove-it/SKILL.md) owns evidence quality: what a check really saw, and what a number really measured.

When you have edited tests or source, read [the validation steps](references/validation.md).
