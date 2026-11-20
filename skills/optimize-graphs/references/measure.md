<!--
What: how to measure a workspace's graphs, read the result, and verify a change to one by replay.
Where: read by a coding agent before it proposes a change to a graph, and after it makes one.
Configure: nothing; the graph tool takes its options on the command line.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Measure

Part of the [`optimize-graphs`](../SKILL.md) skill. Count before you move code, and replay before you call a change a saving.

## The graph tool

[`scripts/graph/`](https://github.com/ref-0/ci-doctor/blob/v0.2.0/scripts/graph/README.md) reads a JavaScript or TypeScript workspace's committed trees with `git ls-tree` and `git cat-file`, never its working tree, so nothing in the repo runs. It needs Node 24 and `git`, and the repo's history as deep as the replay: a shallow clone needs `--depth` past `--commits`.

```sh
node <ci-doctor>/scripts/graph/graph.ts --repo <path-to-repo> --commits 0     # the shape only
node <ci-doctor>/scripts/graph/graph.ts --repo <path-to-repo>                 # the default branch, the last 200 commits
node <ci-doctor>/scripts/graph/graph.ts --repo <path-to-repo> --json > graph.json
```

- `--rev <ref>` measures another branch; `--tests <regex>` says what a test file's path looks like; `--conditions <a,b>` prefers `exports` conditions, such as the repo's source condition; `--layers <file.json>` checks declared layers instead of proposing them. [Its README](https://github.com/ref-0/ci-doctor/blob/v0.2.0/scripts/graph/README.md#run-it) has every option, and [its JSON](https://github.com/ref-0/ci-doctor/blob/v0.2.0/scripts/graph/README.md#json) every field.
- `<ci-doctor>` is a ci-doctor checkout, outside the user's repo. From a skills-only install, clone it at the release tag, as the [skill says](../SKILL.md#1-measure).
- On a 206-package workspace of 2,666 files, the shape and a 200-commit replay took 23 seconds on one core.

It reads what the code draws today, declared or not. It doesn't enforce: `package-graph` holds a declared graph in CI ([fixes](fixes.md#adopt-the-checks)).

## Read the headline

The readable report starts with one line per graph:

```text
Workspace: pnpm, 206 packages, 2,666 files in the import graph (308 tests), main at <sha>
Unresolved: 61 of 8,041 (0.8%) specifiers: 57 missing, 4 computed
1 Packages: depth 5, 0 cycles, 2 undeclared imports; a commit reaches p50 77%, p90 100% of the 203 packages with files
2 Exports: 64 entries, 7 overloaded (top <pkg>#.: 38 modules × 40 packages); a commit reaches tests p50 24%, p90 100% (package-level selection: p50 32%, p90 100%)
3 Layers: 192 sources with folders, 4 folder cycles, no layers declared
4 Tasks: 1241 tasks (670 cached; nx), depth 6, 0 cached with no declared inputs, 7 with inputs over 50% of the repo; a commit touches p50 6.2%, p90 99% of cached tasks' inputs
Replay: 200 of 200 commits asked on main; 79 of 200 (40%) reach everything; widest triggers: pnpm-lock.yaml (67), package.json (4), …
```

- **Unresolved first.** Over a few percent of specifiers unresolved, the shares below undercount: fix `--conditions` or the test pattern before reading on.
- **Files against packages, at p50.** Selecting by files would run 24% of the tests where package edges run 32%. The gap is what entries and file selection buy; no gap, and splitting barrels buys little selection.
- **p90 at 100%, and the share that reaches everything.** Look at the widest triggers before the graph: a lockfile or root config behind most of them is a selection rule to narrow, not a graph to split.
- **Overloaded entries,** each with the commits whose reach went through it: the most-used is the first barrel to split.
- **Cycles:** a package or folder cycle makes a selector that climbs importers reach everything in it.
- **Tasks:** `no-inputs` and `wide-inputs` flags are keys that move on unrelated edits.

Quote every share with its denominator, from the text or the `…Of` and `of` fields in JSON. Label it the graph's reach, replayed, not what CI ran.

## By hand

For another language, or to check the tool:

| Graph | Count | From |
|---|---|---|
| Package dependencies | Edges; imports no edge allows; edges no import uses | `package-graph` and `package-graph --unused`, or the language's own dependency listing (`cargo metadata`, `go list -deps`) |
| Export paths | Test files one edit selects, by package edges, by entries and by the import graph, for a few modules per shared package; names an entry exports that nothing imports | The selector's output, and `vitest list --filesOnly --changed` with one line added to the module; from outside, the scorer's `graphs.exports` gives each entry's re-exports and importers |
| Layers | Imports against the layers, and folder cycles, largest first | `package-graph` with `layers` set, or the order search in [fixes](fixes.md#3-layers) |
| Workspace tasks | Keys one edit moves | The runner's dry run; from outside, the scorer's `graphs.tasks` gives each task's inputs and the files they cover |
| CI jobs | Blocked and queued time, and the critical path | The jobs API, or the scorer's "Job graph" block |

`vitest list` runs the repo's config, so it isn't read-only: ask before you run it.

## Verify a change

1. **Before you change anything,** run the replay at the base commit and keep its JSON. Name the modules you'll measure, a few per package touched.
2. **After,** run it at the change's head over the same commits (`--rev <branch>`, the same `--commits`, `--tests` and `--conditions`). Compare `replay.p50` and `p90` per graph, and `perCommit[].reached.tests` commit by commit, not only the medians.
3. **Check the selector against the real import graph** for the named modules: it must pick every test file an independent listing reaches. One package's edges were caught picking 520 test files, 179 of them in one consumer whose import graph reached 11.
4. **Report the change as replayed,** with its denominator, beside what it cost in files touched.

The bundle is the wrong measure: a bundler already drops unused modules. The gain is in selection, cache keys and what a dev server, a type check and a test file load.
