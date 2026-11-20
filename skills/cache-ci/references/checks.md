<!--
What: the checks this skill follows, each in short, with a link to the whole check.
Where: read by an agent before it proposes a cache, and before it quotes a saving.
Configure: nothing; the whole checks are in the ci-doctor hub's references/checks/.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The checks

Part of the [`cache-ci`](../SKILL.md) skill. Each check is one rule; these are their short forms, enough to work from with this skill installed alone. Each whole check, with its commands and the incident behind it, is one link away.

## Before you propose a cache

- **[Measure CI before changing it](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-doctor/references/checks/ci-measure-before-changing-it.md).** Name the limiter from the job graph and step timestamps: queueing, setup, a wait on another job or the work. Model the change from those numbers before building it, and measure its own run the same way afterwards. Label every number observed, replayed or modelled.
- **[Read what was tried](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-doctor/references/checks/ci-read-what-was-tried.md).** Search the repo's register of what was tried and dropped for the idea first. A repeat says what has changed since, with new measurements. A cache you drop gets a row, with its date, result and the condition to try it again.

## While you build it

- **[Check a change to CI against real output](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-doctor/references/checks/ci-check-a-workflow-change.md).** Run the steps that compute a key on real files, match paths with `git ls-files`, and check each command's exit status, so a failed hash can't become an empty key that every run shares.

## Before you quote a saving

- **Judge the evidence,** as the [`prove-it`](https://github.com/ref-0/ci-doctor/blob/next/skills/prove-it/SKILL.md) skill says: write the decision and the noise floor before measuring, compare like with like, a hit with a hit and a miss with a miss, and give every number its count, spread and limiter.
- **[Budget CI at list price](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-doctor/references/checks/budget-ci-at-list-price.md).** Give the saving a month at list price, and count the cache's storage and any other provider cost apart.
