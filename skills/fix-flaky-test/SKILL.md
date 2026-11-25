---
name: fix-flaky-test
description: "Finds why a flaky test fails, fixes it and proves the fix. Use when a test fails sometimes, passes only on a retry or rerun, fails only in CI or under load, or is intermittent. Not for a slow test (speed-up-tests); a check that fails every time (ci-doctor)."
metadata:
  version: "0.4.0"
---

<!--
What: how to find a flaky test's cause, fix it, prove the fix and record it.
Where: read by an agent when a test fails sometimes or passes only on a retry.
Configure: your repo's `.agents/repo/ci.md` says whether CI retries and files flakes itself, and its one
verification policy for a flake's fix.
Reference implementation from a production monorepo; adapt to your repo.
-->

# fix-flaky-test

A flake is a wrong answer, not a slow one: a test that fails sometimes, or passes only on a retry. It has a cause, usually an order of events the test doesn't control, and the cause is proved only by forcing that order on purpose. This skill tells a flake from the failures that look like one, finds the cause, fixes it where it lives, proves the fix with retries off, and files what it can't fix yet. A property test's seeds and replay are [`proof-tiers`' properties](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/proof-tiers/references/properties.md#findings-and-replay).

The repo's flake policy decides what the gate does with a flake: whether CI retries, whether a rerun is allowed, whether CI files flakes itself, and how a fix is verified. Where the repo has one, it's in `.agents/repo/ci.md`; read it first. [The policy](references/policy.md) says what it holds, and what to do when the repo has none: ask once, then work to its strictest reading, with no retry, no rerun and every proof local. [Guide section 11](https://ci-doctor.ref0.dev/guide/docs/pages/11-flakes.md) has the automation that files and closes flake issues, and each case below with what its forced runs showed.

[The checks](references/checks.md) this skill follows are here in short: read them before you write a fix and its proof.

## Rules

- **Never** add a retry, raise a bound or skip the test to make it pass. A pass on a retry is a reason to look closer.
- **No cause without a mechanism.** "Load" is a hypothesis until a forced order shows it.
- **Fix it where the fault is:** the fixture, the oracle or the teardown. Change product code only when the cause is a production bug.
- **Keep the repo's gate as it is** until the user approves a change: its retries, reruns and what it files.

## Retries, reruns and infrastructure

When you tell an in-job retry, a diagnostic rerun, a second failure and an infrastructure failure apart, read [retries, reruns and infrastructure](references/policy.md#retries-reruns-and-infrastructure).

Before calling anything a flake, split the failure by commit: a failure on one branch alone is that branch's, and a failure after a fix merged may have run the fix's parent. Read the error, not the test's name. For a confirmed flake, use the issue CI filed for it, or, where CI didn't file one, [file this first sighting](#file-whats-left) yourself.

## 1. Match the symptom

Compare the failure's exact error with [the symptoms](references/symptoms.md). A match is a lead, not a cause: check the cause before taking the fix.

## 2. Force the interleaving to prove the cause

No match, or a match to check: [find the cause](references/causes.md). In short:

- **Force each candidate order:** hold one side, delay the other, fork at the moment the copy is open. Ordinary runs often show neither side; a forced run shows the cause on demand.

## 3. Fix it

Take the fix that removes the order the test can't control: a lock every start takes, a fixture that writes what the rest refers to first, a teardown that drains before it resets, a fake that drains a body before it answers, a retry that starts clean of what the first attempt left. Try it against what it might bring back: a fix in one file can fail another's tests.

## Prove the fix

Prove the cause locally: the whole file repeated with no retries, noting how many passed in a row and the load average, and a mutation that reopens the race and fails the test. Then:

- **The PR's own ready run is the CI evidence.** It runs once. Where the repo's policy allows a rerun, a flaky failure in it gets one diagnostic rerun, and a second failure is reported, as [above](#retries-reruns-and-infrastructure) says. Otherwise a failure in it is reported with the run's link, and the proof stays local: the forced interleaving again, then the whole file repeated with retries off.
- **The PR body** gives the local count and load, the mutation, and `Closes #<n>`.

When a question needs CI to repeat the test, read [an extra CI repeat](references/policy.md#an-extra-ci-repeat).

A pull request that closes the issue by hand still has to hold: the next occurrence reopens it.

## File what's left

[Filing](references/filing.md) says what to do when CI files a flake itself, and how to log one it doesn't, the first time you see it. When the repo has an approved retry policy and no flake script of its own, read [the tools](references/filing.md#the-tools).

## Not here

- A test that's slow, not wrong: `speed-up-tests`.
- Reading a PR's CI result, and whether the run counts: the `ci-doctor` hub's [triage](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/triage/TOPIC.md).
- Whether a test is worth keeping: `test-audit`. Model checks and property tests: `proof-tiers`.

## Outside this skill

Every link that leaves this folder is a full link, so it reads the same with this skill installed alone: the guide at [ci-doctor.ref0.dev/guide/](https://ci-doctor.ref0.dev/guide/), and the hub, the other skills and the tools in [the ci-doctor repo](https://github.com/ref-0/ci-doctor) at the tag `v<version>`, the release this skill names in `metadata.version`.
