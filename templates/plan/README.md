# Selection planner

The script CI's plan job runs to decide what a diff can reach, in seconds, on 2 vCPU, with **no workspace install**. It needs only Node 24's built-ins, and can load one integrity-checked YAML parser for workflow diffs: the plan job fetches the `yaml` version the lockfile pins and checks it against the lockfile's integrity. Without it, a CI-file change selects everything. Why each rule exists: [the guide, section 4](../../docs/pages/04-run-only-what-a-change-can-reach.md) and [section 5](../../docs/pages/05-tiers-what-runs-where.md).

Reference implementation from a production monorepo; adapt to your repo. It assumes a pnpm workspace of TypeScript packages. For another stack keep the decision rules and swap the readers (manifests, lockfile, imports).

**What it can't see.** It discovers ordinary tests by `config.testFile` (default `/\.test\.tsx?$/`) inside the workspace's packages. Keep it equal to `ci.yml`'s `ORDINARY_TESTS`, `near-tests.ts`' `testFile` and `test-groups.ts`' `ORDINARY`. Python tests, a root integration suite, or tests in another language aren't in its inventory. A `.spec.ts` suite needs the pattern widened in all three places `testFile`'s comment names. So in a first integration:

- keep every suite it can't see (pytest, Go, a root suite) in a job that runs on every ready run, with its own discovery;
- send unknown inputs and unsupported discovery to every existing suite, falling back to the full gate;
- before narrowing anything, compare the selected **and executed** inventories per suite on replayed past diffs, including adding, deleting and renaming a test and a shared config edit.

To select Python later, map its projects and dependents, `pyproject.toml`, lockfiles, `conftest.py`, plugins and fixtures, source, generated and schema edges, and any test that runs another language's code as a subprocess. That's a separate approved pilot.

## What's here

