[Guide](../README.md)

# 5. Tiers: what runs where

**Applies when:** Checks too slow or costly for every PR could run on merges, on main's server runs or in a sweep instead. **Skip when:** No sweep has yet been shown to run every check it would take off PRs ("Releasing what the sweep checked", below).

| Tier | When | What |
|---|---|---|
| **PR (ready)** | Each ready push | Plan; static build and type-aware lint in parallel; the tests the diff reaches, at normal property-test depth with a fixed seed; covered-only heavy files only if their covered paths changed; Rust only if its inputs changed; packaging only if packed inputs changed; review validation |
| **Merge to main** | Every merge | **Workspace types only.** Two independently green PRs did break types together, so this cheap check stays. A merge **records a Rust pass from its PR's run** instead of rerunning it (*pass promotion*: the merge reuses the PR run's Rust result when the merged inputs match what that run tested, section 6). |
| **Server runs on main** | Three slots a day between sweeps, every 6 h with the sweep | All server test files, heavy ones included, but **only if something since the last passing server run reaches the server**. An unchanged slot skips the test jobs and pays only for dispatch, plan and the aggregate result. |
| **Daily sweep** | Once a day, at a slot chosen from merge timing (the quietest window) | Everything since the **last passing sweep**: every test file, all covered-only proofs, applicable container tests, the *snapshot pack* (the packages packed and published as a pre-release, with their native binaries), end-to-end proofs that install that pack, replays of recorded real sessions, deep property tests (fresh seed per run), staging browser checks, and a sample of cached passes rerun fresh. The shipped [`sweep.yml`](../../templates/github/workflows/sweep.yml) covers the ordinary tests only; add the rest as jobs before you count on them. |
| **Release** | Batched | Publishes only source that a passing sweep checked, compared **by file content** of what ships, so a version-only release commit still matches. Builds all platforms fresh and validates the installed artifacts. |
| **Production deploy** | After publish | Fast-forwards to **the sweep's checked commit**, not main's tip. Staging follows every merge. |

## Moving heavy tests to the right tier

**Applies when:** Expensive files run on every PR: bounded model checks, large-fixture, long-history or large-dataset tests, wide grids, full oracle corpora. **Skip when:** No PR test is expensive enough to tie to the inputs it proves.

- **Covered-only table.** Expensive files are tied to the inputs they prove: bounded model checks, large-fixture tests, long-history or large-dataset tests, wide grids, full oracle corpora. A PR runs one only if it touches a covered path, **even when the PR otherwise selects everything.** Sweeps always run them.
- **Split before you move.** Keep the light regression cases on PRs and move only the scale proof. In one case 17 light cases stayed and three scale proofs, most of the file's time, moved.
- **Keep a moved proof honest.** A bounded model check or a fuzz run in a slower tier is only worth its slot if it still matches the code: actions that correspond to the code, a deliberate break that each rule catches, a recorded scope and bounds, and generators that reach the edges. [`skills/proof-tiers/`](../../skills/proof-tiers/) covers this; it's optional for stacks that don't use model checks or property tests.
- **Never shrink a proof to make it fit.** The change is *when* it runs, not a smaller input that no longer proves the bound.
- **No separate release-only test tier for checks the sweep can run.** Release already waits for the sweep, so it would only duplicate it. Release still builds and validates the platform artifacts it publishes.
- **Deep property tests:**
  - On a PR, a fixed seed at normal depth reproduces every time.
  - In the daily sweep, deeper runs (2,000 TS / 1,000 Rust cases) are seeded from the run ID, so each sweep explores new cases and a rerun repeats the same ones. The seed is logged.
  - Running the deep job on every broad PR had made it the last job to finish, after every shard, while it repeated cases the PR run already covered.
- **End-to-end proofs and session replays** run on PRs only when their own implementation or inputs change. Broad "select everything" fallbacks no longer drag them in: 49 of 78 proof-running PRs in one sample were there only because of the fallback.

## Cron is not a scheduler you can trust

**Applies when:** GitHub's scheduled runs carry checks, such as sweeps or main-only jobs. **Skip when:** The repo has no scheduled or main-only jobs.

GitHub's scheduled runs arrived **hours late**, and in one period 7 of 9 never started.

