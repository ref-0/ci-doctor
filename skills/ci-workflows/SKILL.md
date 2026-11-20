---
name: ci-workflows
description: "Edits CI workflows, such as GitHub Actions YAML, without making them slower, costlier or less reliable. Use when asked to add or change a job, split CI into tiers, add a scheduled run, or make a slow job faster. Not for caching (cache-ci); which checks a change runs (optimize-graphs); runners and the bill (ci-runners)."
metadata:
  version: "0.1.0"
---

<!--
What: how to change CI without making it slower, costlier or less trustworthy, on any provider.
Where: read by a coding agent before it edits workflows, jobs, shards or tiers.
Configure: write your repo's facts file, `.agents/repo/ci.md`, from the agent-knowledge skill's templates/repo-facts/ci.md;
write `.agents/repo/ci-time.json` from repo-facts/ci-time.json for scripts/ci-time.ts.
Reference implementation from a production monorepo; adapt to your repo.
-->

# ci-workflows

A workflow change is easy to make and hard to see the cost of: a new job pays its setup on every run, a wait between jobs lengthens every run, and a step that can't fail hides what it stopped doing. This skill is for changing the workflow and keeping it fast, on whichever CI the repo runs: the checks for a change, the tiers, slow runs and jobs, Rust in CI, and [`ci-time.ts`](scripts/ci-time.ts), which prints where a run's time and minutes went. [Guide sections 3 to 7](https://ci-doctor.ref0.dev/guide/docs/pages/03-workflow-anatomy.md) explain the design.

The rules hold on any provider. Where a rule turns on how runners are sized or billed, read [`ci-runners`](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-runners/SKILL.md); if you run on Blacksmith, [`blacksmith`](https://github.com/ref-0/ci-doctor/blob/next/skills/blacksmith/SKILL.md) has the CLI, labels, disks and bill. The [workflow templates](https://ci-doctor.ref0.dev/guide/templates/github/README.md) assume GitHub Actions; on another CI the rules still apply, and the workflows need translating.

## Start here

- **The repo has `.agents/repo/ci.md`:** read it first. Its Entry points and gate names the workflows, whose headers say what runs when, and the comment above each job and step says why it's shaped as it is. [Start here](references/setup.md#with-the-repos-facts-file) says what else it holds.
- **No facts file:** ask once whether the repo keeps these facts elsewhere, and otherwise read them from the workflows themselves, as [start here](references/setup.md#with-no-facts-file) says.

[The checks](references/checks.md) this skill follows are here in short: read them before you design a change.

## The checks for a change to CI

Before changing CI, read [the checks for a workflow change](references/change-checks.md): which check applies before you design it, while you build it, when a run is slow and before it merges. Measure first, check real output and budget at list price.

Each job a pull request can run has a runner and a budget, where the repo keeps them, as ci.md's Runners, budgets and records says. A change that adds a job, or moves one's time or runner, updates them, and its pull request states its modelled effect on a full and a small run's time and its cost a month, which numbers are observed, and which normal run will observe the rest.

A pull request that changes a workflow runs its own version, so its run is the test. A run by hand runs the workflow from the branch it's started on, `--ref`.

## Measuring a run

[`scripts/ci-time.ts`](scripts/ci-time.ts) is a spot check of the newest runs' latest attempts, from GitHub's jobs API: started minutes and vCPU-minutes by job and by event, each run's checks span and time to the gate, the job that ended last, and the slowest file lines in the newest large run's shard logs. Its help says exactly what each number is and leaves out. The job that ended last isn't proof of the limiter, and its file times may come from a replay. It isn't a baseline or a spend audit: those page a closed window and read every attempt, as [CI history data](https://github.com/ref-0/ci-doctor/blob/next/skills/speed-up-tests/references/ci-history-data.md) says.

It estimates vCPU-minutes from runner labels, as the `runners` setting maps them, and money only when `prices` prices every label. With `--bill blacksmith`, on Blacksmith only, it takes billed minutes from [Blacksmith's adapter](https://github.com/ref-0/ci-doctor/blob/next/skills/blacksmith/scripts/blacksmith-bill.ts), found beside this skill or passed with `--adapter-dir`. Pass `--repo`, `--workflow` and a `--shard` for each sharded job, as ci.md names them, or set them in the repo's `.agents/repo/ci-time.json` ([template](https://github.com/ref-0/ci-doctor/blob/next/skills/agent-knowledge/templates/repo-facts/ci-time.json)). Its tests run with this skill installed alone: `node --test ci-time.test.ts`, from `scripts/`.

Where CI's records are and how to read them is `speed-up-tests`' [measuring](https://github.com/ref-0/ci-doctor/blob/next/skills/speed-up-tests/references/measuring.md). Judging what a number means is the [`prove-it`](https://github.com/ref-0/ci-doctor/blob/next/skills/prove-it/SKILL.md) skill.

## Where each value lives

Read a value from its file; don't copy it here or into a plan. ci.md's Runners, budgets and records says where each lives.

## Why it's shaped this way

Each of these is a choice a change could undo. Keep it, or measure first.

- A slow run, a long test file, or how many shards: read [slow runs](references/performance.md). To choose a runner's size, read [`ci-runners`](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-runners/SKILL.md).
- What selects a change's checks, lockfile routing or test selection: the [`optimize-graphs`](https://github.com/ref-0/ci-doctor/blob/next/skills/optimize-graphs/SKILL.md) skill's [selection](https://github.com/ref-0/ci-doctor/blob/next/skills/optimize-graphs/references/selection.md), since a selector is only as narrow as the graph it walks. Verify the selected jobs against real output.
- Moving a test off pull requests, or adding a scheduled run: read [the tiers](references/tiers.md). To make a slow test faster, use [`speed-up-tests`](https://github.com/ref-0/ci-doctor/blob/next/skills/speed-up-tests/SKILL.md).
- Cache keys, scopes, setup caches or image reuse: the [`cache-ci`](https://github.com/ref-0/ci-doctor/blob/next/skills/cache-ci/SKILL.md) skill. If your stack uses Rust, its pass and binary keys and build caches are in [Rust](references/rust.md).
- Draft, push, sweep, pack and proof behaviour: read the headers and job dependencies of the workflows ci.md names.

## Tests against real containers

Tests that run the repo's code against real containers are the slowest, and their imports may not say what they check. Where the repo has them, ci.md's Real-container files table says which file checks which boundary, the hidden inputs (bundles, disks, images) that select it, and the command to run it by hand: read it when a sweep fails one, or to choose which to run by hand before a risky change merges. Update it when you add such a file or move what one covers.

## The tools

`ci-time.ts` and its test are in this skill's `scripts/`, and run on Node 24 with nothing installed, logged in to `gh`: `node <skills-dir>/ci-workflows/scripts/ci-time.ts --help`. With `--bill blacksmith`, it looks for `blacksmith-bill.ts` among the installed skills; a skills-only install of this folder doesn't carry it, so clone ci-doctor once, outside the user's repo, on `next` until the release that adds this skill, then at the release this skill names in `metadata.version`, and point `--adapter-dir` at the adapter's folder:

```sh
git clone --depth 1 --branch next https://github.com/ref-0/ci-doctor.git <ci-doctor>
node <skills-dir>/ci-workflows/scripts/ci-time.ts --bill blacksmith --adapter-dir <ci-doctor>/skills/blacksmith/scripts
```

## Not here

- Caches, their keys and who writes them, and setup that takes too long: [`cache-ci`](https://github.com/ref-0/ci-doctor/blob/next/skills/cache-ci/SKILL.md).
- Which checks a change selects, and how far an edit reaches through packages, `exports`, task inputs and the job graph: [`optimize-graphs`](https://github.com/ref-0/ci-doctor/blob/next/skills/optimize-graphs/SKILL.md).
- Runner size, packing against billing, the spend cap and choosing a provider, and Blacksmith: the [`ci-doctor`](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-doctor/SKILL.md) hub. Why a PR's check failed is its triage too, and the whole CI plan its phases.
- A slow test: [`speed-up-tests`](https://github.com/ref-0/ci-doctor/blob/next/skills/speed-up-tests/SKILL.md). A flaky one: [`fix-flaky-test`](https://github.com/ref-0/ci-doctor/blob/next/skills/fix-flaky-test/SKILL.md). Model checks and property tests in CI: [`proof-tiers`](https://github.com/ref-0/ci-doctor/blob/next/skills/proof-tiers/SKILL.md).
- Reading a PR's result, running CI by hand and merging: [`ci-merge-workflow`](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-merge-workflow/SKILL.md).
- The repo's tried-and-dropped register, which ci.md names ([the check](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-doctor/references/checks/ci-read-what-was-tried.md)), and [guide section 18](https://ci-doctor.ref0.dev/guide/docs/pages/18-tried-and-dropped.md): what each earlier change measured.

## Outside this skill

Every link that leaves this folder is a full link, so it reads the same with this skill installed alone: the guide at [ci-doctor.ref0.dev/guide/](https://ci-doctor.ref0.dev/guide/), and the hub, the other skills and the tools in [the ci-doctor repo](https://github.com/ref-0/ci-doctor) on `next`, the branch the skills track. To read them at a release instead, open the repo at the tag `v<version>`.
