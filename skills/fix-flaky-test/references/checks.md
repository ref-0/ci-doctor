<!--
What: the checks this skill follows, each in short, with a link to the whole check.
Where: read by an agent before it writes a flaky test's fix and its proof.
Configure: nothing; the whole checks are in the ci-doctor hub's references/checks/.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The checks

Part of the [`fix-flaky-test`](../SKILL.md) skill. Each check is one rule; these are their short forms, enough to work from with this skill installed alone. Each whole check, with its commands and the incident behind it, is one link away.

- **[Make the test fail first](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/ci-doctor/references/checks/make-the-test-fail-first.md).** The test fails with the fix absent, or with the behaviour broken on purpose, and its failure names the defect, not an earlier guard or an unrelated rejection. Its assertions run, including a promise or effect it returns. A flake's fix is proved by repeating the test with no retry, plus a mutation that reopens the race and fails it.
- **[Wait for the effect itself](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/ci-doctor/references/checks/wait-for-the-effect.md).** Each wait observes the effect's own result, its event or promise, or a poll of the observed state with a bound, never a state that was true before it ran, and a timeout that runs out prints what it saw. Fixtures keep the invariants the real creation path writes. Restart, timer and deadline tests allow for the lease or asynchronous work they cross. No production export, flag or hook exists only for tests.
- **Judge the evidence,** as the [`prove-it`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/prove-it/SKILL.md) skill says, before you quote a failure rate: say how many runs, at what load and on which machine, and keep a run before the fix beside the runs after it, under the same forced order.
