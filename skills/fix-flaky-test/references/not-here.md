<!--
What: the work beside a flake that other skills own, and how links out of this skill resolve.
Where: read by an agent when the task isn't a flake's cause, fix or proof, or when it follows a link out of this skill's folder.
Configure: nothing.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Not here

Part of the [`fix-flaky-test`](../SKILL.md) skill: what other skills own, and where links out of this folder go. Read it when the task is a slow test, a PR's CI result, a test's worth or a model check, or when you follow a link out of this folder.

- A test that's slow, not wrong: `speed-up-tests`.
- Reading a PR's CI result, and whether the run counts: the `ci-doctor` hub's [triage](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/triage/TOPIC.md).
- Whether a test is worth keeping: `test-audit`. Model checks and property tests: `proof-tiers`.

## Outside this skill

Every link that leaves this skill's folder is a full link, so it reads the same with this skill installed alone: the guide at [ci-doctor.ref0.dev/guide/](https://ci-doctor.ref0.dev/guide/), and the hub, the other skills and the tools in [the ci-doctor repo](https://github.com/ref-0/ci-doctor) at the tag `v<version>`, the release this skill names in `metadata.version`.