| File | What it does | Where it runs |
|---|---|---|
| `affected-checks.ts` | The planner. Prints `packages=`, `uncovered=`, `ci_jobs=`, `ci_needs=`, `own_jobs=` and [`test_selection=`](#selection-reasons) | CI's plan job; locally to preview |
| `affected-checks.test.ts` | Tests against toy Git histories: docs-only, dependents, test-only edits, fallbacks, root scripts, near selection and its fan-in cutoff, coverage declarations, covered-only, own-job reach, CI YAML diff, and the Git processes a run starts | `node --test`; locally or CI. Set `PLAN_YAML` to a `yaml` package's `dist/index.js` for the CI-file case |
| `changed-files.ts` | Files changed since the branch left the default branch, committed or not | A local "tests near my change" command |

Copy `affected-checks.ts` and `changed-files.ts` into your repo's `scripts/`, directly: the planner takes its parent folder as the repo's root. Fill in the `config` block at the top. The workflow template `../github/workflows/ci.yml` calls it as `node scripts/affected-checks.ts --near HEAD^1 HEAD` on a pull request's merge commit, and without `--near` from the last passing sweep. `runScripts` and `stepTools` already name the playbook's script folders at the paths that workflow calls them by (`scripts/shards/`, `scripts/records/`, `scripts/sweeps/snapshot-pins.ts`, `scripts/flakes/`); change them with the install layout in [`../github/README.md`](../github/README.md#install-layout).

## The rules, in order

1. **CI files** (`ci.yml`, called workflows, `.github/actions/`), with `--near`: both revisions are parsed as YAML and compared block by block. A changed job runs itself plus everything that waits on it, through `needs` or the `wait-for-jobs` action; a changed action runs its callers. The plan, the result, the top level, an unknown job or an unparseable file select everything.
2. **Root scripts** are classified by their callers: only tests → those tests; one CI step's tool → that job; production code → like an edit to that package; deciding selection or execution (`runScripts`), or named by the root manifest outside its tools → everything. Unknown scripts fail toward everything.
3. **Shared inputs and the checks themselves** → everything.
4. **Docs, agent guidance and ignore files** → no tests. They still get static checks and lint.
5. **Lockfile** → the packages whose resolved installs changed, then their consumers. Root importer, settings, overrides, patches → everything. Catalog-only workspace edits → nothing of their own.
6. **Package edits** → the package and its transitive consumers, from manifests plus names in imports, build commands and config paths. The deepest containing package owns a file. Cycles end at a fixed point.
7. **Test-only edits** (tests, `testing/` helpers no manifest exports) → only the tests that run them.
8. **Entry points** (`entryScoped`): a dependent of a shared library runs only its tests that load an entry exporting a changed module.
9. **Near**, with `--near`, for one integration-heavy package: tests the change edited, tests whose imports reach it climbing upward but **stopping at modules with more than 20 importers**, tests named for the changed modules, and **explicit coverage declarations** (`nearCovers`) for tests that read files from disk or run generated bundles.
10. **Covered-only** (`coveredOnly`), with `--near`: heavy proofs run on a PR only if it touches their covered paths, **even when it otherwise selects everything**.
11. **Own-job files** (`ownJob`: real containers, proofs), printed as `own_jobs=`: see [container-test reach](#container-test-reach).
12. **Anything unknown** → everything.

Before shipping a rule change, replay it over historical diffs and compare the selection (guide section 4, "Verify the selector like production code").

## Selection reasons

`test_selection=` maps selected file paths to one rule per file. It expands whole packages and full runs, applies covered-only exclusions, and includes own-job files. When multiple rules reach the same file, the record shows one that selected it.

| Reason | Rule |
|---|---|
| `edited` | The test itself changed. |
| `imports-changed-module` | An import or file reference reaches the change. |
| `named-for-changed-module` | A near test is named for a changed or reached module. |
| `coverage-declaration` | A configured coverage edge reaches the change. |
| `package-edit`, `dependent-package` | A package changed, or a dependent reached the changed package. |
| `package-entry` | A test reaches a changed package through a narrowed entry point. |
| `lockfile` | A lockfile or workspace change affects the install. |
| `root-script` | A root script reaches tests through its callers or requires the full run. |
| `ci-file` | A CI-file change reaches a workflow test, the test job or the full run. |
| `fallback-everything` | A shared input or unknown path selects the full inventory. |

The workflow writes `test_selection` in its `ci-record` plan for the ordinary files it schedules. It uses `sweep`, `manual` or `workflow-default` when the workflow supplies the scope itself. When you wire up an own-job matrix, add its scheduled files and reasons to the record too. The record collector keeps that field under `plan`.

## Placeholders

| Placeholder | Where | What |
|---|---|---|
| `@<org>/` | `config.scope` | Your workspace packages' name prefix |
| `@<org>/source` | `config.sourceCondition` | The `exports` condition naming source files, or `''` |
| `<server-package>/` | `config.near.root`, examples | The integration-heavy package, e.g. `apps/server/`. `''` turns near off |
| `<test-config>` | `config.shared` | Your shared test config, e.g. `vitest.config.ts` |

Also fill in, from your repo: `packageRoots`, `shared`, `runScripts`, `stepTools`, `manifestTools`, `lintOnly`, `reachesNothing`, `ownJob`, `ownJobCovers`, `entryScoped`, `nearCovers`, `coveredOnly` and `plannedJobs` (the jobs your plan gates, matching `ci.yml`). A folder outside every workspace package, such as a Rust crate `ci.yml` gates by its own path (`<rust-crate-dir>`), is unknown code to the planner, so an edit there selects every test. If no TypeScript test runs what it builds, add it to `reachesNothing`: its own job still runs on its path, and its edits run no TypeScript tests.

The `TODO` comments mark where our repo had specifics: other package managers' lockfiles, and outputs for path-gated jobs such as `pack=` and `rust=`.

## Left out of the reference

- Our repo's coverage tables, contract-vector and bundle-consumer rules: write yours as `nearCovers` and `coveredOnly` entries.
- The local mode (`--local`) that picks tests near the working tree for a pre-push command: build it from `changed-files.ts` and the same rules if you want one (guide section 14).

## Container-test reach

A file that boots a real container (or a proof on a packed artifact) costs minutes, so it doesn't follow the ordinary tests' package-wide reach. `own_jobs=` lists the `ownJob` files a change reaches:

- **On a pull request** (`--near`): a file runs when the change edits it, when one of **its own** runtime imports, dynamic imports or `new URL('…', import.meta.url)` file references names an edited file or folder, or when `ownJobCovers` says it covers an edited path. Type-only imports don't count. Neither does reach through other modules or workspace packages: one shared module's edit would otherwise select every container file. A PR that selects everything still runs only the files reached this way.
- **Bundled or config-driven inputs** (a bundle the file starts, a Dockerfile, a config a harness reads): declare them in `ownJobCovers`, as `nearCovers` does for ordinary tests.
- **On the sweep** (no `--near`), the accumulated diff reaches further: every own-job file in a reached package runs too, and all of them (`null`) when everything is selected.

Feed `own_jobs` to your container job's matrix, packed by [`container-pack.ts`](../../skills/ci-runners/scripts/container-pack.ts), the `ci-runners` skill's, copied to `scripts/shards/`. The template `ci.yml` has no container job; add one with its output.

A PR that edits a job only main's runs start (the template's `test-times`) selects it through `ci_jobs`, and the job still can't run on the PR. `ci.yml`'s plan prints a notice with the dispatch that runs it; add a line there for each such job you add.
