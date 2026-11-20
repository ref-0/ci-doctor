---
name: fix-flaky-test
description: "A test fails sometimes, passes only on a retry or a rerun, or fails only in CI or under load: tell a flake from a real or infrastructure failure, match the symptom, force the interleaving to prove the cause, fix it, prove the fix with repeat runs and retries off, and file what's left. A slow test: speed-up-tests."
metadata:
  version: "0.1.0"
---

<!--
What: how to find a flaky test's cause, fix it, prove the fix and record it.
Where: read by an agent when a test fails sometimes or passes only on a retry.
Configure: your repo's `.agents/repo/ci.md` says whether CI retries and files flakes itself, and its one
verification policy for a flake's fix.
Reference implementation from a production monorepo; adapt to your repo.
-->

# fix-flaky-test

A flake is a wrong answer, not a slow one: a test that fails sometimes, or passes only on a retry. It has a cause, usually an order of events the test doesn't control, and the cause is proved only by forcing that order on purpose. This skill tells a flake from the failures that look like one, finds the cause, fixes it where it lives, proves the fix with retries off, and files what it can't fix yet. A property test's seeds and replay are [`proof-tiers`' properties](https://github.com/ref-0/ci-doctor/blob/next/skills/proof-tiers/references/properties.md#findings-and-replay).

The repo's flake policy decides what the gate does with a flake: whether CI retries, whether a rerun is allowed, whether CI files flakes itself, and how a fix is verified. Where the repo has one, it's in `.agents/repo/ci.md`; read it first. [The policy](references/policy.md) says what it holds, and what to do when the repo has none: ask once, then work to its strictest reading, with no retry, no rerun and every proof local. [Guide section 11](https://ci-doctor.ref0.dev/guide/docs/pages/11-flakes.md) has the automation that files and closes flake issues, and each case below with what its forced runs showed.

[The checks](references/checks.md) this skill follows are here in short: read them before you write a fix and its proof.

## Rules

- **Never** add a retry, raise a bound or skip the test to make it pass. A pass on a retry is a reason to look closer.
- **No cause without a mechanism.** "Load" is a hypothesis until a forced order shows it.
- **Fix it where the fault is:** the fixture, the oracle or the teardown. Change product code only when the cause is a production bug.
- **Keep the repo's gate as it is** until the user approves a change: its retries, reruns and what it files.

## Retries, reruns and infrastructure

Three different events, each reported apart. Keep the repo's current gate behaviour until the user approves a change.

- **An in-job test retry:** the test runner reruns a failed test inside the job, where the repo turns that on. A pass on the retry is recorded as a flake and doesn't turn the job red, so turning retries on changes what the gate accepts.
- **One diagnostic job rerun,** where the repo's policy allows one: a failed job rerun once with `--failed`, on the same revision and configuration. A test that failed and then passed that way is a confirmed flake. Where the policy allows none, or there's no policy, don't rerun: report the failure and prove the cause locally.
- **A second failure:** the rerun failed too. It isn't a flake until shown otherwise: stop and report it to whoever briefed you, with both runs.

A runner or infrastructure failure, such as a lost runner, a full disk, a quota or a network error before any test ran, is none of these: it isn't a flake, and goes to whoever owns the runners.

Before calling anything a flake, split the failure by commit: a failure on one branch alone is that branch's, and a failure after a fix merged may have run the fix's parent. Read the error, not the test's name. For a confirmed flake, use the issue CI filed for it, or, where CI didn't file one, [file this first sighting](#file-whats-left) yourself.

## 1. Match the symptom

Compare the failure's exact error with [the symptoms](references/symptoms.md): `ETXTBSY` across fork and exec, Git's background maintenance, a socket path too long, a fixture server that outlives its run, a refused upload that resets, a reporting step that reads an empty tree, and an installer that keeps its log. Each gives the cause to check, the fix, and how to force it. A match is a lead, not a cause: check the cause before taking the fix.

## 2. Force the interleaving to prove the cause

No match, or a match to check: [find the cause](references/causes.md). In short:

- **Seen only in CI?** Load the machine as CI's runner is loaded (on Linux, pin the test to two cores with `taskset`, with busy loops beside it), and run it about 30 times with console output kept.
- **Force each candidate order:** hold one side, delay the other, fork at the moment the copy is open. Ordinary runs often show neither side; a forced run shows the cause on demand.
- **Can't reproduce it?** Add what the next failure needs to say, such as the read's result or the step a hang stopped at. Don't raise the bound.
- **A randomized failure:** replay its exact inputs and environment, then check the oracle as well as the code.

## 3. Fix it

Take the fix that removes the order the test can't control: a lock every start takes, a fixture that writes what the rest refers to first, a teardown that drains before it resets, a fake that drains a body before it answers, a retry that starts clean of what the first attempt left. Try it against what it might bring back: a fix in one file can fail another's tests.

## Prove the fix

Prove the cause locally: the whole file repeated with no retries, noting how many passed in a row and the load average, and a mutation that reopens the race and fails the test. Then:

- **The PR's own ready run is the CI evidence.** It runs once. Where the repo's policy allows a rerun, a flaky failure in it gets one diagnostic rerun, and a second failure is reported, as [above](#retries-reruns-and-infrastructure) says. Otherwise a failure in it is reported with the run's link, and the proof stays local: the forced interleaving again, then the whole file repeated with retries off.
- **An extra CI repeat needs a reason and a yes:** a specific question a local run can't answer, such as a failure seen only on CI's runners, and the approval of whoever briefed you, as [manual runs](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-merge-workflow/references/manual-runs.md) says. A repeat of no-retry runs then also measures the failure rate: a test that failed 1 in 10 repetitions passes 50 in a row by chance about 1 time in 200.
- **The PR body** gives the local count and load, the mutation, and `Closes #<n>`.

A pull request that closes the issue by hand still has to hold: the next occurrence reopens it.

## File what's left

[Filing](references/filing.md) says what to do when CI files a flake itself, and how to log one it doesn't, the first time you see it: search the `flake` issues, closed ones too, comment one sighting each, reopen one whose fix didn't hold, or open one that names its run. A race in the repo's own code goes the same way, labelled `bug`.

## The tools

[`scripts/flakes/`](https://github.com/ref-0/ci-doctor/blob/next/scripts/flakes/README.md) in the ci-doctor repo files one issue per flaky test from CI and closes it after clean runs, for a repo with an approved retry policy and none of its own. A skills-only install of this folder doesn't carry it: clone ci-doctor once, outside the user's repo, on `next` until the release that adds this skill, then at the release this skill names in `metadata.version`:

```sh
git clone --depth 1 --branch next https://github.com/ref-0/ci-doctor.git <ci-doctor>
```

## Not here

- A test that's slow, not wrong: `speed-up-tests`.
- Reading a PR's CI result, and whether the run counts: the `ci-doctor` hub's [triage](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-doctor/references/triage/TOPIC.md).
- Whether a test is worth keeping: `test-audit`. Model checks and property tests: `proof-tiers`.

## Outside this skill

Every link that leaves this folder is a full link, so it reads the same with this skill installed alone: the guide at [ci-doctor.ref0.dev/guide/](https://ci-doctor.ref0.dev/guide/), and the hub, the other skills and the tools in [the ci-doctor repo](https://github.com/ref-0/ci-doctor) on `next`, the branch the skills track. To read them at a release instead, open the repo at the tag `v<version>`.
