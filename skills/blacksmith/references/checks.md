<!--
What: the checks this skill follows, each in short, with a link to the whole check.
Where: read by an agent before it resizes a job on Blacksmith, changes a disk or touches the spend limit.
Configure: nothing; the whole checks are in the ci-doctor hub's references/checks/.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The checks

Part of the [`blacksmith`](../SKILL.md) skill. Each check is one rule; these are their short forms, enough to work from with this skill installed alone. Each whole check, with its commands and the incident behind it, is one link away.

- **[Size a runner by its CPU](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/checks/ci-size-a-runner-by-its-cpu.md).** Read a job's median and p90 CPU and peak memory over at least three runs, one by one with `blacksmith jobs stats <job-id> --format json`, before it changes size. Move down only when the median stays under the repo's line, the p90 isn't near saturation, memory has room and the job isn't on the critical path.
- **[Budget CI at list price, and prove the guard stops it](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/checks/budget-ci-at-list-price.md).** Budget at list price per vCPU-minute, before the free allowance. Keep Blacksmith's own limit above the watcher's cap, and never re-enable a workflow the watcher disabled.
- **[Measure CI before changing it](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/checks/ci-measure-before-changing-it.md).** Price spend from Blacksmith's own records over a complete window, every attempt, and model a change before building it. Compare like runs before and after a move.
- **[Read what was tried](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/references/checks/ci-read-what-was-tried.md).** Search the repo's register before proposing a disk or a cache: a sticky disk for `node_modules` alone was measured and dropped in the source repo.
