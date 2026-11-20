<!--
What: how Blacksmith bills: vCPU-minutes, architectures, macOS, the free allowance, sticky disks and its spend limit.
Where: read by an agent costing a job on Blacksmith, or setting its spend limit.
Configure: <price-per-vcpu-minute> and <monthly-cap> in your repo's ci.md.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Blacksmith's billing

Part of the [`blacksmith`](../SKILL.md) skill. The general rules, packing against minute rounding, the cap, auditing spend and budgeting runs CI starts, are in [`ci-runners`' billing](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-runners/references/billing.md). These are Blacksmith's specifics, as its [pricing](https://www.blacksmith.sh/pricing) and [runner docs](https://docs.blacksmith.sh/blacksmith-runners/overview) said in November 2026. Check both before you quote a number.

- **A job bills its started minutes times its vCPUs,** at a list price per vCPU-minute (`<price-per-vcpu-minute>`), whether it computes or waits. A job at 2:01 costs as much as one at 2:59.
- **arm64 costs less per minute than x64,** and **macOS several times as much.** Measure the same tests on arm64 before moving them: cheaper cores ran some tests slower ([sizing](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-runners/references/sizing.md)).
- **The free allowance** is counted in 2 vCPU x64 minutes; a larger runner uses it proportionally faster. Budget at list price rather than relying on it.
- **Flexible scheduling,** a `;scheduling=flex` suffix on a label, is cheaper for a job that can wait to start. It doesn't suit anything a person waits on.
- **A sticky disk bills by the GB-month** until a week after its last use. Keep one disk per install, not one per lockfile ([disks](https://github.com/ref-0/ci-doctor/blob/next/skills/blacksmith/references/disks.md)).
- **Set Blacksmith's own spend limit** in its dashboard, above the cap your watcher enforces, so the watcher stops CI cleanly before the provider's limit strands jobs in a queue. The watcher in [`scripts/budgets/`](https://github.com/ref-0/ci-doctor/blob/next/scripts/budgets/README.md#3-the-spend-watcher) reads spend with this CLI.
- **`ci-time.ts --bill blacksmith`** prices runs from Blacksmith's own records, not from labels.
