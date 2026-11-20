[Guide](../README.md)

# 21. Optimize all of your graphs

**Applies when:** A workspace has several packages or a CI run of several jobs, and an edit selects, rebuilds or waits on more than it touches. **Skip when:** One package and one job, where there is no graph to shape.

How far a change reaches, and how long CI waits for it, are set by five graphs. Selection (section 4) and reuse (section 6) can only be as narrow as the graphs they walk: a selector that follows a package edge runs every test of the package at its end, and a cache key that hashes a package's inputs misses whenever anything in its closure moves. So we treated each graph as code: declared in one place, checked in CI, measured, and tightened.

| Graph | What decides it | What it decides | Measure |
|---|---|---|---|
| [Package dependencies](#package-dependencies-declared-and-checked) | Each package's imports of the others | Which packages' tests and builds an edit reaches | Edges, and imports no edge allows |
| [Package export paths](#export-paths-what-an-edit-triggers) | `exports` maps and the entry files behind them | Which of a package's importers an edit reaches | Test files an edit to one module selects |
| [Layers inside a package](#layers-and-folders-inside-a-package) | Imports between a package's folders | How far an edit climbs inside a package; cycles | Imports against the layers, and cycles |
| [Workspace tasks](#workspace-tasks) | Each task's dependencies, inputs and outputs | Which cache keys an edit changes | Keys a one-line edit moves |
| [CI jobs](#ci-jobs) | `needs:`, waits and runner queues | How long a run waits for its result | The critical path; blocked and queued time |

The first three are one graph seen at three sizes, packages, entry points and folders, and the fourth and fifth are built on them. An edge that's wider than the code needs costs on every run, and nothing flags it, so each graph below has a check that fails on a new edge and a measurement that shows the width of the old ones.

The measuring tool for graphs 1–4 is coming to `scripts/graph/` (its README will be `scripts/graph/README.md`); it runs locally, read-only. Graph 5 is read from CI's own records, and the scorer reads it from a repo's recent runs ([CI jobs](#ci-jobs)). Until the tool lands, [Measure the graphs](#measure-the-graphs) says what to count by hand.

## Package dependencies, declared and checked

**Applies when:** A workspace's packages import each other, and nothing but review stops a new import across them. **Skip when:** A single package, or a build tool that already refuses undeclared edges, such as Bazel's `deps`.

**What we did.** One file declares the graph. Each package and app names what it may import of every other: by package, by entry point (an `exports` key, such as `core` for `./core`, `.` for the root), and how:

| How | Allows |
|---|---|
| `values` | Any import |
| `types` | Only `import type` or `export type`, which load nothing. `import { type X }` still loads the module under `verbatimModuleSyntax`, so it counts as a value |
| `tests` | Any import, but only from tests and the `testing/` modules they share |

Three rules sit on top of the edges:

- **Nothing imports an app.** An app is a leaf: what another package needs moves into a package. So an edit to an app reaches only that app's own tests.
- **A package imports another only by name,** through its `exports`. A relative path out of a package fails, even into a package the graph allows, because a build resolves the name, not the path.
- **Each edge is also in the importer's manifest.** The manifest and the graph agree, so a selector that reads manifests sees every import (section 4 notes that pnpm's hoisting can hide undeclared ones).

A file that runs only in Node, such as a generator that writes an isolate's modules from a package's schemas, is listed by name and may take values on a `types` edge.

**One lint rule enforces it,** with a message per way to break it: the app, the missing edge, the entry its edge doesn't list (naming the entries it does), a `tests` entry outside tests, a value on a `types` edge, and the relative path. Its tests also hold the graph itself: it names every workspace package, lists only entries each target exports, and has no edge to an app.

**What it replaced.** Before, `no-restricted-imports` patterns covered four packages, by name only. Patterns match what an import names, so they missed relative paths, and one types-only pattern never fired at all. Writing the graph down found one edge the design had left out (an app's tests built server answers with a package's schemas, now a `tests` edge) and removed one that shouldn't exist.

**What it buys CI:**

- **Selection that stays narrow.** The selector's package edges are the declared ones, so a new edge is a reviewed diff in one file, not an import nobody noticed widening every run. With no edge into an app, no app edit selects another package.
- **Cache keys an unrelated edit doesn't change.** A task's workspace inputs are its package's closure in this graph (section 9's build-inputs rule reads the same manifests). An edge removed is a package whose edits no longer move that key.
- **Per-project type checks.** Each type project references only what its package imports, so the driver rechecks only projects that read an edit: after a one-line library edit, 20 of 23 projects replayed ([section 9](09-workspace-tooling.md#type-results-follow-content-across-worktrees)).
- **Packages that can be published or deployed alone.** No relative path leaves a package and every import is in its manifest, so what it packs is what it imports. A Worker that deploys alone has an empty edge list, and the check keeps it that way.

[`tools/workspace/`](../../tools/workspace/README.md#the-package-graph) has the checker (`package-graph`), with its tests.

## Export paths: what an edit triggers

**Applies when:** A shared package has a root barrel, or a few wide entry points, and an edit to one module selects most of its importers. **Skip when:** Each package is small enough that every importer uses most of it.

An import reaches everything its entry point re-exports. With one root barrel, every importer of a package reaches every module of it, so an edit to any module is an edit to all its importers, whatever the selector. Entry points are where that fan-out is decided.

**What we did,** package by package:

- **No root barrel for a shared package.** One package split into 24 entry points, one per domain, and lost its root; another into 20 area entries. Each entry file lists by name only what another package imports: 582 of the first package's 3,330 names stopped being public, and their definitions stayed.
- **Heavy families get entries of their own.** A UI package's root kept only its light components. Icons, charts, code highlighting, the calendar and the data table each got an entry, so nothing the root reaches loads their libraries: the root's runtime graph went from 155 modules to 123, none of them from those libraries.
- **No `export *` in an entry file,** checked by a lint rule that reads entry files from each manifest's `exports`. When it landed, 83 names stopped being exported. Re-exporting by name keeps an entry's surface a reviewed list. Inside a package, `export *` is fine.
- **Each edge in the package graph lists its entries,** so a new import of another entry is a one-line, reviewed change to the graph.

**What it cost.** A script rewrote the imports: one statement per entry, keeping `import type` as it was. It touched 1,788 files for the first package and 300 for another, and on a rebase we reran the script rather than resolve conflicts. Each entry needs a build entry too ([section 9's export guard](09-workspace-tooling.md#no-build-before-checking-or-testing) checks that each has one, and that each names its source first).

**What it saved.** For one module of the 20-entry package, Vitest's own import graph (`vp test list --filesOnly --changed`, one comment line added) selected 164 test files after the split, against 502 before, of 1,053. Two other modules went from 499 to 263 and 310. The selector follows entries for those two packages, as [section 4's package entry points](04-run-only-what-a-change-can-reach.md#a-selector-built-from-a-real-dependency-graph) says; packages with few entries keep package edges, where following entries buys nothing.

**What it didn't save.** The production bundle barely moved: the bundler already dropped unused modules. The gain is in what a dev server, a type check and a test file load. One test file's import time stayed within run-to-run noise because it reached most of the package anyway. Measure the selection, not the bundle.

## Layers and folders inside a package

**Applies when:** A package's folders import each other in both directions, or "near" selection climbs from a small edit to most of a package. **Skip when:** Packages are small, flat, or already split along their folders.

The package graph stops at a package's edge. Inside one, a helper written in a high folder pulls every folder that needs it up beside that one, until each reaches all the others, and a selector that climbs importers (section 4's "near") climbs through every cycle.

**What we did.** Each package's places (a top folder, or a file at the top, without its extension) stack in layers from the bottom. A file imports its own place and any place in a layer below; never one beside it, never above. Places that don't import each other share a layer. Type imports count, because they still tie two folders together. Tests don't, because nothing imports a test: counting them would have raised the first package's count from 110 to 250. A lint rule enforces it, with a message for beside, above, and a place in no layer.

**Exceptions only shrink.** The imports that broke the layers on the day the rule landed are listed as exceptions, by file and the module it imports, not by folder pair, so a file that already breaks the rule can't add more through its exception. A test fails on an exception no import needs, so each move deletes its entries. Nothing but review stops a new one, so the list's comment says "add none", and a new import that goes against the layers moves what it needs down instead.

**What it cost, on one package.** The rule landed with 110 exceptions. Six changes of pure moves, with nothing behaving differently, took it to 87, 73, 53, 30, 5 and 2:

- shared helpers into a new bottom folder;
- configuration and its readers below the clients that read it;
- the files that composed two peer folders into a new folder above both, which turned a band of six folders that called each other into ordered layers;
- a service's definition split from its implementation, so the definition sits below its callers and the implementation stays above.

The last two exceptions are kept on purpose and say why. The plan grew from five changes to six once the imports were mapped.

**Finding the layers.** For a larger package we didn't guess the order from folder names. We searched for the order with the fewest imports against it: 135 imports in 74 files, across 41 folder cycles. Two folders that sounded like foundations were feature areas. Stacking places as low as their imports allow gave 17 layers instead of 33. The listed cycles, largest first, are the plan for the moves that follow.

**Other languages.** The same layers hold a Rust crate through a small script, since the linter reads only TypeScript. It reads each module's `crate::` paths, outside tests and `#[cfg(test)]` items, fails each import beside or above and each cycle between modules, and ran in about 0.4 s locally. It landed with no exceptions: items moved first with identical bodies, then whole files, then the check.

**What it buys CI.** An edit reaches upward only. A selector that climbs importers stops at the top of a short stack instead of going round a cycle, and a fan-in cutoff (section 4's 20 importers) has fewer shared modules to stop at.

[`tools/workspace/`](../../tools/workspace/README.md#the-package-graph)'s `package-graph` checks TypeScript layers from the same file as the package graph. For other languages, its README gives the contract.

## Workspace tasks

**Applies when:** A task runner caches tasks, and a small edit misses more of the cache than it should. **Skip when:** No task runner, or nothing is cached.

The task graph is each task's dependencies, inputs and outputs, so its cache key. Section 6 covers [keying by real inputs](06-reuse-work-by-its-real-inputs.md#task-runners-and-their-remote-caches) and [checking a runner's keys](06-reuse-work-by-its-real-inputs.md#checking-a-cache-on-another-task-runner), and section 9 the [build-inputs rule](09-workspace-tooling.md#custom-lint-rules-that-guard-the-shortcuts). What the first three graphs add: a task's workspace inputs are its package's closure, so each edge removed above is a set of edits that no longer move its key.

**Measure:**

- **Keys a one-line edit moves,** for an edit to a leaf, a shared module and a root config, from the runner's planned hashes without running anything (Turborepo's `turbo run <task> --dry=json`; section 6's table has the others). Before we narrowed test inputs, 538 of 1,030 commits moved every test key.
- **The longest chain of `dependsOn`,** which no cache shortens on a miss.
- **Tasks keyed on the whole workspace,** by a global input or an incidental listing, each a candidate to narrow.

## CI jobs

**Applies when:** A run's result waits on jobs that wait on others, or on runners. **Skip when:** One job.

The job graph is `needs:`, waits on another job's step, and the queue each job waits in for a runner. Section 1 defines the [critical path](01-principles.md), section 3 the [plan → jobs → result shape](03-workflow-anatomy.md) and its wait action, and section 7 [shortening the critical path](07-shards-runners-and-billing.md#shorten-the-critical-path-before-buying-cores).

**Measure,** per job and per run, from the jobs API (section 13's [collection recipe](13-records-evidence-of-what-ran.md#collecting-from-the-api-without-losing-runs)):

- **Queued time:** from the job's creation to its start, a runner's wait. More runners or a smaller label fix it, not a new graph.
- **Waits `needs:` doesn't show:** GitHub creates a job when its needs finish, so a job created well after its last `needs:` finished waited on something else, such as a concurrency group, an environment or another workflow. A polling step waits inside a job, and reads as its work.
- **Blocked time:** from the run's start until its last `needs:` finished, which only a change to the graph shortens.
- **The critical path:** the chain of jobs that ends last, and what ends it. It can be lint, packing or a queue, not a shard (section 1).

**The scorer** (`npx @ref0/ci-doctor`) reads the graph from the workflow files, `needs:`, matrices, reusable workflows and `if:`, and joins it with the jobs of its sampled PR runs, with no extra API calls unless a repo has more than 40 workflow files. Its report's "Job graph" block, and `jobGraph` in `--json`, give:

- **the chain that sets the wait,** each job with its minutes and share, and how many sampled runs it set;
- **blocked, queued and work time** on that chain, and each job's in every sampled run, to scale, for a replay;
- **the top blocker:** the job that holds up the most downstream job-minutes, each dependent counted only for how long it waited on this job past its other needs;
- **setup in the path:** setup minutes in path jobs that first waited on others, which overlapping with upstream work could hide;
- **a wait on one step, as a guess:** a job that needs a whole job whose last step that makes something ended minutes before it did;
- **waits the YAML can't show:** runs with a job created over 2 minutes after its known needs finished, and steps named for waiting or polling;
- **runs left out:** the graph is the default branch's, so a run whose jobs don't fit it, such as a PR that changed a `needs:`, is counted and left out of the rest, rather than read wrong.

Its fixes "Setup on the critical path" and "A blocker most jobs wait on" link here and to section 7. A job in another repo's reusable workflow is taken as one job, since reading it would cost calls, and one workflow's file can't show what another workflow or a `workflow_run` trigger holds up.

## Measure the graphs

**Applies when:** Before tightening any graph above, and after each change to one. **Skip when:** Nothing above applies.

Count before you move code. Our selector's tests do this against the workspace's own import graph: for a handful of modules, they check that the selector picks every test file the real import graph reaches from an edit to it. That's how one package's edges were caught picking 520 test files, 179 of them in one consumer whose import graph reached 11.

The measuring tool for graphs 1–4 is coming to `scripts/graph/`. Until it lands, measure by hand:

| Graph | Count | From |
|---|---|---|
| Package dependencies | Edges; imports no edge allows; edges no import uses | `package-graph` and `package-graph --unused` ([`tools/workspace/`](../../tools/workspace/README.md#the-package-graph)) |
| Export paths | Test files one edit selects, by package edges, by entries and by the import graph, for a few modules per shared package; names each entry exports that nothing imports | The selector's output, and `vp test list --filesOnly --changed` (or `vitest list --changed`) with one line added to the module |
| Layers | Imports against the layers, and folder cycles, largest first | `package-graph` with `layers` set, or the order search in [Adopt them](#adopt-them-in-a-repo-that-has-none) |
| Workspace tasks | Keys one edit moves | The runner's dry run |
| CI jobs | Blocked and queued time, and the critical path | The jobs API, or the scorer's "Job graph" block |

Replay a change to any graph over recent merges before you call it a saving, as [section 4](04-run-only-what-a-change-can-reach.md#verify-the-selector-like-production-code) does for the selector.

## Adopt them in a repo that has none

**Applies when:** Graphs 1–3 aren't declared yet. **Skip when:** They are.

1. **Generate the current package graph and declare it as it is.** `node tools/workspace/src/bin.ts package-graph --generate > package-graph.json` writes every edge and entry the imports draw today. Fix only what it can't declare: an import of an app, and relative paths out of a package.
2. **Turn the check on in CI** (the static job, or lint), so the graph can't widen unseen. Every later step only narrows it.
3. **Tighten.** `--unused` lists edges and entries nothing uses. Then split the widest roots into entry points, by a script that rewrites imports, one package per change, measuring the selection before and after.
4. **Layer the packages that need it.** Search for the folder order with the fewest imports against it, declare it with those imports as exceptions, and move code down change by change. A stale exception fails, so the count only falls.

Don't do all five graphs at once. Measure each, and start with the one that sets the limiter you measured in Phase 2.
