---
name: cache-ci
description: "Adds and fixes CI caches for dependencies, builds and toolchains, so setup stops reinstalling everything. Use when CI spends ages installing, when asked to add caching, or when a cache never hits or its cache key looks wrong. Not for task caches an edit misses (optimize-graphs); other workflow edits (ci-workflows)."
metadata:
  version: "0.4.0"
---

<!--
What: how to make CI's setup fast with caches that hit, and that never replay a stale result.
Where: read by a coding agent before it adds or changes a cache, its key or who writes it, or when one misses.
Configure: your repo's own caches go in `.agents/repo/ci.md`'s Caches.
Reference implementation from a production monorepo; adapt to your repo.
-->

# cache-ci

Setup is often the largest share of a job that nobody looks at. A cache is only as good as its key, though: leave out an input and a stale result replays; put in one that changes every run and nothing ever hits. **Key a cache by every input that can change its output, and nothing else.**

This skill covers the caches a CI job restores before its work: dependency installs, the package manager's store, toolchains, build caches such as Rust's `target/`, and images. [Guide section 6](https://ci-doctor.ref0.dev/guide/docs/pages/06-reuse-work-by-its-real-inputs.md) has the design, what each cache measured, and the remote task cache.

When you need the numbers behind setup's share of a job, read [how much setup costs](references/caches.md#how-much-setup-costs).

## Start here

- **The repo has `.agents/repo/ci.md`:** read its Caches section: each cache's key, who writes it and who reads it, and what's left uncached on purpose. [Start here](references/setup.md#with-the-repos-facts-file) says what else to read.
- **No facts file:** ask once whether the repo keeps these facts elsewhere, and otherwise list the caches from the workflows, as [start here](references/setup.md#with-no-facts-file) says.

[The checks](references/checks.md) this skill follows are here in short: read them before you propose a cache or quote its saving.

## Rules

- **Measure first.** Time each job's setup steps apart from its work, and a restore apart from the install it replaces, from the jobs API's step timestamps. Propose a cache only where setup is a real share of the run, and only one whose restore costs less than the work it skips.
- **Key by every input that can change the output,** by what the cache holds, as [the recipes](references/caches.md#the-key-for-each-kind-of-cache) say. Nothing that changes every run, such as a timestamp, the run's ID or the commit, goes in.
- **Take only an exact match** for anything a job runs from, such as a whole install. A partial match (`restore-keys`) is a start for a package store that the install then checks, never a finished install.
- **Only main's own runs write** what every run reads. A pull request reads its own caches and its base's, and writes nothing others trust.

[The rules in full](references/caches.md) have why, with what each measured: who may write a cache, a warm install keyed by the manifests, a toolchain cache, images by digest, and what isn't worth caching.

## 1. Measure where setup goes

From recent runs of the workflow, for each job: queue, checkout, toolchain, install, any restore, then the work, from `gh run view <run-id> --repo <org>/<repo> --json jobs` or the jobs API's steps. Note which steps a cache already covers and whether each restored. Label every number measured (where, when, how many runs) or modelled.

## 2. Add or change a cache

Pick the cache that removes the most measured setup. To key a package store, a full install or build outputs, read [the key for each kind of cache](references/caches.md#the-key-for-each-kind-of-cache).

Record the cache in ci.md's Caches: its key, who writes it, who reads it.

## 3. A cache that never hits

When a cache misses on runs that should have hit, read [the usual causes](references/misses.md).

## 4. Show it

Measure the same jobs the same way after the change: a hit and a miss each, since a cold run still happens on every manifest change. Give the saving per job and per month, with how often the key changes. Judging that the evidence holds is the [`prove-it`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/prove-it/SKILL.md) skill.

## Task results

When the cache is a remote task cache of test, build or lint results, read [task results](references/caches.md#task-results).

## Not here

- Which tasks an edit reruns, and task inputs that move on unrelated edits: [`optimize-graphs`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/optimize-graphs/SKILL.md).
- Other changes to a workflow, its jobs, tiers and slow runs: [`ci-workflows`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-workflows/SKILL.md).
- Runner size and the bill, and Blacksmith's CLI and labels: the [`ci-doctor`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/SKILL.md) hub.
- A slow test: [`speed-up-tests`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/speed-up-tests/SKILL.md).

## Outside this skill

Every link that leaves this folder is a full link, so it reads the same with this skill installed alone: the guide at [ci-doctor.ref0.dev/guide/](https://ci-doctor.ref0.dev/guide/), and the hub, the other skills and the tools in [the ci-doctor repo](https://github.com/ref-0/ci-doctor) at the tag `v<version>`, the release this skill names in `metadata.version`.
