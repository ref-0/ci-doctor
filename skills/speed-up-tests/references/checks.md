<!--
What: the checks this skill follows, each in short, with a link to the whole check.
Where: read by an agent before it changes a slow test, and before it quotes a number.
Configure: nothing; the whole checks are in the ci-doctor hub's references/checks/.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The checks

Part of the [`speed-up-tests`](../SKILL.md) skill. Each check is one rule; these are their short forms, enough to work from with this skill installed alone. Each whole check, with its commands and the incident behind it, is one link away.

## Before you change a test

- **[Wait for the effect itself](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/ci-doctor/references/checks/wait-for-the-effect.md).** A fixture keeps the invariants the real creation path writes, and seeded IDs pass the real decoders. Each wait observes the effect's own result, its event or promise, or a poll of the observed state with a bound, never a state that was true before it ran. A timeout that runs out prints what it saw. A proof of scheduling goes through the production scheduler, and no production export, flag or hook exists only for tests.
- **[Keep slow test files out of the shards](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/ci-doctor/references/checks/ci-keep-slow-files-out-of-the-shards.md).** No file eligible for the ordinary shards is over the shard cap, by fresh elapsed times. A file over it is split along its `describe`s, or its waits shortened. No test waits out a timer in the code it runs: the harness shortens it, or the test moves the recorded time back. A file with no fresh time is listed, not assumed fast.
- **[Read what was tried](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/ci-doctor/references/checks/ci-read-what-was-tried.md).** Search the repo's register of what was tried and dropped for the idea before proposing it. A repeat says what has changed since, with new measurements. An idea you drop gets a row, with its date, result and the condition to try it again.

## Before you quote a number

- **[Measure CI before changing it](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/ci-doctor/references/checks/ci-measure-before-changing-it.md).** Name the limiter from the job graph and step timestamps, model the change from those numbers before building it, and measure its own run the same way afterwards. Label every number observed, replayed or modelled.
- **Judge the evidence,** as the [`prove-it`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/prove-it/SKILL.md) skill says: write the decision and the noise floor before measuring, compare like with like, interleave the runs, keep a control, and give every number its count, spread and limiter. [Measuring](measuring.md) has what's particular to tests.

## Before you merge

- **[Check what CI actually ran](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/ci-doctor/references/checks/check-what-ci-ran.md).** The run tested the PR's exact head against its actual target, and the gate job passed, not skipped. The plan chose the changed files, they ran, and their times match: green checks can hide a file that never ran.
