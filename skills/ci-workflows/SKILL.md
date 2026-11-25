---
name: ci-workflows
description: "Edits CI workflows, such as GitHub Actions YAML, without making them slower, costlier or less reliable. Use when asked to add or change a job, split CI into tiers, add a scheduled run, or make a slow job faster. Not for caching (cache-ci); which checks a change runs (optimize-graphs); runners and the bill (ci-runners)."
metadata:
  version: "0.4.0"
---

<!--
What: how to change CI without making it slower, costlier or less reliable, on any provider.
Where: read by a coding agent before it edits workflows, jobs, shards or tiers.
Configure: write your repo's facts file, `.agents/repo/ci.md`, from the agent-knowledge skill's templates/repo-facts/ci.md;
write `.agents/repo/ci-time.json` from repo-facts/ci-time.json for scripts/ci-time.ts.
Reference implementation from a production monorepo; adapt to your repo.
-->

# ci-workflows

A workflow change is easy to make and hard to see the cost of: a new job pays its setup on every run, a wait between jobs lengthens every run, and a step that can't fail hides what it stopped doing. This skill is for changing the workflow and keeping it fast, on whichever CI the repo runs: the checks for a change, the tiers, slow runs and jobs, Rust in CI, and [`ci-time.ts`](scripts/ci-time.ts), which prints where a run's time and minutes went. [Guide sections 3 to 7](https://ci-doctor.ref0.dev/guide/docs/pages/03-workflow-anatomy.md) explain the design.

The rules hold on any provider. Where a rule turns on how runners are sized or billed, read [`ci-runners`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-runners/SKILL.md); if you run on Blacksmith, [`blacksmith`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/blacksmith/SKILL.md) has the CLI, labels, disks and bill. The [workflow templates](https://ci-doctor.ref0.dev/guide/templates/github/README.md) assume GitHub Actions; on another CI the rules still apply, and the workflows need translating.

## Start here

- **The repo has `.agents/repo/ci.md`:** read it first. Its Entry points and gate names the workflows, whose headers say what runs when, and the comment above each job and step says why it's shaped as it is. [Start here](references/setup.md#with-the-repos-facts-file) says what else it holds.
- **No facts file:** ask once whether the repo keeps these facts elsewhere, and otherwise read them from the workflows themselves, as [start here](references/setup.md#with-no-facts-file) says.

[The checks](references/checks.md) this skill follows are here in short: read them before you design a change.

## The checks for a change to CI

Before changing CI, read [the checks for a workflow change](references/change-checks.md): which check applies before you design it, while you build it, when a run is slow and before it merges. Measure first, check real output and budget at list price.

When a change adds a job or moves one, or you test it by its run, read [a job's runner and budget](references/change-checks.md#a-jobs-runner-and-budget).

## Measuring a run

When you measure a run with `ci-time.ts`, or run this skill's scripts, read [the tools](references/tools.md).

## Where each value lives

Read a value from its file; don't copy it here or into a plan. ci.md's Runners, budgets and records says where each lives.

## Why it's shaped this way

Each of these is a choice a change could undo. Keep it, or measure first.

- A slow run or a long test file: read [slow runs](references/performance.md).
- Moving a test off pull requests, choosing how often the sweep runs, or adding a scheduled run: read [the tiers](references/tiers.md).
- If your stack uses Rust, its pass and binary keys and build caches are in [Rust](references/rust.md).
- Draft, push, sweep, pack and proof behaviour: read the headers and job dependencies of the workflows ci.md names.

## Tests against real containers

When a sweep fails a test against real containers, or you add or move one, read [tests against real containers](references/tiers.md#tests-against-real-containers).

## Not here

- Caches, their keys and who writes them, and setup that takes too long: [`cache-ci`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/cache-ci/SKILL.md).
- Which checks a change selects, and how far an edit reaches through packages, `exports`, task inputs and the job graph: [`optimize-graphs`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/optimize-graphs/SKILL.md).
- Runner size, packing against billing, the spend cap and choosing a provider, and Blacksmith: the [`ci-doctor`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/SKILL.md) hub. Why a PR's check failed is its triage too, and the whole CI plan its phases.
- A slow test: [`speed-up-tests`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/speed-up-tests/SKILL.md). A flaky one: [`fix-flaky-test`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/fix-flaky-test/SKILL.md). Model checks and property tests in CI: [`proof-tiers`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/proof-tiers/SKILL.md).
- Reading a PR's result, running CI by hand and merging: [`ci-merge-workflow`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-merge-workflow/SKILL.md).
- The repo's tried-and-dropped register, which ci.md names ([the check](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/ci-read-what-was-tried.md)), and [guide section 18](https://ci-doctor.ref0.dev/guide/docs/pages/18-tried-and-dropped.md): what each earlier change measured.

## Outside this skill

Every link that leaves this folder is a full link, so it reads the same with this skill installed alone: the guide at [ci-doctor.ref0.dev/guide/](https://ci-doctor.ref0.dev/guide/), and the hub, the other skills and the tools in [the ci-doctor repo](https://github.com/ref-0/ci-doctor) at the tag `v<version>`, the release this skill names in `metadata.version`.
