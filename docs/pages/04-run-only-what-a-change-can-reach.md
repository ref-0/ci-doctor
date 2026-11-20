[Guide](../README.md)

# 4. Run only what a change can reach

## Drafts and concurrency

**Applies when:** PR workflows run on drafts, or a draft event or old rerun can cancel the newest head's run. **Skip when:** Every job already skips drafts and concurrency groups keep ready PRs, drafts, reruns, manual runs, and merges isolated.

- **Skip drafts, run on ready.** The workflow listens for `opened`, `synchronize`, `reopened`, and `ready_for_review`. Every job skips while the PR is a draft, so marking it ready triggers its first real run.
- **Isolate concurrency groups by event.** Separate concurrency groups keep ready PRs, drafts, reruns, manual runs, and merge commits from cancelling each other, ensuring a draft event or stale rerun never interrupts the latest head's run. Manual run groups include their dispatch inputs.
- **Let running sweeps finish.** An active sweep is never cancelled. GitHub keeps at most one pending run per concurrency group, so a newer trigger may replace a waiting sweep—that's fine for us because the next sweep always plans from the last *passing* commit. If every dispatch must execute, add an explicit queue policy and document its limit ([GitHub's concurrency rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)).
- **Never treat a skipped check as a pass.** Even though GitHub's required checks accept a skipped job as passing (section 3), merge only on a non-skipped aggregate result for the current head.

## A selector built from a real dependency graph

**Applies when:** A pnpm workspace's TypeScript tests (`.test.ts` or `.test.tsx`) run in full on every PR. **Skip when:** Tests are in other languages or named differently (keep their jobs running in full until a selector maps them), or the repo uses Turborepo or Nx (start with its built-in affected run first).

A 2-vCPU plan job determines what a diff can reach in seconds, with **no workspace install**: it uses only Node built-ins plus one integrity-checked YAML parser for workflow diffs. It inventories a pnpm workspace's TypeScript tests (`.test.ts`, `.test.tsx`). Tests in other languages or under other naming conventions aren't in its inventory, so keep their existing jobs running in full until a selector covers them.

- **What it reads:** Committed trees, package manifests, workspace membership, imports, source references, lockfile install changes, build-command text, and config paths. It follows transitive consumers, handles cycles, and assigns each file to its deepest containing package.
- **Docs, agent guidance, and ignore files** reach no tests; they still run static checks and lint.
- **Test-only edits** select only the tests that execute them. A helper used strictly by tests selects its test readers, not production consumers.
- **Package entry points.** For shared libraries, the selector traces which public entry exports a changed module and selects only consumers of that entry. In one example, a library edit dropped from 520 selected files to 120, verified against an independently parsed import graph.
- **Selection and reuse are separate decisions.** Adopting a standard task runner or remote cache doesn't justify replacing semantic test selection with its package graph. When we tested a manifest-only replacement, it missed tests in 74 of 100 replayed PRs. Replay any proposed replacement against historical diffs—including explicit disk, generated-code, bundle, and config edges—and keep the existing selector until the replacement proves it preserves required coverage.
- **Root scripts** are classified by their callers:
  - used only by tests → select those tests;
  - used by one CI step → select that job;
  - used by production code → treat as a change to that package;
  - control selection or execution → select everything.
  Unknown scripts fail safe and select everything.
- **Lockfile changes** select packages whose resolved installs changed, plus their consumers. Root dependencies, package-manager changes, and global settings select everything. *Gotcha:* pnpm hoisting can hide undeclared dependency edges.
- **Conservative fallback:** Unknown code, removed packages, test orchestration, and shared config select everything.

## Turborepo and Nx: their own affected runs first

**Applies when:** The repo uses Turborepo or Nx and does no selection today. **Skip when:** The repo uses neither.

Turborepo and Nx already ship package-level selection (`turbo run <task> --affected` and `nx affected -t <task>`). If your repo currently runs everything on every PR, turn that on before building a custom selector. Both tools diff against a base commit, so confirm CI fetches enough git history to reach it and passes the right PR base—check your installed version's docs, as flags and defaults change across releases.

