---
name: optimize-graphs
description: "Measures and narrows how far an edit reaches: package dependencies, exports and barrel files, layers, task inputs and the CI job graph. Use when one edit reruns most tests or builds, an unrelated edit misses a task cache, or CI runs everything. Not for setup caches (cache-ci); a slow job (ci-workflows)."
metadata:
  version: "0.4.0"
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
- **Measuring is read-only.** The graph tool reads committed trees with `git` and runs nothing in the repo. Run no installs, builds or tests to count a graph unless the user says so. Inside the ci-doctor plan, its [read-only rule](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/SKILL.md#before-approval-read-only) holds until the plan is approved.
- **A package refactor is a change to the user's code, not their CI.** Propose each as its own step and get its own yes: one package per change, by a script where imports move.
- **A selector change is a CI change.** It gets its own pull request, follows [its own rules](references/selection.md#rules-for-a-selector-change), and keeps the current selector until a replay shows the new one keeps its coverage.
- **Tighten only the graph that sets the limit you measured.** Don't do all five at once.
- **A saving is a replay,** not a guess: the same recent merges through the graph before and after.

## 1. Measure

When you measure, read [measure](references/measure.md): the graph tool and getting it, graph 5, the scorer, and counting by hand.

## 2. Read the five

Paste the tool's headline, one line per graph, then read it [as measure says](references/measure.md#read-the-headline).

Record, for each graph: where it's declared, whether a check holds it, and one measured width. Mark one not applicable only with a reason, such as "one package".

## 3. Propose, in this order

Only for a graph whose width bears on the measured limit. [Fixes](references/fixes.md) has each one's steps, what it buys and its traps.

When you propose, read [the order to propose them](references/fixes.md#the-order-to-propose-them).

For each proposal give: the graph and its measured width, the change by file or package, what it's expected to buy (labelled), how you'll verify it, and the cost in files touched.

## 4. Verify

Replay the last merges through the graph before and after, and compare like with like: the same commits, the same test pattern, the same conditions. [Measure](references/measure.md#verify-a-change) says how.

## Which checks a change runs

The selector, which picks a change's jobs and tests, walks these graphs. Before changing it, lockfile routing or test selection, read [selection](references/selection.md): where to start, with or without `.agents/repo/ci.md`, its rules, and replaying past regressions.

## 5. Adopt the checks in a repo that has none

Graphs 1–3 are declared in one file and held by one check. [Fixes](references/fixes.md#adopt-the-checks) has the steps, with `package-graph` from [`tools/workspace/`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/tools/workspace/README.md#the-package-graph) for TypeScript, copied into the repo, and its contract for other languages.

## Not here

- Editing a workflow, its jobs, tiers and slow runs: [`ci-workflows`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-workflows/SKILL.md). Runners, the bill and the ci-doctor plan: the `ci-doctor` skill. Its Phase 1 maps these graphs with this skill.
- Slow setup, and a setup cache that misses: [`cache-ci`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/cache-ci/SKILL.md).
- Whether a test is worth keeping: `test-audit`.

## Outside this skill

Every link that leaves this folder is a full link, so it reads the same with this skill installed alone: the guide at [ci-doctor.ref0.dev/guide/](https://ci-doctor.ref0.dev/guide/), and the hub and the tools in [the ci-doctor repo](https://github.com/ref-0/ci-doctor) at the tag `v<version>`, the release this skill names in `metadata.version`.
