# Graph: how a workspace is wired, and what a change triggers

`graph.ts` measures the four graphs [guide section 21](../../docs/pages/21-optimize-all-of-your-graphs.md) shapes in a JavaScript or TypeScript workspace: package dependencies, package export paths, layers inside a package and workspace tasks. It then replays recent merges through them, to show what each change triggered as a share of the workspace. That share says whether narrowing selection is worth it, and where. The fifth graph, CI jobs, comes from CI's records and the scorer.

It measures; it doesn't enforce. [`tools/workspace/`'s `package-graph`](../../tools/workspace/README.md#the-package-graph) holds a declared package graph and its layers in CI and fails a new edge. This tool reads what the code draws today, declared or not, and how wide each edge is, so you know which graph to declare or tighten first. They don't share code or config. `--layers` takes `package-graph.json` itself, or a file holding only its `layers`.

Reference implementation from a production monorepo; adapt to your repo.

## Run it

Node 24 or later and `git`. No install, and nothing in the repo runs: it reads committed trees with `git ls-tree` and `git cat-file`, never the working tree. That makes it safe before approval ([ci-doctor's read-only rule](../../skills/ci-doctor/SKILL.md#before-approval-read-only)).

```sh
node scripts/graph/graph.ts --repo <path-to-repo>                   # the default branch, the last 200 commits
node scripts/graph/graph.ts --repo <path-to-repo> --json > graph.json
node scripts/graph/graph.ts --repo <path-to-repo> --commits 0       # the shape only, no replay
```

| Option | Default | What |
|---|---|---|
| `--repo <dir>` | `.` | The repo |
| `--rev <ref>` | `origin/HEAD`'s target, else `main` or `master` | The branch to measure and replay |
| `--commits <n>` | `200` | First-parent commits to replay. A shallow clone needs `--depth` past this |
| `--tests <regex>` | `.test.`, `.spec.`, `_test.`, `__tests__/` | What a test file's path looks like |
| `--conditions <a,b>` | none: the first tracked target, in document order | `exports` conditions to prefer, in order, such as your source condition |
| `--layers <file.json>` | none: layers are proposed | Declared layers, `{ "<source folder>": [["bottom"], ["next", "beside"]] }`, or a `package-graph.json` that has them |
| `--json` | off | The JSON report below, instead of the readable one |

On a 206-package workspace of 2,666 files, measuring the shape and replaying 200 commits took 23 s on one core. A single package took 2 s.

## What it reads

- **Packages:** pnpm's `pnpm-workspace.yaml`, or `workspaces` in the root `package.json` for npm, Yarn and Bun. Without either it reads a single package. The root is a package too: in a monorepo it holds the scripts and shared configs outside every package.
- **Imports:** static `import` and `export … from`, `import()` and `require()` of a string, `new URL('…', import.meta.url)` and `import.meta.glob`, from `.ts`, `.tsx`, `.js` and their `m`/`c` forms, plus `.vue`, `.svelte` and `.astro`. Comments and multi-line template strings are skipped. Statements are read whatever their spacing, with keywords as names (`import { async as run }`); one it can't read is counted as `unparsed`, never dropped. Only `import type` and `export type` are type-only. `import { type X }` still loads its module under `verbatimModuleSyntax`, so it counts as a value.
- **Resolution:** relative paths, with TypeScript's `.js`-for-`.ts` mapping and folder indexes; tsconfig `paths` against the effective `baseUrl` (inherited through `extends`), else against the config declaring them; a package's `imports` (`#x`), where a `#` specifier with no match is `missing`; and workspace packages through `exports`, or `main`, `module`, `source` or `types` when a package has no `exports`. `exports` patterns match in Node's order (the longest prefix before `*`, then the longest key), and a `null` target excludes its subpath. Each target is tried as itself, then by extension, before the next condition. A runtime import or `require()` skips `types` and the other format's conditions (`require` for an import, `import` and `module` for a `require()`), and an entry with both an ESM and a CommonJS file reaches both. `types` counts for `import type`, and for a runtime import only as a guess when it names source. A target that's build output (`dist/x.js`) maps to its source (`src/x.ts`) by convention, in a package's folder or at the repo's root, and each such import is counted. Third-party packages and Node's built-ins are counted, never followed.
- **Tasks:** Turborepo's `turbo.json` (`tasks`, or v1's `pipeline`), packages' `turbo.json` and `globalDependencies`; Nx's `nx.json` (`targetDefaults`, `namedInputs`, `cacheableOperations`) and `project.json`; Vite+'s `run.tasks` and `run.cache`, when the config's `run` is a plain object literal; and package scripts that call each other. That covers `pnpm run x`, `npm run x`, `yarn x`, `bun run x`, `run-s`/`run-p`, pnpm's `/regex/` selectors, `pre` and `post` scripts, and recursive runs (`-r`, `--filter`, `turbo run`, `nx run-many`, `vp run -r`, `lerna run`), which fan out to every package with that script.

## Measure the graphs

Each graph is a section of the readable report, in this order, and an object of the JSON report. Each flag carries its numbers and the threshold it crossed. Thresholds are in `THRESHOLDS`, which `shape.ts` takes from the module it shares with the scorer.

### 1. Package dependencies

- **Per package:** its files and test files, its internal dependencies and dependents by manifest, its fan-in (how many other packages, and how many of their files, import it) and its depth (the longest chain of internal dependencies below it).
- **The longest chain** of internal dependencies, which sets how many packages one leaf edit can pass through.
- **Flags:** `package-cycle`, between manifests or between runtime imports outside tests and the root; and `undeclared-import`, a package that imports another without naming it in its manifest, which pnpm's hoisting hides from a manifest-reading selector.
- **Replay:** the share of packages with files in the import graph a commit reaches.

### 2. Package export paths

- **Per entry** (each `exports` key, or `.` for a package without `exports` that another imports): the file it resolves to, the packages and files that import it, whether it's a barrel, its `export *` count, and the workspace files loading it loads.
- **Export-path overload:** the modules an entry re-exports, directly or through `export *` and `export { } from` chains, times the packages that import it. An entry at the top ties every module it re-exports to every package that imports it, so one edit to any of those modules reaches all of them. Section 21's [export paths](../../docs/pages/21-optimize-all-of-your-graphs.md#export-paths-what-an-edit-triggers) is what to do about one. Flagged as `overloaded-entry` at 20 or more modules to 3 or more packages, the top 20 by overload. With a replay, each flag also says how many commits' reach went through that entry.
- **The widest files:** the 20 files whose change reaches the most of the workspace, by the files that import them directly or not, with the packages and test files among those, as `wide-file` flags.
- **Flags:** `unused-entry`, an entry of a private package that no other package imports.
- **Replay:** the share of entries, files and test files a commit reaches through the file graph, beside the share of tests a package-level selector would run for the same commit (the changed packages and their dependents). The gap between the two is what selecting by entries and files buys.

### 3. Layers inside a package

- **Places:** each package's source folder (`src/` when it has one) splits into places: each top folder, and each file at its top without its extension, as section 21 counts them. The folder-to-folder import graph counts type imports and leaves tests out.
- **Proposed layers,** when none are declared: each place as low as its imports allow, the places in one cycle sharing a layer. It's a starting point to declare, not an answer.
- **Flags:** `folder-cycle`, places that import each other round, largest first, with the imports inside. With `--layers`, also `layer-violation` (an import beside or above, with an example) and `unplaced-folder`.

### 4. Workspace tasks

- **Per task** (`<package>#<task>`): its runner, whether a cache keys it, its declared inputs and outputs, and how many tracked files its inputs cover. Input modes are `declared`, `package-default` (no inputs declared, so the runner keys every file of the package), `auto` (Vite+'s automatic tracking, approximated by the package's files), `empty` (`inputs: []`, so only the command and environment key it) and `unknown` (uncached).
- **Edges:** `dependsOn` and `dependencies` (`^task`, `from:`), `calls` (a script runs another), `fan-out` (a recursive run) and `lifecycle` (`pre` and `post`). Nx's project dependencies come from manifests and from imports, as Nx infers them.
- **The longest chain** of tasks, which no cache shortens on a miss.
- **Flags:** `no-inputs` (a cached task with no declared inputs, so any change in the package misses, or with empty inputs, so a source change hits the cache wrongly), `wide-inputs` (a cached task whose inputs cover more than half the repo's tracked files), `task-cycle` and `deep-chain` (6 tasks or more).
- **Replay:** the share of cached tasks whose inputs a commit touches, and with the tasks that depend on them, since a dependency's key is part of theirs.

### What a change triggers

The replay takes the last `--commits` first-parent commits of the branch and diffs each against its first parent, so a merge commit counts its whole pull request. Each commit is measured through the graphs as they stood at that commit. Each changed path is classified:

| Cause | Paths | Reaches |
|---|---|---|
| `graph` | A file in the import graph, including any file an import names, such as a `./fixture.txt?raw` | Its importers, directly or not, across packages |
| `package` | A package's config (`package.json`, `tsconfig`, `*.config.*`), or a file in a package that nothing imports | The package and its dependents, whole |
| `everything` | CI config, the root manifest, lockfiles, root configs, and unknown files at the root of a monorepo | Every file and test |
| `none` | Docs, lint and editor config, assets nothing imports | Nothing |

The report gives the p50 and p90 by nearest rank, how many commits reach every test and how many reach none, and the files behind the widest triggers: for the commits at or above p90 of tests reached, the changed path whose own reach was widest. A file that's always there, such as the lockfile, is a candidate to narrow first.

## Read the output

The readable report starts with a headline of one line per graph, which the `ci-doctor` skill pastes into its Phase 2 baseline:

```text
Workspace: pnpm, 206 packages, 2,666 files in the import graph (308 tests), main at <sha>
Unresolved: 61 of 8,041 (0.8%) specifiers: 57 missing, 4 computed
1 Packages: depth 5, 0 cycles, 2 undeclared imports; a commit reaches p50 77%, p90 100% of the 203 packages with files
2 Exports: 64 entries, 7 overloaded (top <pkg>#.: 38 modules × 40 packages); a commit reaches tests p50 24%, p90 100% (package-level selection: p50 32%, p90 100%)
3 Layers: 192 sources with folders, 4 folder cycles, no layers declared
4 Tasks: 1241 tasks (670 cached; nx), depth 6, 0 cached with no declared inputs, 7 with inputs over 50% of the repo; a commit touches p50 6.2%, p90 99% of cached tasks' inputs
Replay: 200 of 200 commits asked on main; 79 of 200 (40%) reach everything; widest triggers: pnpm-lock.yaml (67), package.json (4), …
```

How to read it:

- **Narrowing pays when the file graph's share is well below the package-level one,** at the p50 a typical change sits at. In the example, selecting by files would run a quarter of the tests where package edges run a third. In a single package of 14 test files, it was 8% against 100%.
- **When p90 is 100%, look at the triggers before the graph.** If a lockfile or a root config is behind most of them, the next step is the lockfile and root-script rules of [section 4](../../docs/pages/04-run-only-what-a-change-can-reach.md#a-selector-built-from-a-real-dependency-graph), not entry points.
- **An overloaded entry with many commits through it** is the first barrel to split. A cycle, between packages or folders, is what makes a selector that climbs importers reach everything.
- **Every count has its denominator,** in the text and as `…Of` or `of` fields in JSON. Quote both.

## JSON

`--json` prints one object. `schema` is `1`; a field whose meaning changes, or that goes away, bumps it. Fields are only added within a version.

| Field | What |
|---|---|
| `schema` | `1` |
| `repo` | `{ rev, sha, workspace }`; `workspace` is `pnpm`, `npm`, `yarn`, `bun` or `single` |
| `denominators` | `{ trackedFiles, files, tests, packages, packagesWithFiles, entries, tasks, cachedTasks }`. `files` are the import graph's nodes. `packagesWithFiles` are the packages that own at least one, the set the replay's package shares and a flag's `packagesOf` count |
| `unresolved` | `specifiers` (`total`, `resolved`, `external`, `builtin`, `workspace`, `guessed`, `crossRelative`, `undeclared`) and `reasons`, each `{ count, examples, note }` |
| `packages` | The package graph |
| `exports` | The export-path graph |
| `layers` | The folder graph |
| `tasks` | The task graph |
| `replay` | `null` with `--commits 0`; else `{ branch, asked, commits, method, everything, docsOnly, triggers, perCommit }` |
| `thresholds` | The thresholds the flags used |

Each of the four graphs has `nodes`, `edges` and `flags`, and, except `layers`, a `replay` of `{ p50, p90 }` shares (or `null`):

| Graph | `nodes[]` | `edges[]` | Other fields |
|---|---|---|---|
| `packages` | `{ id, dir, files, tests, dependencies, dependents, importedBy: { packages, files }, depth }` | `{ from, to, declared, importingFiles }`; `declared` is the manifest fields, empty for an import no manifest names | `depth`, `chain`, `replay: { reached }` |
| `exports` | `{ id, pkg, key, pattern?, file, importedBy: { packages, files }, reexports, stars, barrel, loads, overload }`. Each exact `exports` key is an entry; under a `*` pattern, each subpath an import loads is one, `key` being the subpath and `pattern` the key it matched | `{ from, to, files }`: a package importing an entry | `replay: { entries, files, tests, packageLevelTests, through }`; `through` maps an entry to the commits whose reach went through it |
| `layers` | `{ id, source, place, files, layer, declared }` | `{ source, from, to, imports, example }` | `declared` |
| `tasks` | `{ id, pkg, name, runner, cached, inputs: { mode, globs, files }, outputs, depth }` | `{ from, to, how }` | `depth`, `chain`, `runners`, `unread`, `replay: { touched, withDependents }` |

A flag is `{ kind, subject, numbers, threshold, detail? }`. `numbers` holds counts and their denominators (`filesOf`, `testsOf`, `packagesOf`), and `threshold` is the threshold it crossed, or `null` for a flag that has none (a cycle):

| Graph | Flag kinds |
|---|---|
| `packages` | `package-cycle`, `undeclared-import` |
| `exports` | `overloaded-entry`, `wide-file`, `unused-entry` |
| `layers` | `folder-cycle`, `layer-violation`, `unplaced-folder` |
| `tasks` | `no-inputs`, `wide-inputs`, `task-cycle`, `deep-chain` |

Each `perCommit[]` is `{ sha, changed, causes, reached: { files, packages, entries, tests }, packageLevelTests, tasks: { touched, withDependents }, everything, widest?, through, of }`, with `of` the denominators at that commit (`of.packages` counts packages with files in the import graph).

## Limits

It counts what it can't resolve, and never drops it:

| Reason | What |
|---|---|
| `unparsed` | An `import` or `export` statement the scanner couldn't read, by its first line |
| `computed` | `import()` or `require()` of something that isn't a string |
| `context` | `require.context` folder patterns |
| `glob-empty` | `import.meta.glob` patterns that match no tracked file |
| `missing` | Relative or aliased paths with no tracked file: generated code (a framework's `./$types`), or a broken import |
| `not-exported` | A workspace subpath its package's `exports` doesn't name |
| `built-only` | A workspace entry whose every target is build output, with no source to map to |
| `too-large` | Files over 1 MiB, not parsed: bundles and generated code |

On the two repos it was tried on, unresolved specifiers were 0.8% of 8,041 (57 missing, mostly a framework's generated types, and 4 computed) and 0.6% of 170 (1 built-only).

It also doesn't see:

- **Edges outside imports:** a test that reads a file from disk, runs a bundle or a subprocess, or loads a fixture by a computed path. Section 4's coverage declarations exist for these, and the replay's reach is a floor for them.
- **Other languages,** and code only a build step generates.
- **Task config that isn't data:** a Vite+ config whose `run` is computed, or Nx plugins' inferred targets. Each is listed in `tasks.unread`. Vite+'s automatic input tracking is approximated by the package's files, and Turborepo's lockfile and environment hashing aren't modelled.
- **Third-party packages:** an edit inside `node_modules` isn't a commit, and lockfile changes reach everything here, not just the packages whose installs changed as the [selection planner](../../templates/plan/README.md) narrows them.

The replay's reach is what the graph says, not what a test run executed. Before narrowing a selector by it, compare selected and executed inventories, as [section 4](../../docs/pages/04-run-only-what-a-change-can-reach.md#verify-the-selector-like-production-code) says.

## Files

| File | What it does |
|---|---|
| `graph.ts` | The command, the JSON report and the readable one |
| `read.ts` | Git, packages, manifests, tsconfig `paths`, import parsing and resolution: one commit's file graph |
| `tasks.ts` | The task graph from Turborepo, Nx, Vite+ and package scripts |
| `shape.ts` | The four graphs' nodes, edges and flags, and the thresholds |
| `replay.ts` | The commit replay |
| `scorer/src/graph-core.ts` | Shared with the scorer, which reads the same files from GitHub: module parsing, `exports` resolution, the task reader and its measure, the graph helpers and `THRESHOLDS`. It imports only Node's modules, so this tool still needs no install. If you copy this folder, copy that file too and point the imports at it |
| `test/graph.test.ts` | Tests on fixture workspaces in `test/fixtures/`: exports conditions, a barrel and its overload, cycles between packages and folders, a layer violation, Turborepo, Nx, Vite+ and script tasks, replayed commits, and the scorer's reading of the same fixture agreeing with this tool's. `node --test graph.test.ts` from `test/` |
