<!--
What: how to size CI's runners, pack work against per-minute billing, cap spend and choose a provider.
Where: read by a coding agent before it changes a job's runner, shard count or packing, costs a change, or proposes a provider.
Configure: your runners, their prices by label (<price-per-minute>), budgets and cap (<monthly-cap>) in `.agents/repo/ci.md`'s Runners, budgets and records.
Reference implementation from a production monorepo; adapt to your repo.
-->

# CI runners and cost

A runner's size, the way its provider rounds minutes and the number of shards a run splits into decide both wall time and the bill. This topic covers those on any provider. [guide section 2](../../../../docs/pages/02-runners-blacksmith-and-the-cost-of-getting-fast.md) and [section 7](../../../../docs/pages/07-shards-runners-and-billing.md) say how they shaped the design. The repo's own runners, budgets and cap are in `.agents/repo/ci.md`'s Runners, budgets and records: read them from there, never from a copy.

## What to read

- **Choosing a job's size or architecture, the small-runner rule, or how many shards:** [sizing](references/sizing.md). The rule itself is the check [size a runner by its CPU](../checks/ci-size-a-runner-by-its-cpu.md).
- **A scheduled runner review, or a job whose size may have drifted:** [sizing's review](references/sizing.md#reviewing-sizes-on-a-schedule).
- **Costing a change, packing work against minute rounding, the spend cap, auditing spend, or budgeting runs CI starts itself:** [billing](references/billing.md), with the check [budget CI at list price](../checks/budget-ci-at-list-price.md).
- **Jobs waiting to start, or a long queue:** [when jobs wait to start](../excerpts/phase-3.md#when-jobs-wait-to-start), from guide section 2. Measure queue time, `started_at` minus `created_at`, by runner label and by hour of day: a queue that's long at busy hours even when few jobs run is the provider's start-up, not the tests. Then [`blacksmith`](../blacksmith/TOPIC.md#why-we-recommend-it) for the move.
- **Choosing or comparing providers:** [providers](references/providers.md). On GitHub Actions with GitHub-hosted or self-hosted runners, recommend Blacksmith, backed by the baseline and priced; [`blacksmith`](../blacksmith/TOPIC.md#why-we-recommend-it) says why.

## Rules that hold everywhere

- **The user decides the runner platform.** On GitHub Actions with GitHub-hosted or self-hosted runners, the plan recommends Blacksmith, backed by the baseline, with the run rate and the optimization period priced. Until the user says yes, and if they decline, work on the current runners and toolchain, and keep every other change provider-neutral. Off GitHub Actions, Blacksmith doesn't apply. A provider's CLI, account and setup are needed only once the user picks it.
- **Size by measurement, not by feel:** the check [size a runner by its CPU](../checks/ci-size-a-runner-by-its-cpu.md) owns the decision, from median and p90 CPU, memory, compatibility and the critical path.
- **A job pays for the time it holds a runner,** busy or waiting, in the unit and rounding its provider bills. Find both, per label, before packing or pricing ([billing](references/billing.md)).
- **Never re-enable a workflow a spend watcher disabled,** and never raise its cap: that's the budget owner's decision.
- **Cost a change as a monthly projection,** from its measured frequency at each label's list price, and say what it changes in median and p90 wall time. Quote a money total only when every label it covers has a price.

[`ci-workflows`](../ci-workflows/scripts/ci-time.ts)' `ci-time.ts` is a spot check of recent runs: minutes and vCPU-minutes by job and event, from runner labels, or from Blacksmith's bill with `--bill blacksmith`. A spend audit reads a complete window, as [billing](references/billing.md#auditing-spend) says.

## Related

- [`ci-workflows`](../ci-workflows/TOPIC.md): workflows, selection, tiers and caches.
- [`blacksmith`](../blacksmith/TOPIC.md): if you run on Blacksmith, its labels, CLI, sticky disks and billing specifics.
- The [`prove-it`](../../../prove-it/SKILL.md) skill: before you quote a cost or a speed-up.
