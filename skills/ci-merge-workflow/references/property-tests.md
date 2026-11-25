<!--
What: how a PR's run and main's sweep run property tests, and where a failure's replay is owned.
Where: read by an agent when a property test fails in CI.
Configure: the seeds and depth your PR runs and sweep use, in your repo's `.agents/repo/ci.md`.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Property tests in CI

Part of the [`ci-merge-workflow`](../SKILL.md) skill. Read it when a property test fails in a PR's run or `main`'s sweep.

A PR runs property tests from one fixed seed; `main`'s sweep runs them deeper from a new seed. Replay a failure's exact inputs and environment to tell a counterexample in the code from a nondeterministic harness. [`proof-tiers`' properties](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/proof-tiers/references/properties.md#how-ci-runs-them), if the repo adopted it, owns seeds and replay; [`fix-flaky-test`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/fix-flaky-test/SKILL.md) owns intermittent failures.