- **Merge fallback:** the first merge after each slot checks whether a run has started since that slot, and dispatches one if not. Serialized controller groups prevent duplicates, and slots recognize each other's coverage.
- **Check the schedule itself:** a dispatch isn't a pass. Schedule a one-off check at the time of a new job's first run, and read its result.
- **Main-only jobs need a plan before merge.** A notice and a later read are evidence only after something runs, and a new `workflow_dispatch` workflow can be dispatched only once it's on the default branch. Before merging, check its syntax and event logic locally and name the exact job and what stays untested. For an existing dispatchable workflow, give the command, ref, inputs, permissions and run budget for the user's approval. Stage a new or truly main-only job so it can't affect gates, releases or issues until its first eligible run is reviewed, and record a deadline, an owner and a rollback in case it never starts.

## One issue for a red main, and a bisect with a budget

**Applies when:** A sweep on main runs checks that PRs skip, so a failure has to be traced to a merge. **Skip when:** Main has no sweep.

- **One issue:** a failed sweep opens or updates a single "main failed" issue listing the merges since the last pass. A passing sweep closes it.
- **Rerun before bisecting:** failed jobs rerun at the same commit first. Passing on rerun means a flake, so no bisect starts.
- **Bisect:** a still-failing server run reruns at most four failed files, then halves the merge range, up to six midpoint runs.
- **Recorded verdicts:** confirmed-failing files and finished verdicts go on the issue, so later slots don't pay to rediscover them.
- **Bounded spend:** the bisect controller counts every probe job against a **monthly vCPU-minute allowance**, cancelled and in-flight jobs included, and refuses new probes if its accounting is incomplete.
- **What it won't bisect:** checks that can't be repeated. A run-seeded property test can be bisected only with the failing run's recorded seed, case count, size and versions held fixed.

## Releasing what the sweep checked

**Applies when:** Any PR coverage would move to a sweep, or a release or deploy should ship only what the sweep checked. **Skip when:** PRs keep all their coverage.

The release and deploy rows above rest on a few steps. Map each one to your own release mechanism before you defer any PR coverage to a sweep. [`templates/github/README.md`](../../templates/github/README.md#release-integration-checklist) maps steps 2 to 7 to the scripts; step 1 is `ci.yml` plan's first step.

Two conditions come first:

- **One complete sweep, proven.** Before you route any check off PRs or turn on the release gate, show one sweep that ran every deferred check, and list each deferred check with the evidence of its success. A sweep can report success on an unchanged commit after running only its plan, and the release helper matches a passing sweep by workflow, branch, title and shipped content. Neither tells you which deferred checks were wired in or ran, so the gate must match the sweep's coverage policy, or a verified coverage record for it, including when a sweep inherits an earlier run's result. [`release-checked.ts`](../../scripts/sweeps/release-checked.ts)' `sweeps.requiredJobs` names the jobs a release counts on: add each before its check leaves PRs. Checks against live systems (staging, external tools) need their own freshness rule.
- **Every shipping path waits.** Leave required coverage on PRs until every path that ships checks a successful full run at the exact release commit, or at a proven-equivalent input identity. Define what happens on a missed, failed or stale sweep, and on a manual promotion. A direct deploy binds to a checked commit or artifact digest. A repo whose deploys follow every merge, or that has no usable release gate, keeps PR coverage.

The steps below are ours, for npm packages with optional native children. Other artifacts need their own: for a Python wheel or sdist, the build metadata, the resolved build inputs and an install and smoke test in a clean environment; for a container, the image digest.

1. **Reject unpublished snapshot dependency URLs** in ordinary PRs, sweeps and releases. Permit them only in explicitly targeted manual experiments. [`scripts/sweeps/`](../../scripts/sweeps/) has the guard; run it right after the plan checks out.
2. **Run the content-equality guard before tagging or publishing:** the shipped files must match what a passing sweep checked.
3. **Build every release platform fresh.**
4. **Pack once, then install each tarball with the plain package manager alone** (npm, for us) and validate the installed artifacts.
5. **Publish optional platform packages before the parent package** that depends on them.
6. **On a retry, publish only the versions still missing,** from the same tarballs. Never overwrite a published version.
7. **After publishing, advance production to the sweep's checked commit,** with an ancestor or fast-forward check.
