<!--
What: how per-minute CI billing shapes a job, the spend cap, auditing spend, budgeting runs CI starts
itself, and the cost of getting fast.
Where: read by an agent when costing a run or a change, or changing runner sizes or job packing.
Configure: each runner label's price and unit (<price-per-minute>) and <monthly-cap> in your repo's ci.md.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Billing and budget

Part of the [`ci-runners`](../SKILL.md) skill. Read when costing a run or a change, or changing runner sizes or job packing. [guide section 7](https://ci-doctor.ref0.dev/guide/docs/pages/07-shards-runners-and-billing.md) and [section 12](https://ci-doctor.ref0.dev/guide/docs/pages/12-budgets-health-and-spend.md) say how this shaped the design. If you run on Blacksmith, its own billing (per vCPU-minute, sticky disks, the free allowance) is in [`blacksmith`'s billing](https://github.com/ref-0/ci-doctor/blob/next/skills/blacksmith/references/billing.md).

## Packing against minute rounding

- **Find your provider's unit and rounding first,** for each label, and record them with the label's list price in ci.md. GitHub-hosted runners price each runner type per minute, rounded up per job; Blacksmith prices per vCPU-minute; a self-hosted runner costs its machines whatever runs. Check the current pricing pages.
- **Where each job rounds up to a minute, pack a job's work to just under a minute boundary:** a job of 61 s bills as much as one of 119 s. Where the provider doesn't round per job, packing saves nothing. An invented example: 14 shards each ending just under 2 minutes bill 28 shard-minutes, and 9 shards each spilling just past 2 minutes bill 27, so the faster layout costs about the same. Warn when a shard's p95 nears the boundary.
- **Each job pays for its setup.** A warm install skips most of it ([caches](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-workflows/references/caches.md)); otherwise the job installs. Measure both paths in your CI. One test file per job wastes most of a runner.
- **Measure queue and startup time.** When runners start together without queueing, the longest job sets wall time.
- **Verify any free allowance before budgeting.** Larger runners often use it faster. Budget at list price rather than relying on free minutes.
- **Three numbers, kept apart:** test-seconds, wall time and billed minutes, as [measuring](https://github.com/ref-0/ci-doctor/blob/next/skills/speed-up-tests/references/measuring.md#comparing-before-and-after) says. A change can move one and not the others.
- **Keep spend's three figures apart too:** raw runner minutes by label; their list-price projection, priced per label, rounded as the provider rounds, over every attempt; and actual billed usage and allowance, from the provider's billing report where you're allowed to read it. GitHub's billing usage is a separate source from Actions' job timings. Count cache storage and other approved costs on their own lines, and say which jobs' categories were measured.

## The spend cap

Start with the provider's own budget and alerts, where the billing scope supports them, such as GitHub's budgets for GitHub-hosted runners. Record its scope, who can change it, and what reaching it stops.

An external watcher that disables workflows is a separate item the user approves, as the check [budget CI at list price](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-doctor/references/checks/budget-ci-at-list-price.md) says. [`scripts/budgets/`](https://github.com/ref-0/ci-doctor/blob/next/scripts/budgets/README.md#3-the-spend-watcher) has one, which reads Blacksmith's spend. Before it can stop anything, it needs a reader for your provider's spend, an explicit list of the workflows it may disable (not release, security or recovery ones unless the user says so), a report-only first period, a drill of a stop and a recovery, and a person named to override it. It tries to stop CI when reported spend reaches `<monthly-cap>`; billing lag, a failed read and cancellation delay can still carry spend past it, so leave headroom. Set any provider limit above the watcher's cap, so the watcher stops CI cleanly first. Don't re-enable a workflow it disabled. A person signs in the CLIs it reads; never read or print their credentials.

## The cost of getting fast

Making a slow CI fast costs money and weeks before it pays off: broad runs while selection is narrowed, measurement runs, bisects and experiments. In the source repo, one audit week spent about two thirds more than the week before, before spend fell. So put the cap and alerts in place first, with headroom for the work; read history before buying runs; model a change before dispatching it, with stop rules; and approve experiment spend like any other spend. [guide section 2](https://ci-doctor.ref0.dev/guide/docs/pages/02-runners-blacksmith-and-the-cost-of-getting-fast.md#getting-fast-costs-money-and-time-first) has the list.

## Auditing spend

- **Use equal, complete UTC windows,** such as two whole weeks. Label a partial window, such as today, and don't claim growth from it.
- **Reconcile renamed and split jobs** before comparing categories across windows.
- **For each category,** report its job and run counts, its runner label, its average rounded duration and that label's price per minute. Keep raw minutes apart from price-normalized units: a macOS minute costs several Linux ones.
- **Keep two populations:** first-attempt runs for latency, all attempts for spend.
- **Read the authorized cap** from the watcher's config or the approved change that set it, and fix any doc that says otherwise. An audit never authorizes raising it.
- Collect history as [CI history data](https://github.com/ref-0/ci-doctor/blob/next/skills/speed-up-tests/references/ci-history-data.md) says: every page, every attempt, and what you couldn't read.

## Budget runs that CI dispatches

Use the worked example `.agents/repo/ci.md`'s Runners, budgets and records names, where the repo has one, such as a bisect that reruns failed jobs.

- Count spend from the CI provider's runs and jobs API, never from comments anyone can write.
- List runs one UTC day at a time. GitHub's `created` filter returns at most 1,000.
- Bill a running job at its timeout.
- Budget `gh run rerun --failed` for every failed shard it reruns.
- Skip a failure only on evidence that was probed and finished.
