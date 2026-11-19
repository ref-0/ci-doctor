---
name: test-audit
description: "Judge a test's value: the gate for a new or changed test's design, audits of weak or duplicate coverage, and test-only production seams. Use when deciding whether a test should exist or what it proves. Slow or flaky tests: speed-up-tests; models and property tests: proof-tiers; a PR's tests reviewer: code-review."
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

Then check the test against every [junk pattern](#junk-patterns); a match fails
the gate unless the [retention bar](#retention-bar) names the contract it
independently guards. A test that would break under behavior-preserving
refactoring is asserting implementation, not behavior; rewrite it at the
owning boundary before landing it.

Before keeping a test, ask whether it would still pass if every function it
imports returned `undefined`. If yes, it observes no behavior: call the subject
in the test body with one concrete input and assert the literal output or the
observable effect, or delete the test.

A test of a parser, a wire format, a limit or code that must agree with another
implementation may earn properties over generated input, since a hand-picked case
covers only the inputs someone thought of. Where the repo has property tests,
[`proof-tiers`](../proof-tiers/SKILL.md) decides where generated coverage pays for
its cost, and how it runs.

Bug regression tests must fail on the pre-fix code for the intended reason and
pass after the owner-boundary repair. A regression test that never demonstrably
failed proves the mock, not the fix. One regression at the owner boundary
covers the bug; do not replay the same scenario at every layer it crosses.

A fixture seals only what the real producer seals, from the same source. Do not supply fields the real path never supplies. See [producer-faithful fixtures](references/fixtures.md) when writing such fixtures.

## Junk patterns

The shared checklist for both modes: the authoring gate rejects a new test that
matches one, and audits hunt for existing tests that do.

- assertion-free coverage probes;
- self-comparisons and identity copiers;
- copied fixtures, inventories, manifests, or export lists;
- exact source, import, or string greps;
- private predicate or call-shape tests duplicated at real boundaries;
- duplicate invocations of the same contract;
- provider-local replays of shared helpers;
- tests whose only purpose is preserving test-only exports, globals, or wrappers;
- dead production code whose only callers are tests;
- expected values produced by the helper or renderer under test;
- constant pins that restate a hand-maintained constant, config default, table
  row, or prompt string instead of exercising the code that reads it;
- mock-only assertions (`toHaveBeenCalled` alone) where the payload received or
  the state after the call is observable;
- mocks that implement the asserted behavior, or one identical mock standing in
  for different APIs;
- fixtures that supply the receipt, admission, or callback ordering the owner
  should produce, or persistence asserted against a store the path never writes;
- capability tests that restate declared flags instead of exercising the
  delivery or acknowledgement the flag promises;
- negative controls that pass for an unrelated reason, such as a denial from a
  different guard or a rejection the production path never reaches;
- names or fixtures that promise more than the input exercises, such as a
  "retires the window" test asserting the window was not cleared.

## Value bar

Tests justify their maintenance cost by protecting behavior, a credible
regression, or an independently meaningful contract. In an audit, an existing
test that must change for behavior-preserving source reorganization is suspect,
not automatically deletable; the authoring gate still rejects new ones.

Before judging a candidate, read the complete test and production owner, its
entry point, callers, callees, sibling implementations, overlapping tests, CI
routing, and relevant history. Read root and scoped `AGENTS.md` files first.
When the test claims dependency-backed behavior, inspect the dependency source
or types directly.

## Discovery

For an existing-test sweep, read [audit discovery, evidence and handoff](references/audit-workflow.md). Gather evidence before deleting and work in coherent batches.

## Retention bar

Keep a test when it independently enforces a public API, plugin SDK, protocol,
config, migration, storage, security, platform, default, prompt-byte, generated
cross-language, package, release, or architecture contract. Also keep:

- call ordering when order is observable behavior;
- regressions with a credible failure mode;
- source inspection when it is the cheapest independent guard: it fails when
  the contract changes (the user-facing key, byte, or path) and survives an
  identifier-only refactor;
- a retained test that fails on the baseline: treat it as a possible product
  bug, reproduce it, and repair the owner rather than deleting it.

Static or slow is not a deletion reason. A test that resembles implementation
may still be the independent contract; prove otherwise before removing it.

## Validation

Never edit source or tests while a test runner is running in the checkout. This skill owns test value; [make the test fail first](../ci-doctor/references/checks/make-the-test-fail-first.md) and [test the real boundary](../ci-doctor/references/checks/test-the-real-boundary.md) are the checks behind it. [`verify-evidence`](../ci-doctor/references/verify-evidence/TOPIC.md) owns evidence quality: what a check really saw, and what a number really measured.

1. Run each owner or sibling test file by name, filtered to the tests you changed where you can, as the commands block of the repo's `AGENTS.md` says. Never pass a directory, package or glob. Follow it for local checks.
2. For removed source greps or plan assertions, run the executable script or
   dry-run that owns the real contract.
3. Run the repo's format, lint and type check, as its commands block says, then `git diff --check`.
4. Leave the full check, and what the commands block keeps off your
   machine, to the PR's CI run, as its `.agents/repo/ci.md` says
   (template: [`repo-facts/ci.md`](../ci-doctor/references/agent-knowledge/repo-facts/ci.md)).
5. Inspect `git diff --numstat`; report production/tooling separately from
   tests and test support.
