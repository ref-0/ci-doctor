<!--
What: the five graphs that decide how far a change reaches and how long CI waits: where each is declared, what holds it, and what to count.
Where: read by a coding agent mapping a repo's graphs, in the ci-doctor plan's Phase 1 or on its own, and before it changes packages, exports, folders, tasks or jobs.
Configure: nothing; the package-graph checker is in tools/workspace/, configured by the repo's workspace-tools.json and package-graph.json.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The graphs

Part of the [`optimize-graphs`](../SKILL.md) skill. For each graph, record where it's declared, whether a check holds it, and one measured width.

| Graph | Where it's declared | Is it held? | Count |
|---|---|---|---|
| Package dependencies | Manifests; any import-boundary lint config or graph file | A check fails an import no edge allows, a relative path out of a package and an import of an app | Edges; imports no manifest lists; cycles |
| Package export paths | Each shared package's `exports` and its entry files | Entry files re-export by name; a check fails an entry the edge doesn't list | Entries per shared package; whether a root barrel re-exports most of it; test files one module's edit selects |
| Layers inside a package | Folder conventions, any layer config | A check fails an import beside or above; exceptions can only shrink | Folder cycles in the largest packages |
| Workspace tasks | The task runner's config | Each cached task's inputs and outputs declared or tracked | Keys a one-line edit moves; the longest `dependsOn` chain |
| CI jobs | Workflow `needs:` and waits | A plan job gates the others | The critical path; blocked and queued time per job |

Counting the first three takes the repo's imports, read without running anything: the graph tool, a parser over tracked files, or the test runner's own listing where it lists without running (`vitest list --filesOnly --changed` builds the import graph but runs no test; ask before you run it).

## 1. Package dependencies

An edge is one package importing another. A selector that follows package edges runs every test of the package at the edge's end, and a cache key that hashes a package's closure misses whenever anything in it moves.

- **Look for:** cycles, between manifests or between runtime imports; imports no manifest names, which pnpm's hoisting hides from a selector that reads manifests; packages importing an app; relative paths out of a package; the longest chain, which sets how many packages one leaf edit passes through.
- **Held when** one file declares each package's edges, by entry point and by kind (values, types only, tests only), and a check fails anything else. Without that, nothing but review stops a new edge widening every run.

## 2. Package export paths

An import reaches everything its entry point re-exports. With one root barrel, every importer of a package reaches every module in it.

- **Look for:** export-path overload, the modules an entry re-exports times the packages that import it; `export *` in entry files; the files whose change reaches the most; entries nothing imports.
- **Held when** entry files re-export by name, a lint rule fails `export *` in them, and each package edge lists the entries it may import.

## 3. Layers inside a package

A package's places are its top folders, and files at its top without their extension. A helper written in a high folder pulls every folder that needs it up beside that one, until each reaches all the others.

- **Look for:** folder cycles, largest first, with the imports inside them. Count type imports, which still tie two folders together, and leave tests out, since nothing imports a test.
- **Held when** places stack in declared layers, a file imports only its own place and those below, and the imports that broke the layers on the day the rule landed are listed as exceptions, by file and module, that fail once nothing needs them.

## 4. Workspace tasks

The task graph is each task's dependencies, inputs and outputs, so its cache key. A task's workspace inputs are its package's closure in graph 1, so each edge removed there is a set of edits that no longer move its key.

- **Look for:** cached tasks with no declared inputs (any change in the package misses) or empty inputs (a source change hits wrongly); inputs covering most of the repo, through a global input or an incidental listing; the longest `dependsOn` chain, which no cache shortens on a miss.
- **Count** the keys a one-line edit moves, for an edit to a leaf, a shared module and a root config, from the runner's planned hashes without running anything: Turborepo's `turbo run <task> --dry=json`, and [guide section 6's table](https://ci-doctor.ref0.dev/guide/docs/pages/06-reuse-work-by-its-real-inputs.md#task-runners-and-their-remote-caches) for the others.

## 5. CI jobs

`needs:`, waits on another job's step, and the queue each job waits in for a runner.

- **Queued time:** from a job's creation to its start. More runners or a smaller label fix it, not a new graph.
- **Blocked time:** from the run's start until the job's last `needs:` finished. Only a change to the graph shortens it.
- **Waits `needs:` doesn't show:** a job created well after its last `needs:` finished waited on something else, such as a concurrency group, an environment or another workflow. A polling step waits inside a job and reads as its work.
- **The critical path:** the chain of jobs that ends last, and what ends it. It can be lint, packing or a queue, not a shard.

The scorer's "Job graph" block gives the chain, its blocked, queued and work time, the top blocker, setup in the path and waits the YAML can't show. [Guide section 21's CI jobs](https://ci-doctor.ref0.dev/guide/docs/pages/21-optimize-all-of-your-graphs.md#ci-jobs) lists each field.
