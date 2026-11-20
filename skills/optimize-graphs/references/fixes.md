<!--
What: the fixes for each graph, in the order to propose them, with what each buys, its traps, and how to adopt the checks in a repo that has none.
Where: read by a coding agent once a graph's measured width bears on the limit, before it proposes or makes the change.
Configure: package-graph.json and workspace-tools.json, for tools/workspace/'s package-graph check.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Fixes

Part of the [`optimize-graphs`](../SKILL.md) skill. Each fix is a change to the user's code: its own step, its own yes, one package per change, measured before and after as [measure](measure.md#verify-a-change) says. [Guide section 21](https://ci-doctor.ref0.dev/guide/docs/pages/21-optimize-all-of-your-graphs.md) has what each cost and saved in the source repo.

## 1. Declare and hold the package graph

**When:** nothing but review stops a new import across packages.

- Declare every edge in one file, by entry point and by kind: `values` (any import), `types` (only `import type` and `export type`; `import { type X }` still loads the module under `verbatimModuleSyntax`) and `tests` (only from tests and the `testing/` modules they share).
- Three rules on top: **nothing imports an app**, so an app edit reaches only its own tests; **a package imports another only by name,** through `exports`, never by a relative path; **each edge is in the importer's manifest,** so a selector that reads manifests sees every import.
- **Buys:** selection that stays narrow, since a new edge is a reviewed one-line diff; cache keys an unrelated edit doesn't move; per-project type checks that recheck only what reads an edit; packages that publish or deploy alone.
- **Trap:** pattern rules such as `no-restricted-imports` match what an import names, so they miss relative paths.

## 2. Split a root barrel into entry points

**When:** one module's edit selects most of a package's importers, and the tool flags the entry as overloaded with many commits through it.

- One entry per domain or area. Each entry file lists by name only what another package imports: names nothing outside imports stop being public, and their definitions stay.
- Heavy families, such as icons, charts or a code highlighter, get entries of their own, so the root loads none of their libraries.
- No `export *` in an entry file, held by a lint rule that reads entry files from each manifest's `exports`. Inside a package, `export *` is fine.
- Rewrite the imports by a script, one statement per entry, keeping `import type` as it was. On a rebase, rerun the script rather than resolve conflicts. Each entry needs a build entry too, naming its source first ([guide section 9](https://ci-doctor.ref0.dev/guide/docs/pages/09-workspace-tooling.md#no-build-before-checking-or-testing)).
- **Buys:** in the source repo, one module's edit went from 502 selected test files to 164, of 1,053, once the selector followed entries ([guide section 4](https://ci-doctor.ref0.dev/guide/docs/pages/04-run-only-what-a-change-can-reach.md#a-selector-built-from-a-real-dependency-graph)). Packages with few entries keep package edges: following entries buys nothing there.
- **Trap:** a test file that reaches most of the package anyway loads no faster. Measure selection, not import time or the bundle.

## 3. Layers

**When:** a large package's folders import each other round, and near selection climbs from a small edit to most of it.

- **Find the order; don't guess it from names.** Search for the folder order with the fewest imports against it, then stack each place as low as its imports allow. Folders that sound like foundations can be feature areas. The tool's proposed layers are a starting point.
- **Declare it with today's imports as exceptions,** by file and the module it imports, not by folder pair. A test fails on an exception no import needs, so each move deletes its entries, and the list says "add none".
- **Move code down, one change at a time,** each a pure move: shared helpers into a new bottom folder; configuration below its readers; files that compose two peer folders into a new folder above both; a service's definition split from its implementation.
- **Other languages:** a small script holds a Rust crate's modules the same way, reading `crate::` paths outside tests, with no exceptions if items move first.
- **Buys:** an edit reaches upward only, so a selector that climbs importers stops at the top of a short stack instead of going round a cycle.

## 4. Task inputs

**When:** a one-line edit moves keys it shouldn't, or tasks are keyed on the whole workspace.

- Declare each cached task's inputs; narrow global inputs; split a task whose inputs cover most of the repo.
- Removing package edges (fix 1) narrows every task's closure too.
- Check a runner's keys as [guide section 6](https://ci-doctor.ref0.dev/guide/docs/pages/06-reuse-work-by-its-real-inputs.md#checking-a-cache-on-another-task-runner) says, with its planned hashes and probes, before trusting a hit.

## 5. The job graph

**When:** blocked time on the critical path is a large share of the run, or the scorer names a top blocker most jobs wait on.

- Start setup that doesn't depend on the blocker in parallel with it, or depend on the step that makes what's needed instead of the whole job.
- Shorten the critical path before buying cores, as [guide section 7](https://ci-doctor.ref0.dev/guide/docs/pages/07-shards-runners-and-billing.md#shorten-the-critical-path-before-buying-cores) says. Queued time is runners, not the graph.
- A change to `needs:` changes what CI runs: inside the ci-doctor plan, it needs the user's yes.

## Adopt the checks

For a repo whose graphs 1–3 aren't declared. [`tools/workspace/`'s `package-graph`](https://github.com/ref-0/ci-doctor/blob/next/tools/workspace/README.md#the-package-graph) is the TypeScript checker; for other languages, its README gives the contract.

1. **Generate the graph as it is.** Copy `tools/workspace/` into the repo and install its parser, as [its setup](https://github.com/ref-0/ci-doctor/blob/next/tools/workspace/README.md#types-symbols-and-exports) says; that's a change to the repo, with its own yes. Then `node tools/workspace/src/bin.ts package-graph --generate > package-graph.json` writes every edge and entry today's imports draw. Fix only what it can't declare: an import of an app, and relative paths out of a package.
2. **Turn the check on in CI,** in the static job or lint, so the graph can't widen unseen. Every later step only narrows it.
3. **Tighten:** `--unused` lists edges and entries nothing uses. Then split the widest roots into entry points (fix 2).
4. **Layer the packages that need it** (fix 3). A stale exception fails, so the count only falls.

Start with the graph that sets the limit you measured, and don't do all five at once.
