---
name: ci-workflows
description: "Change or debug CI workflows on any provider: the job graph, setup, selection, tiers, caches and the checks for a CI change. Use before editing them, or when job order or setup is slow. For runner size or cost, use ci-runners; Blacksmith's CLI and disks, blacksmith; a PR's result or a run by hand, ci-merge-workflow."
---

<!--
What: how to change CI without making it slower, costlier or less trustworthy, on any provider.
Where: read by a coding agent before it edits workflows, selection, shards, tiers or caches.
Configure: write your repo's facts file, `.agents/repo/ci.md`, from templates/agent-knowledge/repo-facts/ci.md;
set the config block at the top of scripts/ci-time.ts.
Reference implementation from a production monorepo; adapt to your repo.
-->

# CI workflows

Read `.agents/repo/ci.md` first (template: [`repo-facts/ci.md`](../../templates/agent-knowledge/repo-facts/ci.md)): its Entry points and gate names the repo's workflows, whose headers say what runs when, and the comment above each job and step says why it's shaped as it is. This skill is for changing the workflow and keeping it fast, on whichever CI the repo runs. [guide sections 3 to 7](../../docs/pages/03-workflow-anatomy.md) explain the design.

The rules here hold on any provider. Where a rule turns on how runners are sized or billed, read [`ci-runners`](../ci-runners/SKILL.md); if you run on Blacksmith, [`blacksmith`](../blacksmith/SKILL.md) has its CLI, labels, disks and bill. The [templates](../../templates/github/README.md) assume GitHub Actions; on another CI the rules still apply, and the workflows need translating.

## The checks for a change to CI

Before changing CI, read [the checks for a workflow change](references/change-checks.md). Measure first, check real output and budget at list price.

Each job a pull request can run has a runner and a budget, where the repo keeps them, as ci.md's Runners, budgets and records says. A change that adds a job, or moves one's time or runner, updates them, and its pull request states its modelled effect on a full and a small run's time and its cost a month, which numbers are observed, and which normal run will observe the rest, as [check a change to CI against real output](../../checks/ci-check-a-workflow-change.md) says.

A pull request that changes a workflow runs its own version, so its run is the test. A run by hand runs the workflow from the branch it's started on, `--ref`.

## Measuring a run

[`scripts/ci-time.ts`](scripts/ci-time.ts) is a spot check of the newest runs' latest attempts, from GitHub's jobs API: started minutes and vCPU-minutes by job and by event, each run's checks span and time to the gate, the job that ended last, and the slowest file lines in the newest large run's shard logs. Its help says exactly what each number is and leaves out. The job that ended last isn't proof of the limiter, and its file times may come from a replay. It isn't a baseline or a spend audit: those page a closed window and read every attempt, as [CI history data](../speed-up-tests/references/ci-history-data.md) says. It estimates vCPU-minutes from runner labels, as its `RUNNERS` block maps them, and money only when `PRICES` prices every label; with `--bill blacksmith`, on Blacksmith only, it takes billed minutes from [the blacksmith skill's adapter](../blacksmith/scripts/blacksmith-bill.ts). Pass `--repo`, `--workflow` and a `--shard` for each sharded job, as ci.md names them, or set its config block. Its tests: `node --test ci-time.test.ts`, from `scripts/`.

Where CI's records are and how to read them is [measuring](../speed-up-tests/references/measuring.md). Judging what a number means is [`verify-evidence`](../verify-evidence/SKILL.md).

## Where each value lives

Read a value from its file. Don't copy it here or into a plan. ci.md's Runners, budgets and records holds the repo's table of where each lives: each job's budget and runner, what a diff reaches, the shards, the schedules, the retries and flakes, and the records.

## Why it's shaped this way

Each of these is a choice a change could undo. Keep it, or measure first.

- A slow run, a long test file, or how many shards: read [slow runs](references/performance.md). To choose a runner's size, read [`ci-runners`](../ci-runners/SKILL.md).
- What selects a change's checks, lockfile routing or test selection: read [selection rules](references/selection.md) and verify the selected jobs against real output.
- Moving a test off pull requests, or adding a scheduled run: read [the tiers](references/tiers.md). To make a slow test faster, use [`speed-up-tests`](../speed-up-tests/SKILL.md).
- Cache keys, scopes, setup caches or image reuse: read [cache rules](references/caches.md); if your stack uses Rust, also [Rust](references/rust.md).
- Draft, push, sweep, pack and proof behaviour: read the headers and job dependencies of the workflows ci.md names.

## Tests against real containers

Tests that run the repo's code against real containers are the slowest, and their imports may not say what they check. Where the repo has them, ci.md's Real-container files table says which file checks which boundary, the hidden inputs (bundles, disks, images) that select it, and the command to run it by hand: read it when a sweep fails one, or to choose which to run by hand before a risky change merges. Update it when you add such a file or move what one covers.

## Related

- [`ci-runners`](../ci-runners/SKILL.md): runner size, packing and cost, and choosing a provider.
- [`blacksmith`](../blacksmith/SKILL.md): if you run on Blacksmith, its CLI, labels, sticky disks and bill.
- [`ci-merge-workflow`](../ci-merge-workflow/SKILL.md): read a PR's result, run CI by hand, merge.
- [`speed-up-tests`](../speed-up-tests/SKILL.md): make a slow test faster without losing what it proves.
- [`verify-evidence`](../verify-evidence/SKILL.md): before you quote a number from a run.
- The repo's tried-and-dropped register, which ci.md names ([the check](../../checks/ci-read-what-was-tried.md)), and [guide section 18](../../docs/pages/18-tried-and-dropped.md): what each earlier change measured.