- **Package-level reach.** A change selects every task in its package and in dependent packages according to the tool's graph. Declare edges the graph can't infer: root config, files read from disk across packages, and generated code. Unknown inputs should still select everything.
- **Verify it like any selector:** replay recent PRs and compare what it ran against what they needed ([below](#verify-the-selector-like-production-code)).
- **Don't downgrade a finer selector.** If the repo already selects by test file, keep it—replacing semantic selection with a package graph missed tests in 74 of 100 replayed PRs (above). Our planner in [`templates/plan/`](../../templates/plan/README.md) targets pnpm workspaces only, so in a Turborepo or Nx repo treat it as a later pilot rather than a first step.

## "Near" selection for an integration-heavy server

**Applies when:** Every integration test boots the whole server, making the import graph say everything reaches everything, and `main`'s sweeps run the full suite as a safety net. **Skip when:** The import graph already narrows selection, or no sweep on `main` covers what "near" leaves out.

Because every server integration test boots the whole Worker, a plain import-graph traversal says *everything reaches everything*—picking 494 of 1,035 files for a single model edit. Instead, the selector combines four signals:

- tests edited by the change;
- tests importing a changed module (or a production module that calls it), walking upward while **stopping at modules with more than 20 importers**;
- tests named for the changed modules;
- **explicit coverage declarations** for tests that read source text, migrations, Dockerfiles, or fixtures from disk, or that execute generated bundles—edges static imports can't express. A green run once missed both intended outage tests until a bundle-consumer edge was added.

This is a deliberate risk tradeoff: "near" selection cannot prove that no whole-Worker side effect reaches an unselected test. **`main`'s sweeps are the safety net.** When we found the near rule too narrow, we widened it and accepted 64% more test-seconds across a replay of 84 changes, because some of the earlier "savings" had actually been missed coverage.

## CI file changes run only the jobs they touch

**Applies when:** A selector exists and editing a workflow or composite action still triggers every job. **Skip when:** No selector exists yet, or CI edits already run only affected jobs.

For workflow and composite-action edits, the plan **parses both revisions as YAML** and diffs meaningful blocks, ignoring comments and formatting.

- **Downstream jobs:** Editing a job selects that job plus everything waiting on it (via `needs` or the custom wait action). Editing a composite action selects its callers.
- **Fallback:** Changes to the plan job, result job, top-level keys, or unparseable YAML select everything.
- **Example:** A comment-only workflow edit runs only the static job, lint, and the CI-budget test.
- **YAML parser:** The plan fetches the parser version pinned in the lockfile and verifies its integrity first—still without a workspace install.

## Other narrowing

**Applies when:** Real-container tests, packaging, or a Rust service run on every PR regardless of what changed. **Skip when:** None of those run unconditionally on PRs.

- **Real-container tests** use shallow selection. A PR runs a container test file only when it edits the file directly, or when the file's own runtime imports, dynamic imports, or file URLs reference a changed input. Type-only imports don't count, and there is no recursive expansion through workspace packages. Bundled or config-driven inputs get explicit coverage declarations, and sweeps use the broader reach of the accumulated diff. This rule lives in the planner ([`templates/plan/`](../../templates/plan/README.md#container-test-reach)).
- **Packaging** runs only when a PR touches what gets packed: manifests, exports, packed docs, packaging config, or relevant lockfile entries. Ordinary source edits skip snapshots and native binaries, except on an all-tests fallback or when a proof or replay job requires a snapshot.
- **The Rust service** builds and tests on a PR only when its real inputs change or a broad fallback selects everything (the sweep also refreshes an aging pass when inputs haven't changed). Contract source alone doesn't trigger it unless generated Rust types or shared vectors change. Package edges had overstated the dependency: of 232 merges reaching native code via package edges, only 151 touched its real inputs.
- **Staging browser checks** never run on PRs. They test what's *deployed*, not the patch, so they belong in sweeps.
- **macOS** never runs on ordinary PRs—only in releases or when explicitly requested. At Blacksmith's list price when we checked, a Mac vCPU-minute cost ~6.7× Linux x64.
- **Manual runs** accept an exact ref, test paths, a single sandbox file, a name filter, and a repeat count. An empty selection fails rather than passing silently. The snapshot-pin guard (section 5) allows a snapshot only on a manual dispatch naming exactly one file in `heavy_file` or `test_paths`; requiring that the branch be a draft is workflow policy, which the guard itself can't observe.

## Verify the selector like production code

**Applies when:** A selector, or any change to one, is proposed. **Skip when:** Selection isn't changing.

Selector tests construct small Git histories and verify real output across:

- comments, matrices, and nested action callers;
- cycles, package exports, glob imports, and test-only consumers;
- file moves and deletions;
- root scripts, lockfile routing, near selection, and coverage-only proofs.

Replay proposed selector changes over historical diffs before shipping, and label any reconstructed bases as reconstructions.

Confirm the selector would have caught real past failures using the [past-regression procedure](../../skills/ci-doctor/references/ci-workflows/references/selection.md#replay-past-regressions).
