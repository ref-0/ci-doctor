[Guide](../README.md)

# 4. Run only what a change can reach

## Drafts and concurrency

- The workflow listens for `opened`, `synchronize`, `reopened` and `ready_for_review`. Every job skips while the PR is a draft, so marking it ready starts its first real run.
- Concurrency groups keep ready PRs, drafts, reruns, manual runs and merge commits apart, so a draft event or an old rerun can't cancel the newest head's useful run. Manual groups include their inputs.
- A running sweep finishes; it isn't cancelled. GitHub keeps one waiting run per concurrency group, so a newer one can replace a waiting one. That's fine for us, because the next sweep plans from the last *passing* commit. If every dispatch must run, add a separate queue policy and state its limit ([GitHub's concurrency rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)).
- A skipped check is never a pass for us, though GitHub's required checks treat one as passing (section 3). Merge only on the current head's non-skipped aggregate result.

## A selector built from a real dependency graph

A plan job on 2 vCPU decides what a diff reaches in seconds, with **no workspace install**: it uses Node built-ins, plus one integrity-checked YAML parser for workflow diffs. It knows a pnpm workspace's TypeScript tests (`.test.ts`, `.test.tsx`). Tests in other languages, or named another way, aren't in its inventory, so keep their existing jobs running in full until a selector maps them.

- **What it reads:** committed trees, package manifests, workspace membership, imports, source references, lockfile install changes, build-command text and config paths. It follows transitive consumers and handles cycles, and the deepest containing package owns a file.
- **Docs, agent guidance and ignore files** reach no tests. They still get static checks and lint.
- **Test-only edits** select the tests that run them. A helper used only by tests selects its readers, not every production consumer.
- **Package entry points.** For shared libraries, it follows which public entry exports the changed module and selects consumers of that entry. In one example, a library edit went from 520 selected files to 120, checked against an independently parsed import graph.
- **Selection and reuse are separate decisions.** Adopting a standard task runner or cache doesn't justify replacing semantic test selection with its package graph. When we tried that, a manifest-only replacement missed tests in 74 of 100 replayed PRs. Replay a proposed replacement against historical diffs and the explicit disk, generated-code, bundle and config edges. Keep the existing selector until the replacement shows it preserves the coverage you need.
- **Root scripts** are classified by their callers:
  - used only by tests: select those tests;
  - used by one CI step: select that job;
  - used by production code: act like a change to that package;
  - control selection or execution: select everything.
  Unknown scripts fail toward everything.
- **Lockfile changes** select packages whose resolved installs changed, then their consumers. Root dependencies, the package manager and global settings select everything. Gotcha: pnpm hoisting can hide undeclared edges.
- **Unknown code, removed packages, test orchestration and shared config** select everything. That's the conservative default.

## Turborepo and Nx: their own affected runs first

A repo on Turborepo or Nx already has package-level selection built in: `turbo run <task> --affected` and `nx affected -t <task>`. When the repo selects nothing today, turn that on before writing a selector. Both compare against a base commit, so check that CI fetches enough history to reach it and passes the right base for a PR (check the installed version's docs: the flags and defaults have changed between releases).

- **It's package-level.** A change selects every task of its package and of the packages depending on it, through the tool's own graph. Edges that graph can't see still need declaring: root config, files read from disk across packages, generated code. Unknown inputs should select everything, as above.
- **Verify it like a selector:** replay recent PRs and compare what it ran against what they needed ([below](#verify-the-selector-like-production-code)).
- **Don't replace a finer selector with it.** Where the repo already selects by test file, keep that: a package graph replacing semantic selection missed tests in 74 of 100 replayed PRs (above). Our planner in [`templates/plan/`](../../templates/plan/README.md) reads pnpm workspaces only, so in a Turborepo or Nx repo it's for a later pilot, not a first step.

## "Near" selection for an integration-heavy server

Every server integration test boots the whole Worker, so the import graph says *everything reaches everything*. A plain changed-files traversal picked 494 of 1,035 files for one model edit. The selector instead combines:

- tests the change edited;
- tests importing a changed module, or a production module that runs it, walking upward but **stopping at modules with more than 20 importers**;
- tests named for the changed modules;
- **explicit coverage declarations** for tests that read source text, migrations, Dockerfiles or fixtures from disk, or that execute generated bundles. Imports can't express these. A green run once missed both intended outage tests until a bundle-consumer edge was added.

This is a deliberate risk trade: "near" can't prove that no whole-Worker side effect reaches another test. **Main's sweeps are the safety net.** When we found the near rule too narrow, we widened it and accepted 64% more test-seconds on a replay of 84 changes, because some of the earlier "savings" had been missed coverage.

## CI file changes run only the jobs they touch

For workflow and composite-action edits, the plan **parses both revisions as YAML** and compares meaningful blocks, so comments and formatting don't count.

- **Downstream jobs:** a changed job selects itself plus everything that waits on it, through `needs` or the custom wait action. Changed actions select their callers.
- **Fallback:** plan, result, top-level or unparseable changes select everything.
- **Example:** a comment-only workflow edit runs only the static job, lint and the CI-budget test.
- **YAML parser:** the plan fetches the parser version pinned in the lockfile and verifies its integrity first, still without a workspace install.

## Other narrowing

- **Real-container tests** are selected shallowly. A PR runs a container file only when it's edited directly, or when its own runtime imports, dynamic imports or file URLs reference an edited input. Type-only imports don't count, and there's no recursive expansion through workspace packages. Bundled or config-driven inputs get explicit coverage declarations, and the sweep uses the broader reach of the whole accumulated diff. This rule belongs in the planner ([`templates/plan/`](../../templates/plan/README.md#container-test-reach)).
- **Packaging** runs only when a PR changes what gets packed: manifests, exports, packed docs, packaging config or relevant lockfile entries. Ordinary source edits skip snapshots and native binaries. The exceptions are an all-tests fallback and proof or replay jobs that need a snapshot.
- **The Rust service** builds and tests on a PR only when its real inputs change, or when a broad fallback selects everything. The sweep also refreshes an aging pass with no input change. Contract source alone doesn't trigger it, unless generated Rust types or shared vectors change. Package edges had exaggerated the dependency: of 232 merges reaching native code through package edges, only 151 touched its real inputs.
- **Staging browser checks** never run on PRs. They test what's *deployed*, not the patch, so they belong in sweeps.
- **macOS** never runs on ordinary PRs. It runs only in releases or when explicitly asked for. At Blacksmith's list price when we checked, a Mac vCPU-minute was ~6.7× Linux x64.
- **Manual runs** take an exact ref, test paths, one sandbox file, a name filter and a repeat count. An empty selection fails instead of passing quietly. The snapshot-pin guard (section 5) lets a snapshot through only on a manual dispatch naming exactly one file, in `heavy_file` or `test_paths`; that the branch is a draft is workflow policy, which the guard can't see.

## Verify the selector like production code

Selector tests build small Git histories and check real output, covering:

- comments, matrices and nested action callers;
- cycles, package exports, glob imports and test-only consumers;
- moves and deletions;
- root scripts, lockfile routing, near selection and coverage-only proofs.

Replay proposed selector changes over historical diffs before shipping them, and label reconstructed bases as reconstructions.

Check that the selector would catch real failures with the [past-regression procedure](../../skills/ci-doctor/references/ci-workflows/references/selection.md#replay-past-regressions).
