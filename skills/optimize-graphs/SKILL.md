---
name: optimize-graphs
description: "Measures and narrows how far an edit reaches: package dependencies, exports and barrels, layers, task inputs, the CI job graph and which checks run. Use when one edit reruns most tests or builds, an unrelated edit misses a task cache, or CI runs everything. Not for setup caches (cache-ci); a slow job (ci-workflows)."
metadata:
  version: "0.1.0"
---

# optimize-graphs

How far an edit reaches, and how long its checks wait, are set by five graphs. A selector, a cache key or a type check can only be as narrow as the graph it walks: an edit to one module behind a root barrel reaches every importer of the package, and a folder cycle makes "near" selection climb to all of it. This skill measures the five, says which one to tighten first, and how to hold it there.

Use it when a small edit runs or rebuilds far more than it touches, before adding a package, an edge, an entry point or a barrel file, when splitting a package or moving its folders, and when a task's cache misses on edits it shouldn't see. [Guide section 21](https://ci-doctor.ref0.dev/guide/docs/pages/21-optimize-all-of-your-graphs.md) has why, what each change cost and what it saved; this skill is what to do.

## The five graphs

| # | Graph | Decided by | Decides |
|---|---|---|---|
| 1 | Package dependencies | Each package's imports of the others | Which packages' tests and builds an edit reaches |
| 2 | Package export paths | `exports` maps and the entry files behind them | Which of a package's importers an edit reaches |
| 3 | Layers inside a package | Imports between a package's folders | How far an edit climbs inside a package |
| 4 | Workspace tasks | Each task's dependencies, inputs and outputs | Which cache keys an edit moves |
| 5 | CI jobs | `needs:`, waits and runner queues | How long a run waits for its result |

The first three are one graph at three sizes, and the last two are built on them. [The graphs](references/graphs.md) says, for each, where it's declared, what holds it and what to count.

## Rules

- **Measure before you propose,** and quote every count with its denominator: "24% of 308 test files", not "24%". Label each number measured (where, when, at which commit), replayed or guessed.
- **Measuring is read-only.** The graph tool reads committed trees with `git` and runs nothing in the repo. Run no installs, builds or tests to count a graph unless the user says so. Inside the ci-doctor plan, its [read-only rule](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-doctor/SKILL.md#before-approval-read-only) holds until the plan is approved.
- **A package refactor is a change to the user's code, not their CI.** Propose each as its own step and get its own yes: one package per change, by a script where imports move.
- **A selector change is a CI change.** It gets its own pull request, follows [its own rules](references/selection.md#rules-for-a-selector-change), and keeps the current selector until a replay shows the new one keeps its coverage.
- **Tighten only the graph that sets the limit you measured.** Don't do all five at once.
- **A saving is a replay,** not a guess: the same recent merges through the graph before and after.

## 1. Measure

For a JavaScript or TypeScript workspace, run the graph tool. It measures graphs 1–4 and replays recent merges through them, with Node 24 and `git`, and nothing installed:

```sh
node <ci-doctor>/scripts/graph/graph.ts --repo <path-to-repo> --commits 0   # the shape only
node <ci-doctor>/scripts/graph/graph.ts --repo <path-to-repo>               # and the last 200 merges
```

`<ci-doctor>` is a ci-doctor checkout. A skills-only install, by `npx skills add` or a copy of this folder, doesn't carry the tool: clone it once, outside the user's repo, on `next` until the release that adds this skill, then at the release this skill names in `metadata.version`:

```sh
git clone --depth 1 --branch next https://github.com/ref-0/ci-doctor.git <ci-doctor>
```

Graph 5 comes from CI's records. On GitHub Actions, the scorer reads it from the workflow files and recent PR runs, through `gh` with the user's own sign-in: `npx @ref0/ci-doctor`, then its "Job graph" block, or `jobGraph` in `--json`. Elsewhere, the provider's jobs API, as guide section 13's [collection recipe](https://ci-doctor.ref0.dev/guide/docs/pages/13-records-evidence-of-what-ran.md#collecting-from-the-api-without-losing-runs) says.

Without a checkout, the scorer's "Graphs" block, or `graphs` in `--json`, has graphs 2 and 4 from outside too. For export paths, it lists each entry's re-exported modules, its importing packages and its overload. The importer count is exact for a package with one entry; otherwise it's a range, from the packages seen in the files read up to the package's importers by manifest, and only the seen ones flag `overloaded-entry`. For tasks, it reads each runner's config by that runner's rules and flags `no-inputs`, `wide-inputs` and `deep-chain`. Graph 3 still needs the tool. An entry the scorer couldn't follow is marked unknown, with why.

Another language, or no tool: count by hand, as [measure](references/measure.md#by-hand) says.

## 2. Read the five

Paste the tool's headline, one line per graph, then read it [as measure says](references/measure.md#read-the-headline). In short:

- **The file graph's share well below the package-level share** at p50: selecting by files or entries pays.
- **p90 at 100%:** look at the widest triggers before the graph. A lockfile or a root config behind most of them is a selection rule to fix ([guide section 4](https://ci-doctor.ref0.dev/guide/docs/pages/04-run-only-what-a-change-can-reach.md#a-selector-built-from-a-real-dependency-graph)), not a barrel.
- **An overloaded entry with many commits through it:** the first barrel to split.
- **A cycle,** between packages or folders: what makes a selector that climbs importers reach everything.
- **A cached task with no inputs or with inputs over half the repo:** a key that moves on unrelated edits.
- **Blocked time on the critical path:** only a change to the job graph shortens it; queued time is runners.

Record, for each graph: where it's declared, whether a check holds it, and one measured width. Mark one not applicable only with a reason, such as "one package".

## 3. Propose, in this order

Only for a graph whose width bears on the measured limit. [Fixes](references/fixes.md) has each one's steps, what it buys and its traps.

1. **No check on the package graph:** declare the current graph as it is, and hold it in CI. It narrows nothing by itself; it stops the graph widening unseen.
2. **One module's edit selects most of a package's importers:** split the root barrel into entry points, one package per change, with the selection measured before and after. Name the modules you'll measure.
3. **Cycles inside a large package make near selection climb to most of it:** declare layers with today's imports as exceptions, then move code down change by change.
4. **Cache keys a one-line edit moves, or a long `dependsOn` chain:** narrow task inputs, as guide section 6 [keys by real inputs](https://ci-doctor.ref0.dev/guide/docs/pages/06-reuse-work-by-its-real-inputs.md#checking-a-cache-on-another-task-runner).
5. **Blocked time on the critical path:** reshape the job graph, as guide section 7 [shortens the critical path](https://ci-doctor.ref0.dev/guide/docs/pages/07-shards-runners-and-billing.md#shorten-the-critical-path-before-buying-cores).

For each proposal give: the graph and its measured width, the change by file or package, what it's expected to buy (labelled), how you'll verify it, and the cost in files touched.

## 4. Verify

Replay the last merges through the graph before and after, and compare like with like: the same commits, the same test pattern, the same conditions. [Measure](references/measure.md#verify-a-change) says how. A selector that follows the new graph must still pick every test the real import graph reaches: check a handful of modules against an independent listing, such as `vitest list --filesOnly --changed` with one line added to the module.

The bundle is the wrong measure, since a bundler drops unused modules: measure selection, cache keys and reruns of type checks.

## Which checks a change runs

The selector, which picks a change's jobs and tests, walks these graphs. Before changing it, lockfile routing or test selection, read [selection](references/selection.md): where to start, with or without `.agents/repo/ci.md`, its rules, and replaying past regressions.

## 5. Adopt the checks in a repo that has none

Graphs 1–3 are declared in one file and held by one check. [Fixes](references/fixes.md#adopt-the-checks) has the steps, with `package-graph` from [`tools/workspace/`](https://github.com/ref-0/ci-doctor/blob/next/tools/workspace/README.md#the-package-graph) for TypeScript, copied into the repo, and its contract for other languages. In short: generate the graph as it is, fix only what it can't declare, turn the check on, then tighten with `--unused`, entry points and layers. A stale exception fails, so the count only falls.

## Not here

- Editing a workflow, its jobs, tiers and slow runs: [`ci-workflows`](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-workflows/SKILL.md). Runners, the bill and the ci-doctor plan: the `ci-doctor` skill. Its Phase 1 maps these graphs with this skill.
- Slow setup, and a setup cache that misses: [`cache-ci`](https://github.com/ref-0/ci-doctor/blob/next/skills/cache-ci/SKILL.md).
- Whether a test is worth keeping: `test-audit`.

## Outside this skill

Every link that leaves this folder is a full link, so it reads the same with this skill installed alone: the guide at [ci-doctor.ref0.dev/guide/](https://ci-doctor.ref0.dev/guide/), and the hub and the tools in [the ci-doctor repo](https://github.com/ref-0/ci-doctor) on `next`, the branch the skills track. To read them at a release instead, open the repo at the tag `v<version>`.
