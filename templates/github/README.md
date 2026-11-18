# GitHub Actions templates

Workflows and composite actions that show the CI anatomy in [the guide, section 3](../../docs/pages/03-workflow-anatomy.md): **plan → jobs → result**, for GitHub Actions, with Blacksmith runner labels as the default. The plan recommends Blacksmith on GitHub-hosted or self-hosted runners, and the user decides ([guide section 2](../../docs/pages/02-runners-blacksmith-and-the-cost-of-getting-fast.md)). On runners they keep, swap the labels and the disks as [Runner labels](#runner-labels) and [Without Blacksmith](#without-blacksmith) say; on another CI, translate the workflows and keep the scripts. They're distilled from a production monorepo's CI, keeping the patterns and the comments that explain why, with our product jobs dropped. Reference implementation; adapt to your repo.

They live here, not in `.github/`, so they never run in this repo. Copy what you need into your repo's `.github/workflows/` and `.github/actions/`, then fill in the placeholders.

**Nothing here is copied, enabled or scheduled before the user approves the plan.** The commands and setup steps below are for the approved implementation ([PROMPT, "Before approval"](../../PROMPT.md#before-approval-read-only)).

**Start small.** On GitHub-hosted runners, with no Vite+, Rust or Blacksmith, begin from the [minimal starter](#minimal-starter-github-hosted) and add one overlay at a time. `ci.yml` is the full reference: every overlay wired together.

## Minimal starter (GitHub-hosted)

[`workflows/ci-starter.yml`](workflows/ci-starter.yml) is the smallest workflow that keeps every check you have and adds the one thing the rest builds on: a single required result. No plan job, no selection, no Vite+, Rust, sticky disks or shared actions. Its jobs call your current lint, types, JavaScript and Python test commands as they are, on `ubuntu-latest`, so coverage stays the same; its header lists the placeholders. `CI result` needs every job explicitly, is read-only, and never skips: skipped, cancelled or failed all fail it.

- **Keep every job in `needs`.** The result checks only what it needs. Add a job, add it there.
- **A skipped required check passes on GitHub.** On a draft the result is skipped, and GitHub's required-check setting accepts that. So the merge caller checks for a successful, non-skipped `CI result` on the head it merges ([Setup order](#setup-order), step 3).
- **Keep your existing gates** until this one has run beside them and agreed.

Then add overlays one at a time, each its own approved change with before/after numbers. Each lists what it adds; leave it out and you leave out those pieces:

| Overlay | Adds | Guide |
|---|---|---|
| Planner | The `plan` job, `scripts/affected-checks.ts`, its outputs and the `if:` on every job; the result job then checks the plan's selection, and `SELECTABLE_JOBS`, against its `needs` | 4 |
| Shards | `scripts/shards/`, the `tests` matrix and the cache handoffs; start with [a fixed split](../../scripts/shards/README.md#start-simple-a-fixed-split) | 7 |
| Records and flakes | `scripts/records/`, `scripts/flakes/`, the `report` job. The test retry stays a separate opt-in | 11, 13 |
| Rust | The `rust` job, `actions/rust-toolchain`, the pack's binary steps; pass reuse with `scripts/reuse/` only once its key is verified | 6, 7 |
| Snapshots and proofs | The snapshot-pin guard, `pack`, `proof`, `actions/wait-for-jobs` | 5, 7 |
| Shared actions | `static.yml` and actions pinned by SHA in a shared repo | 3 |
| Setup caches | `actions/dependencies`, `actions/apt-packages`, sticky disks or their Actions-cache mode | 6 |
| Remote task cache | `actions/task-cache` and [`../../cache/remote/`](../../cache/remote/README.md), Vite+ only | 6 |
| Budgets and health | `scripts/budgets/`, `ci-health.yml`, in report-only mode first | 12 |
| Sweeps and automation | `sweep.yml`, `sweep-bisect.yml`, `review-recheck.yml`, `upkeep.yml` | 5, 16 |

## Install layout

Every script a workflow calls ships in this playbook, and each workflow calls it at the path below. Copy each folder to the same path in your repo, or change every call site together. A script these templates call that this playbook doesn't ship is a `<placeholder>` in the tables further down.

| From this playbook | To your repo | Called by |
|---|---|---|
| `templates/github/workflows/*.yml` | `.github/workflows/` | — |
| `templates/github/actions/*/` | `.github/actions/*/` | the workflows, as `./.github/actions/<name>` |
| `templates/plan/affected-checks.ts`, `changed-files.ts` | `scripts/` | `ci.yml` plan. The planner resolves the repo's root as its parent folder, so it must sit directly in `scripts/` |
| `scripts/shards/` | `scripts/shards/` | `ci.yml` plan, tests, test-times, result |
| `scripts/records/` | `scripts/records/` | your test config, as the Vitest reporter (`test-record.ts`) |
| `scripts/flakes/` | `scripts/flakes/` | `ci.yml` result |
| `scripts/sweeps/` | `scripts/sweeps/` | `ci.yml` plan (`snapshot-pins.ts`), `sweep-bisect.yml` |
| `scripts/budgets/` | `scripts/budgets/` | `ci-health.yml`; `sweep-bisect.ts` imports two of its files |
| `scripts/reuse/` | `scripts/reuse/` | `ci.yml` plan (`pass-key.ts`), only once you turn Rust pass reuse on |
| `skills/code-review/` | `<skills-dir>/code-review/`, as [the skills' install](../../skills/README.md#install) lays it out | `ci.yml` result, which runs `<review-checker>` (that copy's `scripts/review-record.ts`) from the repo root of a base-branch checkout |
| `scripts/budgets/spend-watcher/ci-budget-alert.yml` | `.github/workflows/` of a **separate alerts repo**, not this one | the spend watcher. See [`scripts/budgets/README.md`](../../scripts/budgets/README.md#3-the-spend-watcher) |

`ci.yml` finds ordinary tests with `ORDINARY_TESTS` (`\.test\.tsx?$`, anywhere, in its `env`), less the own-job files `\.(sandbox|proof)\.test\.tsx?$`. Keep both equal to the planner's `config.testFile` and `ownJob`, `near-tests.ts`' `testFile` and `test-groups.ts`' `ORDINARY` and `LEFT_OUT`, or a file can be planned and never run. Tests in another language or named another way stay in jobs of their own that run on every ready run.

The `*.test.ts` files in those script folders are the scripts' own `node --test` tests, not Vitest files. Leave them out when you copy, or keep them out of `ci.yml` plan's test-file pattern (its `git ls-files … | grep` line): a sweep selects every tracked `*.test.ts`, and Vitest fails each with "No test suite found".

The scripts need Node 24 or later, which runs them without a build. Give them their own module boundary rather than changing your root: a `scripts/package.json` holding `{ "type": "module" }` stops Node's warning as it reparses the `.ts` scripts as ES modules. A root `"type": "module"` would change how your existing `.js` files load.

## What's here

### Workflows

| File | What it does | Guide |
|---|---|---|
| `workflows/ci.yml` | **Runnable after configuration.** The main workflow, every overlay wired in. `ready_for_review` and `merge_group` triggers, draft skip, split concurrency groups, a 2 vCPU plan job with no install whose outputs gate every job, the snapshot-pin guard, static and type-aware lint in parallel, time-split shards with work stealing, 2-vs-8 vCPU runner choice, path-gated covered-only/pack/proof/Rust jobs, Rust's binaries handed to the pack through the cache, concurrent Rust test executables, per-job timeouts, wait-instead-of-needs, one read-only `if: always()` result job (`CI result`) that checks the selection is a well-formed list, its `needs` equal `SELECTABLE_JOBS` (every job the plan can select, both directions), every selected job passed, batch claims and the review record, and a separate `report` job (`CI report`, the only one that writes) that uploads the Rust pass, files flakes, starts a bisect and opens or closes the "CI on main failed" issue. Off until you turn them on, each as its own approved change: the in-process test retry (`vars.CI_TEST_RETRY`) and Rust pass reuse from main (`RUST_PASS_REUSE`). Not in it: container, image, load, replay, staging and macOS jobs, deep property tests and merge promotion ([left out](#left-out-on-purpose)) | 3, 4, 5, 7 |
| `workflows/ci-starter.yml` | **Runnable after configuration.** The [minimal starter](#minimal-starter-github-hosted): your existing checks as parallel jobs on GitHub-hosted runners, with explicit `needs` and a read-only `CI result` that never skips. `ci.yml`'s planner, Rust, snapshots, shared actions, proofs, cache handoffs, budgets and automation are overlays you add one at a time | 3 |
| `workflows/sweep.yml` | **An ordinary-test example.** Starts the daily sweep and three integration-test slots, with a merge fallback for late cron, in serialized controller groups. It runs only what `ci.yml` has: none of the container, replay, deep property or staging checks guide section 5's sweep row lists. Add those before any of them leaves PRs | 5 |
| `workflows/sweep-bisect.yml` | Reruns a failed sweep's jobs first (a pass is a flake), then bisects merges within a monthly allowance | 5 |
| `workflows/ci-health.yml` | Daily budgets, shard balance, slow files, retries and spend projection. Report-only until the repository variable `CI_HEALTH_ISSUES` is `true`; then it keeps one issue | 12 |
| `workflows/review-recheck.yml` | Reruns only the result job when a review record lands after it failed for that alone | 3 |
| `workflows/upkeep.yml` | By-hand dependency upgrade batch: update, check, audit, one draft PR | — |
| `workflows/static.yml` | A reusable static workflow: each command runs even if the one before failed | 3 |

### Composite actions

| Directory | What it does | Guide |
|---|---|---|
| `actions/task-cache` | Points `vp run` at the remote task cache: read token secret, OIDC writes from trusted events only, forks nothing | 6 |
| `actions/wait-for-jobs` | Polls the latest attempt of named jobs, or one step of them, every 5 s; fails at once if one fails | 3, 7 |
| `actions/ci-cache` | Exposes the Actions cache address and token to scripts, for claims and small cross-job records | 7, 13 |
| `actions/dependencies` | A Vite+ and pnpm install from a Blacksmith sticky disk with overlay layers; a warm disk skips linking and toolchain setup. `sticky-disk: 'false'` gives a plain install, and `cache-folder: 'true'` the disk's folder through the Actions cache instead; its header lists the modes. It always sets up Vite+: without Vite+, use your own setup ([Without Blacksmith](#without-blacksmith)) | 2, 6 |
| `actions/rust-toolchain` | Rust toolchain from a sticky disk, with a read timeout and fresh-install fallback. `sticky-disk: 'false'` on other runners, with the `actions/cache` fallback in its header | 6 |
| `actions/apt-packages` | apt packages cached by the exact resolved `.deb` hashes; tries install before `apt-get update` | 6 |

The workflows call these as local composite actions (`./.github/actions/<name>`): that's the bundled form, and it's what you copy. Keeping them, and `static.yml`, in a shared repo pinned by full commit SHA is an optional deployment choice for several repos, updated in a PR of its own.

The cache Worker `actions/task-cache` talks to is in [`../../cache/remote/`](../../cache/remote/README.md). Set its `write-branch` and `branch-writes` inputs to the Worker's policy. Every task-cache call in `ci.yml` passes `write-branch: main` and `branch-writes: 'false'`, the action's default: only pushes to the write branch write, which is the shipped project row (`pull_requests = 0`). `'true'` is the broader opt-in, and the Worker's row must allow it too.

## Switches that start off

Each is its own approved change, turned on after the plan is approved:

- **`vars.CI_TEST_RETRY`** turns on the in-process test retry: each failed test runs once more. It changes what the gate accepts, since a test that fails then passes passes its shard, so it's never part of adding records. Every recovery is filed as a flake (guide section 11).
- **`RUST_PASS_REUSE`**, in the plan step's `env`, stays `'false'` until `scripts/reuse/pass-key.ts` is configured and its key verified ([`../../scripts/reuse/`](../../scripts/reuse/README.md)).
- **`vars.CI_HEALTH_ISSUES`** set to `true` lets `ci-health.yml` open and close its issue. Until then it's report-only.
- **`merge_group`** fires only with a merge queue, and runs the full selection on the queue's commit.
- **`branch-writes: 'true'`** on `actions/task-cache`, with `pull_requests = 1` in the Worker's project row, lets same-repository PRs and runs by hand write the remote cache.

## Scripts the workflows call

Each exists in this playbook at the path in the first column, with the CLI and environment the call site uses.

| Script | Called from | CLI and contract |
|---|---|---|
| `scripts/affected-checks.ts` | `ci.yml` plan | `[--near] <base> [<head>]`. Prints `packages=`, `uncovered=`, `ci_jobs=`, `ci_needs=`. From [`../plan/`](../plan/) |
| `scripts/sweeps/snapshot-pins.ts` | `ci.yml` plan, first step | Env `EVENT`, `HEAVY_FILE`, `TEST_PATHS`. Fails on a `pkg.pr.new` pin unless a run by hand names exactly one file |
| `scripts/shards/test-shards.ts` | `ci.yml` plan, test-times | `<most> <file list> [<times.json>...]` prints `{"shards": {"1": [...]}, "queue": [[...]]}`; `--merge <times.json>...` prints one merged times file. Workers, targets and overheads are constants at its top |
| `scripts/shards/test-lanes.ts` | `ci.yml` tests | `--lanes <n> [--times <file>] [--no-cache] [--verify-hits <n>] -- <files>...`. The queue from env `TEST_CLAIMS`, `TEST_QUEUE`, `TEST_CLAIMS_FILE`, `TEST_CLAIMED`, `CI_CACHE_URL`, `CI_CACHE_TOKEN`. Records with `CI_RECORD=1`. Needs your tests wired as tasks first ([`../../scripts/shards/README.md`](../../scripts/shards/README.md), step 1) |
| `scripts/shards/ci-cache.ts` | `ci.yml` tests, test-times, result | `save <key> <file>` / `restore <dir> <key>...`, env `CI_CACHE_URL`, `CI_CACHE_TOKEN`. Fails when the cache didn't answer, so a reader never mistakes "no answer" for "nothing" |
| `scripts/flakes/flake-issues.ts` | `ci.yml` result | `<folder>`, env `EVENT`, `PR`, `BRANCH`, `SHA`, `SWEEP`. Opens or comments on "Flaky: `<file>` › `<test>`" per recovery (guide section 11) |
| `<review-checker>` | `ci.yml` result, run from the repo root of the base branch's checkout | No arguments; env `PR`, `GH_TOKEN`, `BASE`, and Actions' `GITHUB_REPOSITORY`, `GITHUB_SHA`. Exits 0 when a member's review is on record, as the skill's `references/record.md` defines it; 1 with each `::error::`. Optional: delete the step, its checkout and `review-recheck.yml` if you don't gate on review |
| `scripts/records/test-record.ts` | your test config | The Vitest reporter that writes `TEST_FLAKES_FILE` lines and the `ci-record` lines `test-lanes.ts` and the collectors read |
| `scripts/sweeps/sweep-bisect.ts` | `sweep-bisect.yml` | `<run id>`. Its `checks` name `ci.yml`'s jobs and inputs; keep them in step |
| `scripts/budgets/ci-health.ts` | `ci-health.yml` | `[--times <file>] [--scale <k>] [--report]`; contract in its header |
| `tools/workspace/src/bin.ts` | `ci.yml` static, two optional steps | `package-exports` (the export guard) and, on a pull request, `symbols check HEAD^1 HEAD` (no new exact copy), from [`../../tools/workspace/`](../../tools/workspace/README.md). The static job's checkout is depth 2 for the second. Delete either step if you don't port it |

## Runner labels

The templates use Blacksmith's labels, sized per job. On other runners, start every job on the label it runs on today. On GitHub-hosted runners that's usually the standard `ubuntu-24.04` for all of them: with one eligible size, keep one static label and delete the plan's size output. Ask for a larger runner only after you've compared queue, startup, capacity and priced cost on it, as the [`ci-runners`](../../skills/ci-runners/references/sizing.md) skill says. Set worker counts and shard targets from the runner you have. Check your provider's current runner list: hosted labels and sizes change.

| Template's label | GitHub-hosted, if you've measured a reason to change | Self-hosted or ARC |
|---|---|---|
| `blacksmith-2vcpu-ubuntu-2404` (plan, bookkeeping, small test runs, controllers) | `ubuntu-24.04` (standard runner) | `[self-hosted, linux, x64, <small-label>]` |
| `blacksmith-4vcpu-ubuntu-2404` (static) | A 4-core larger runner, by the name you gave it, such as `ubuntu-24.04-4-cores` | `[self-hosted, linux, x64, <medium-label>]` |
| `blacksmith-8vcpu-ubuntu-2404` (test shards, type-aware lint) | An 8-core larger runner, such as `ubuntu-24.04-8-cores` | `[self-hosted, linux, x64, <large-label>]` |
| `blacksmith-<n>vcpu-ubuntu-2404-arm` | `ubuntu-24.04-arm`, or an arm64 larger runner | `[self-hosted, linux, arm64, <label>]` |
| `blacksmith-6vcpu-macos-<version>` (releases only) | `macos-<version>` | `[self-hosted, macos, arm64]` |

The plan job picks the test runner's size (`test_runner`): change both labels it can output and the job's default, or make it one label. Map any label that doesn't name its size in `ci-budgets.ts`' `otherRunners` and in `ci-time.ts`'s `RUNNERS`, so budgets and cost estimates know its vCPUs. Price it too: in `ci-budgets.ts`' `runnerMinutePrices`, and in `ci-time.ts`'s `PRICES` (label pattern, price per started minute). An unpriced label gets minutes and no money total. A container job you add sets its own runner size.

## Without Blacksmith

- **Labels:** as above.
- **Setup without Vite+:** `actions/dependencies` always sets up Vite+. With plain pnpm and Node, use the steps its header shows instead: `pnpm/action-setup`, `actions/setup-node` with the repo's pinned Node and `cache: pnpm`, then `pnpm install --frozen-lockfile` with your usual lifecycle scripts. For Python, keep your current setup, manager and lockfiles. Time the restore and the install as separate steps before you add any full-install snapshot.
- **Sticky disks:** with Vite+, pass `sticky-disk: 'false'` to `actions/dependencies` and `actions/rust-toolchain`. Each then installs every time. `actions/dependencies`' `cache-folder: 'true'` keeps the same folder in the Actions cache instead, keyed the same way and saved only from main. Measure the restore against a plain install.
- **The Actions cache:** `actions/ci-cache` and the work-stealing claims use the Actions cache's API, which GitHub-hosted runners serve too. Self-hosted runners use GitHub's cache service unless you run your own; check reservations are still atomic before relying on claims.
- **Cost reports:** `ci-health.yml`'s budgets price each job's started minutes by its label (`pricePerMinute` in `ci-budgets.ts`). A Blacksmith label is priced per vCPU-minute. GitHub-hosted runners price per runner SKU per minute, so set each SKU's rate in `runnerMinutePrices`; an unpriced label leaves the projection as raw runner minutes, with no dollar total. Report raw minutes, a list-price projection and actual billed usage as three separate numbers: actual usage and included minutes come from GitHub's billing reports, not from job timings.
- **A spend cap:** start with a GitHub Actions budget and its alerts wherever your billing scope supports them, and record who can change it and what stopping does ([GitHub's budgets](https://docs.github.com/en/billing/how-tos/set-up-budgets)). The spend watcher in [`scripts/budgets/`](../../scripts/budgets/README.md#3-the-spend-watcher) reads Blacksmith's CLI and disables workflows; on other runners it needs a spend reader for your provider, and its own approval.

## Placeholders

| Placeholder | Where | What |
|---|---|---|
| `<server-package>` | `ci.yml` | Your integration-heavy package, e.g. `apps/server`. The same as the planner's `config.near.root` |
| `<rust-crate-dir>` | `ci.yml`, `actions/rust-toolchain` | The Rust crate's folder. Delete the `rust` job and the pack's binary steps if you have none |
| `<binary-path>` | `ci.yml` rust, pack | Each release binary the pack ships, under `target/release/` |
| `<version-files>` | `ci.yml` plan's `BIN_KEY` | Every file that sets the version a binary embeds. The binaries' key holds them; the Rust pass key doesn't |
| `<packed-package>` | `ci.yml` | A package you publish; its packed inputs gate `pack` |
| `<proof-dir>` | `ci.yml` | Your proof's own implementation, which gates `proof` on a PR |
| `<project>` | `ci.yml` tests, `actions/task-cache` | A short name: the claims' key prefix, and the cache Worker's namespace |
| `<build-command>`, `<generated-files-check-command>` | `ci.yml` static | Your build, and the check that generated files are current |
| `<types-command>` | `ci.yml` lint, types | Workspace types. It must write its incremental cache to `node_modules/.cache/types`, which the jobs restore and save: the ported driver in `tools/workspace/` reads `WORKSPACE_TYPES_CACHE`, which the steps set. For another checker, use its own cache setting, or delete the restore and save steps if it keeps no reusable cache |
| `<lint-command>` | `ci.yml` lint | Format and type-aware lint |
| `<test-command>` | `ci.yml` tests | Only for a run by hand that repeats named tests: one plain, uncached run of the paths it's given, with no retry beyond `TEST_RETRY` (e.g. `pnpm exec vitest run`). Every other run uses `scripts/shards/test-lanes.ts` |
| `<pack-command>` | `ci.yml` pack | Packs the packages that need no native binary |
| `<pack-native-command>` | `ci.yml` pack | Packs the package that carries Rust's binaries, after they're on the runner |
| `<publish-snapshot-command>`, `<proof-command>` | `ci.yml` pack, proof | Your snapshot publishing, and the proof on the snapshot |
| `<quick-test-file>` | `scripts/sweeps/sweep-bisect.ts` | One fast test file a bisect runs beside a failed static job |
| `<check-command>` | `upkeep.yml` | The full local check |
| `<worker-host>` | `actions/task-cache` | The cache Worker's host (no scheme), as `../../cache/remote/` sets it |
| `<org>/<shared-actions-repo>`, `<full-commit-sha>` | `static.yml` | Where you keep shared actions and workflows, pinned by full SHA |
| `<monthly-cap>` | `spendCeiling` in `scripts/budgets/ci-budgets.ts`, which `ci-health.yml` projects against | A copy of the cap the user set. The authoritative cap lives where the spend stop reads it ([`scripts/budgets/`](../../scripts/budgets/README.md#placeholders)) |
| `<node-setup>`, `<install-command>`, `<lint-command>`, `<types-command>`, `<js-test-command>`, `<python-version-file>`, `<python-install>`, `<python-test-command>` | `ci-starter.yml`, as its header lists them | The commands your CI runs today, unchanged |
| `<review-checker>` | `ci.yml` result's sparse checkout and `CHECKER` | The repo's copy of `review-record.ts`, from its root, as `.agents/repo/review.md` names it: `<skills-dir>/code-review/scripts/review-record.ts` for the installed skill. Runs on Node 24 |
| `<skills-dir>` | the install layout | The skills folder your harness reads ([`../../docs/harnesses.md`](../../docs/harnesses.md)) |
| `<small-label>`, `<medium-label>`, `<large-label>`, `<label>` | [Runner labels](#runner-labels) | Your self-hosted runners' labels, by size |
| `TASK_CACHE_READ_TOKEN` | jobs calling `actions/task-cache` | The repository secret holding the cache's read token. A generic name; rename it everywhere if you like |
| `WORKSPACE_TYPES_CACHE` | `ci.yml` lint, types | Not a placeholder to fill: the environment name the ported type driver reads for its cache folder. Rename it in both if your checker reads another |

Also adjust: the job list in `plannedJobs` (planner) and `SELECTABLE_JOBS` (`ci.yml`'s `env`, with `result`'s `needs` and the plan's `selected`) to match your jobs, the cron slots in `sweep.yml`, which are illustrative and coupled in four places (the crons, the server cron string in both `if:`s, and `SWEEP_AT` / `SERVER_AT` under `env`): change them together, or keep one cron for one daily suite, the runner labels to your measured sizes, the `timeout-minutes` and budgets to your measurements (p95 + 15%, guide section 12), and `bisectBudget` in `sweep-bisect.ts` (0 starts no bisect).

## Manual inputs and run names

`sweep-bisect.ts`, `flake-issues.ts` and `sweep.yml` find `ci.yml`'s runs by name and dispatch it with its inputs, so these must agree. `ci.yml` declares `ref`, `test_paths`, `repeat`, `sweep`, `server_sweep`, `full`, `pack_only` and `bisect`, and names its runs `CI on main, daily`, `Server tests on main`, `CI by hand on <ref>[, tests under …][, n times][, packing only][, for a bisect]` and `Types on main`. A heavy-file job and its `heavy_file` input aren't in the template: add both before `flake-issues.ts`'s `proofOf` or the bisect's `heavy` check can use them.

Three names identify a job, and the helpers use different ones:

- the **job ID**, the key under `jobs:` (`tests`): what `needs:`, `needs.<id>.result` and the result job's selection use;
- the **display name**, its `name:` as a run's page shows it (`Tests 2/4`, `CI result`): what the jobs API returns, so what `wait-for-jobs`, `sweep-bisect.ts`'s `checks`, `merge-pass.ts`'s `passingJobs`, budgets and the record collectors match;
- the **run name**, the workflow's `run-name`: what the bisect and sweep find runs by.

Rename one and change every reader of that name with it.

A run by hand names two revisions. `--ref` picks the workflow file's revision, and the `ref` input picks the code it checks:

```sh
gh workflow run ci.yml --ref <branch> -f ref=<branch> -f test_paths='<app-dir>/src/queue' -f repeat=20
```

Dispatch from the branch whose workflow you mean: a branch behind main fails on main's newer workflow scripts.

**The snapshot exception's real scope.** `snapshot-pins.ts` lets a snapshot pin through only on a `workflow_dispatch` naming exactly one file, in `heavy_file` or `test_paths`. It can't see whether the branch is a draft's: "on a draft" is workflow policy, which the person dispatching keeps.

A PR that edits a job only main's runs start (the template's `test-times`) selects it and still can't run it, so the plan prints a notice naming the dispatch that does. Add a line there for each such job you add.

## Setup order

Each step is its own approved change. Nothing below runs before the plan is approved.

1. Start on the runners you have, on the labels they use today. On GitHub-hosted or self-hosted runners the plan recommends Blacksmith, backed by the baseline and with the optimization period priced, and the user decides (guide section 2). If they say yes, the move is its own step: install its GitHub app and swap the labels at today's sizes ([migrate](../../skills/blacksmith/references/migrate.md)). Resize only when three runs agree.
2. Set a spend cap and alerts first (guide section 12): a GitHub Actions budget where your billing scope supports one.
3. **Add the new gate beside the old ones.** First record the current rulesets or branch protection, the required check names and the Apps that post them, the allowed merge methods, and whether a merge queue is on. Copy the [minimal starter](#minimal-starter-github-hosted) or `ci.yml` with the planner and the scripts in the install layout, and get the plan job's record line into your logs. Let `CI result` run alongside the existing required checks, and check it on: current ready heads, a draft marked ready, a selected job missing from `needs`, a job in `needs` the plan can't select, a failure, a cancellation, and `merge_group` if you use a merge queue. Then switch the required check to `CI result` in an approved cutover, with the old checks written down as the rollback. GitHub's required-check setting counts a skipped job as passing ([GitHub's required-check behaviour](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)), and `CI result` is skipped on a draft. So the merge caller checks for a successful, non-skipped `CI result` from the ready run on the current head, or on the merge queue's commit.
4. Add `sweep.yml` and the bisect once the sweep is green. Before any check leaves PRs or the release gate trusts the sweep, prove one complete sweep: list every deferred check and the job and success line that shows it ran, and add the jobs this template leaves out (container, replay, deep property, staging) for each check you defer. Schedule a one-off check of the first cron run: a dispatch isn't a pass.
5. **A job only main runs** (a new cron, a sweep-only proof, a cache): before merging, validate its syntax and event logic locally and name the exact job and the behaviour no PR run exercised. For an existing dispatchable workflow, ask approval for its dispatch command, branch, inputs and run budget. A new or main-only job lands so that it can't affect gates, releases or issues until someone reviews its first eligible run, with a named owner, a deadline, and a rollback if it never starts. A dispatch request has no verdict; only the run's result does.
6. Move setup onto sticky disks (`dependencies`, `rust-toolchain`) once the job graph is stable, or onto their `actions/cache` fallback without Blacksmith. Every run must check the lockfile once: `static` and `types` install with `check: true`, and tests, pack and proof pass `check` when neither runs. Count that extra install when you size an isolated run. Keep `prepare: true` when your root's post-install step writes files outside `node_modules` that the jobs need; read your prepare lifecycle before you take the warm-disk shortcut.
7. With Vite+, stand up the remote cache ([`../../cache/remote/`](../../cache/remote/README.md)), then add `actions/task-cache` to each job that runs `vp run`. With another task runner, use its own remote cache (guide section 6).
8. Keep the PR gate read-only. Issue filing and dispatches belong in the `report` job and the controllers, each with its own narrow `permissions:`. Before you turn on writes, run them in report-only mode against known runs, and check that every workflow, job and run name they match ([three names](#manual-inputs-and-run-names)) still finds its runs.

## Release integration checklist

The template has no release workflow; yours gates on main's sweep. Before a PR's coverage is left to the sweep, map each step to **every** shipping path: package publishes, direct container or app deploys, and manually promoted artifacts. A path that doesn't check a passing, complete sweep at the exact commit it ships (or a proven-equivalent input identity) keeps its PR coverage. Define what's fresh enough, and what happens on a missed, failed or stale sweep and on a manual promotion. This list is written for npm packages with native children; for Python, check the wheel and sdist build metadata and resolved build inputs, and install each into a clean environment for a smoke test. Bind a direct deploy to a checked commit or artifact digest. These are [guide section 5](../../docs/pages/05-tiers-what-runs-where.md#releasing-what-the-sweep-checked)'s steps 2 to 7. Its step 1, rejecting unpublished snapshot dependencies, is already `ci.yml` plan's first step (`scripts/sweeps/snapshot-pins.ts`); run it in your release workflow too, before anything below.

1. Run [`scripts/sweeps/release-checked.ts`](../../scripts/sweeps/release-checked.ts) before tagging or publishing anything, and stop when no passing sweep checked the release's exact shipped content.
2. Build the release platforms fresh, from the tagged commit: never a cached binary from another version.
3. Pack each package once, then install each tarball with npm alone, outside the workspace, and run checks against what got installed.
4. Publish optional platform packages before the parent package that depends on them.
5. On a retry, publish only the versions that are still missing, from the same tarballs, and never overwrite a published version.
6. After publication succeeds, advance production to the checked sweep commit `release-checked.ts` returned, as a fast-forward only: check it's an ancestor first.

## Left out on purpose

So `sweep.yml` runs ordinary tests only. Our product jobs (container tests, image pushes, load runs, recorded-session replay, browser checks against staging, the release workflow), macOS jobs (they run only in releases or when asked; a Mac vCPU-minute is several times a Linux x64 one at list price), merge promotion of the Rust pass (sketched as a TODO in the result job), and the deep property-test job (sweep-only, seeded from the run ID; guide section 5).
