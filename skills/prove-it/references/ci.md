<!--
What: where a claim about CI finds its records, and the CI-specific rules for it, in the ci-doctor hub.
Where: read by a coding agent checking a CI baseline, a before and after, a CI cost, a slow-test campaign's report or a spike.
Configure: nothing; links go to the ci-doctor repo at this skill's release.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Where this applies in CI

Part of the [`prove-it`](../SKILL.md) skill: the CI records and rules for a claim about CI. Read it when the claim is about a CI run, its history or its cost.

CI's records and the rules particular to them are in the `ci-doctor` plugin's hub. Links go to the [ci-doctor repo](https://github.com/ref-0/ci-doctor/tree/v0.4.0) at this skill's release:

- A CI baseline or a before and after: [measuring](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/speed-up-tests/references/measuring.md) for where the records are and the test-specific rules, [CI history data](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/speed-up-tests/references/ci-history-data.md) for history from the API, and the check [measure CI before changing it](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/ci-measure-before-changing-it.md).
- A cost: [budget CI at list price](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/budget-ci-at-list-price.md), as a monthly projection from measured frequency.
- A slow-test campaign's report: its template carries [the report](report.md)'s fields for each headline number.
- A spike or research result that decides what gets built: an experiment and a skeptic reviewer, as [`review-gate`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/review-gate/SKILL.md) says.
