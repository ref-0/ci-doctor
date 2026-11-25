<!--
What: how Blacksmith bills: vCPU-minutes, architectures, macOS, the free allowance, sticky disks, its spend limit
and `ci-time.ts`'s billing adapter.
Where: read by an agent costing a job on Blacksmith, or setting its spend limit.
Configure: <price-per-vcpu-minute> and <monthly-cap> in your repo's ci.md.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Blacksmith's billing

Part of the [`blacksmith`](../SKILL.md) skill. The general rules, packing against minute rounding, the cap, auditing spend and budgeting runs CI starts, are in [`ci-runners`' billing](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-runners/references/billing.md). These are Blacksmith's specifics, as its [pricing](https://www.blacksmith.sh/pricing) and [runner docs](https://docs.blacksmith.sh/blacksmith-runners/overview) said in November 2026. Check both before you quote a number.

- **A job bills its minutes times its vCPUs,** at a list price per vCPU-minute (`<price-per-vcpu-minute>`), whether it computes or waits. The pricing page doesn't say how a job's time rounds, so read it from billed job records: `blacksmith jobs list --format json` gives each job's `billable_minutes` (already times its vCPUs), to compare with its runtime from GitHub's jobs API over a sample of short and long jobs. Pack jobs against a minute boundary only once the records show one.
- **arm64 costs less per minute than x64,** and **macOS several times as much.** Measure the same tests on arm64 before moving them: cores at a lower price ran some tests slower ([sizing](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-runners/references/sizing.md)).
- **The free allowance** is counted in 2 vCPU x64 minutes, with other sizes and platforms converted at the rates [the runner docs' FAQ](https://docs.blacksmith.sh/blacksmith-runners/overview#faq) gives; a larger runner uses it proportionally faster. Budget at list price rather than relying on it.
- **Flex scheduling,** a `;scheduling=flex` suffix on a label, costs less for a job that can wait to start: it starts when Blacksmith has spare capacity, within a day ([flex scheduling](https://docs.blacksmith.sh/blacksmith-runners/flex-scheduling)). It doesn't suit anything a person waits on.
- **A sticky disk bills by the GB-month** until a week after its last use. Keep one disk per install, not one per lockfile ([disks](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/blacksmith/references/disks.md)).
- **Blacksmith's own spend limit,** where the account's dashboard offers one, sits above the cap a watcher enforces, so the watcher gets the first chance to stop CI. Neither is guaranteed: Blacksmith's public docs don't say what its limit does when it's reached, and [guide section 12](https://ci-doctor.ref0.dev/guide/docs/pages/12-budgets-health-and-spend.md) warns that a provider-side limit can strand jobs in queues with no explanation, and a watcher acts on reported spend, so billing lag, a failed read and cancellation delay can carry spend past its cap ([the check](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/budget-ci-at-list-price.md)). Leave headroom, and ask Blacksmith or test a stop before relying on either. The watcher in [`scripts/budgets/`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/scripts/budgets/README.md#3-the-spend-watcher) reads spend with this CLI.
- **`ci-time.ts --bill blacksmith`** prices runs from Blacksmith's own records, not from labels.

## The billing adapter

`ci-time.ts --bill blacksmith`, in [`ci-workflows`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-workflows/SKILL.md#measuring-a-run), takes each job's billed vCPU-minutes and each shard's CPU from Blacksmith through this skill's [`scripts/blacksmith-bill.ts`](../scripts/blacksmith-bill.ts). It finds the adapter when this skill is installed beside `ci-workflows`, as a plugin install has it. The bill counts every attempt, while ci-time.ts's minutes count the latest. Its tests: `node --test blacksmith-bill.test.ts`, from `scripts/`, on Node 24 with nothing installed.

A skills-only install of this folder carries the adapter but not `ci-time.ts`: clone ci-doctor once, outside the user's repo, at the release this skill names in `metadata.version`, and point it at this folder:

```sh
git clone --depth 1 --branch v0.4.0 https://github.com/ref-0/ci-doctor.git <ci-doctor>
node <ci-doctor>/skills/ci-workflows/scripts/ci-time.ts --bill blacksmith --adapter-dir <skills-dir>/blacksmith/scripts
```
