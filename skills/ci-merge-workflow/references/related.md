<!--
What: the skills beside this one, and what each owns.
Where: read by an agent whose PR work turns into a review, a workflow change, caches, runners, a slow or flaky test, or a test's value.
Configure: nothing.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Related skills

Part of the [`ci-merge-workflow`](../SKILL.md) skill: the skills beside it and what each owns. Read it when the work turns to one of them.

- [`review-gate`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/review-gate/SKILL.md), if the repo adopted it: the review and its record, before marking ready. Otherwise, the repo's own review process.
- [`ci-workflows`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-workflows/SKILL.md): change the workflow, its jobs or tiers; [`cache-ci`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/cache-ci/SKILL.md): caches; [`ci-runners`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-runners/SKILL.md) for runners and cost.
- [`speed-up-tests`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/speed-up-tests/SKILL.md): slow tests; [`fix-flaky-test`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/fix-flaky-test/SKILL.md): flaky ones.
- [`test-audit`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/test-audit/SKILL.md), if the repo adopted it: whether a test is worth keeping.
