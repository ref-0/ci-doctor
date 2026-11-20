<!--
What: the checks this skill follows, each in short, with a link to the whole check.
Where: read by an agent before it changes a runner, prices a change or touches the spend cap.
Configure: nothing; the whole checks are in the ci-doctor hub's references/checks/.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The checks

Part of the [`ci-runners`](../SKILL.md) skill. Each check is one rule; these are their short forms, enough to work from with this skill installed alone. Each whole check, with its commands and the incident behind it, is one link away.

## Before you change a runner

- **[Size a runner by its CPU](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-doctor/references/checks/ci-size-a-runner-by-its-cpu.md).** Read a job's median and p90 CPU and its peak memory over at least three runs before it changes size. Move down only when the median stays under the repo's line (about 40% in the source repo), the p90 isn't near saturation, memory has room and the job isn't on the critical path. Explain low CPU on a critical-path job first: a tail behind one slow file isn't a runner too big. Check the new runner on a real run.
- **[Read what was tried](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-doctor/references/checks/ci-read-what-was-tried.md).** Search the repo's register for the idea before proposing it. A repeat says what has changed since, with new measurements. An idea you drop gets a row.

## Before you quote a number

- **[Measure CI before changing it](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-doctor/references/checks/ci-measure-before-changing-it.md).** Price spend by job and event over a complete window, every attempt, at each label's list price, with exact, estimated and unpriced parts apart. Name the limiter: queueing, setup, a wait on another job or the work. Model the change before building it, and measure its own run the same way after.
- **Judge the evidence,** as the [`prove-it`](https://github.com/ref-0/ci-doctor/blob/next/skills/prove-it/SKILL.md) skill says, and give every number its count, spread and where it came from.

## Before you touch spend

- **[Budget CI at list price, and prove the guard stops it](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-doctor/references/checks/budget-ci-at-list-price.md).** Budget ready-PR runs, runs by hand and main's sweeps against `<monthly-cap>` at list price, before free minutes. The provider's own budget and alerts come first; an external watcher that disables workflows runs only with the user's yes, an allowlist and a report-only first period. Never re-enable a workflow it disabled.
