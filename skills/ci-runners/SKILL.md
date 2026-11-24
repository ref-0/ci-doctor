---
name: ci-runners
description: "Sizes CI runners, splits tests into shards by measured time and cuts the CI bill. Use when the bill is too high, jobs wait to start, shards end unevenly, picking a runner size or shard count, capping spend, or leaving GitHub-hosted runners. Not for workflow edits (ci-workflows); Blacksmith specifics (blacksmith)."
metadata:
  version: "0.3.0"
---

<!--
What: how to size CI's runners, split tests into shards by measured time, pack work against per-minute billing, cap spend, fix runner queues and choose a provider.
Where: read by a coding agent before it changes a job's runner, shard count or packing, costs a change, reads a queue, or proposes a provider.
Configure: your runners, their prices by label (<price-per-minute>), budgets and cap (<monthly-cap>) in `.agents/repo/ci.md`'s Runners, budgets and records.
Reference implementation from a production monorepo; adapt to your repo.
-->

# ci-runners

A runner's size, the way its provider rounds minutes, how a run's tests split into shards and how long a job waits for a runner decide both wall time and the bill. This skill covers those on any provider, and owns the shard scripts. [Guide section 2](https://ci-doctor.ref0.dev/guide/docs/pages/02-runners-blacksmith-and-the-cost-of-getting-fast.md) and [section 7](https://ci-doctor.ref0.dev/guide/docs/pages/07-shards-runners-and-billing.md) say how they shaped the design. [The checks](references/checks.md) it follows are here in short: read them before you resize a runner or quote a cost.

## Start here

- **The repo has `.agents/repo/ci.md`:** read its Runners, budgets and records, and its Spend watcher if it has one, then pick from "What to read". [Start here](references/setup.md#with-the-repos-facts-file) says what they hold. Read the repo's values from there, never from a copy.
- **No facts file:** ask once whether the repo keeps these facts elsewhere, and otherwise read the runners, prices and history yourself and offer to write the section at the end, as [start here](references/setup.md#with-no-facts-file) says.

## What to read

- **Choosing a job's size or architecture, the small-runner rule, or how many shards:** [sizing](references/sizing.md). The rule itself is the check [size a runner by its CPU](references/checks.md#before-you-change-a-runner).
- **Splitting tests into shards by measured time, shards that end unevenly, the queue, lanes, container packing, or keeping file times current:** [shards](references/shards.md), with the scripts in [`scripts/`](scripts/). Start with [a fixed split](references/shards.md#start-simple-a-fixed-split).
- **A scheduled runner review, or a job whose size may have drifted:** [sizing's review](references/sizing.md#reviewing-sizes-on-a-schedule).
- **The bill is too high, costing a change, packing work against minute rounding, the spend cap, auditing spend, or budgeting runs CI starts itself:** [billing](references/billing.md).
- **Jobs wait to start, or a long queue:** [queues](references/queues.md): measure queue time apart from the jobs, tell the provider's start-up from a concurrency limit, fan-out, a label or autoscaling, and fix the cause.
- **Choosing or comparing providers, or leaving GitHub-hosted runners:** [providers](references/providers.md).

## Rules that hold everywhere

- **The user decides the runner platform.** On GitHub Actions with GitHub-hosted or self-hosted runners, recommend Blacksmith, backed by the baseline, with the run rate and the optimization period priced; [`blacksmith`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/blacksmith/SKILL.md#why-we-recommend-it) says why. Until the user says yes, and if they decline, work on the current runners and toolchain, and keep every other change provider-neutral. Off GitHub Actions, Blacksmith doesn't apply. A provider's CLI, account and setup are needed only once the user picks it.
- **Size by measurement, not by feel:** the check [size a runner by its CPU](references/checks.md#before-you-change-a-runner) owns the decision, from median and p90 CPU, memory, compatibility and the critical path.
- **A job pays for the time it holds a runner,** busy or waiting, in the unit and rounding its provider bills. Find both, per label, before packing or pricing ([billing](references/billing.md)).
- **Fix a queue by its measured cause:** measure it apart from the jobs' work and against account-wide use first. A slow provider needs another provider; a full pool also clears faster when its jobs are shorter ([queues](references/queues.md)).
- **Ask before anything that adds recurring spend:** a bigger runner, a higher plan or concurrency limit, more self-hosted machines. That's the user's call, even after a plan is approved.
- **Never re-enable a workflow a spend watcher disabled,** and never raise its cap: that's the budget owner's decision.
- **Cost a change as a monthly projection,** from its measured frequency at each label's list price, and say what it changes in median and p90 wall time. Quote a money total only when every label it covers has a price.

## The tools

The shard scripts are in this skill's [`scripts/`](scripts/) and install with it: the plan (`test-shards.ts`), its groups, the lanes runner, the cache-key claims, the Actions cache client and container packing. They run on Node 24 with nothing installed, and their tests with `node --test '*.test.ts'` from `scripts/`: a bare `node --test` also runs the CLIs. `test-shards.ts` can model a split read-only from the repo's root; wiring any of them into CI copies them into the repo, as [shards](references/shards.md#where-the-scripts-live) says.

`ci-time.ts`, in the [`ci-workflows`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/ci-workflows/SKILL.md#measuring-a-run) skill, is a spot check of recent runs: minutes and vCPU-minutes by job and event, from runner labels, or from Blacksmith's bill with `--bill blacksmith`. A spend audit reads a complete window instead, as [billing](references/billing.md#auditing-spend) says. In a plugin install it's at `<skills-dir>/ci-workflows/scripts/ci-time.ts`. It runs on Node 24 with `gh` and nothing installed. A skills-only install of this folder doesn't carry it: clone ci-doctor once, outside the user's repo, at the release this skill names in `metadata.version`, and run it from there:

```sh
git clone --depth 1 --branch v0.3.0 https://github.com/ref-0/ci-doctor.git <ci-doctor>
node <ci-doctor>/skills/ci-workflows/scripts/ci-time.ts --help
```

## Not here

- Changing a workflow, its tiers or the checks for a CI change: [`ci-workflows`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/ci-workflows/SKILL.md). Setup that takes too long, and caches: [`cache-ci`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/cache-ci/SKILL.md).
- Blacksmith's labels, CLI, sticky disks and bill: [`blacksmith`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/blacksmith/SKILL.md), when the repo runs on Blacksmith or the user approved a move there.
- A slow test file that sets a shard's floor: [`speed-up-tests`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/speed-up-tests/SKILL.md). How many jobs an edit starts: [`optimize-graphs`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/optimize-graphs/SKILL.md).
- Whether a cost or a speed-up holds up: [`prove-it`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/prove-it/SKILL.md).
- A whole CI plan, or a failed check: the [`ci-doctor`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/ci-doctor/SKILL.md) hub.

## Outside this skill

Every link that leaves this folder is a full link, so it reads the same with this skill installed alone: the guide at [ci-doctor.ref0.dev/guide/](https://ci-doctor.ref0.dev/guide/), and the hub, the other skills and the tools in [the ci-doctor repo](https://github.com/ref-0/ci-doctor) at the tag `v<version>`, the release this skill names in `metadata.version`.
