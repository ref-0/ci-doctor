[Guide](../README.md)

# 5. Tiers: what runs where

**Applies when:** Checks too slow or costly for every PR could move to merges, `main`'s server runs, or a sweep instead. **Skip when:** No sweep has yet proven it runs every check you want to take off PRs (see [Releasing what the sweep checked](#releasing-what-the-sweep-checked) below).

| Tier | When | What runs |
|---|---|---|
| **PR (ready)** | Each push to a ready PR | Plan; static build and type-aware lint in parallel; tests the diff reaches (normal property-test depth, fixed seed); covered-only heavy files only if their covered paths changed; Rust only if its inputs changed; packaging only if packed inputs changed; review validation |
| **Merge to `main`** | Every merge | **Workspace types only.** Two independently green PRs did break types together, so this cheap check stays. A merge **records a Rust pass from its PR's run** instead of rerunning it (*pass promotion*: reusing the PR's Rust result when merged inputs match what the PR tested, section 6). |
| **Server runs on `main`** | Three slots a day between sweeps (every 6 h with the sweep) | All server test files, heavy ones included, **only if something since the last passing server run reaches the server**. An unchanged slot skips test jobs and pays only for dispatch, plan, and the aggregate result. |
| **Daily sweep** | Once a day, in the quietest merge window | Everything since the **last passing sweep**: every test file, all covered-only proofs, applicable container tests, the *snapshot pack* (packages packed and published as a pre-release with native binaries), end-to-end proofs installing that pack, replays of recorded real sessions, deep property tests (fresh seed per run), staging browser checks, and a sample of cached passes rerun fresh. Note: the shipped [`sweep.yml`](../../templates/github/workflows/sweep.yml) covers ordinary tests only—wire in the rest as jobs before counting on them. |
| **Release** | Batched | Publishes only source checked by a passing sweep, compared **by shipped file content** so a version-only release commit still matches. Builds all platforms fresh and validates installed artifacts. |
| **Production deploy** | After publish | Fast-forwards to **the sweep's checked commit**, not `main`'s tip. Staging follows every merge. |

## Moving heavy tests to the right tier

**Applies when:** Expensive files run on every PR: bounded model checks, large-fixture or long-history/large-dataset tests, wide grids, or full oracle corpora. **Skip when:** No PR test is expensive enough to tie to the specific inputs it proves.

- **Covered-only table.** Map expensive files to the exact inputs they prove (bounded model checks, large fixtures, long-history or large-dataset tests, wide grids, full oracle corpora). A PR runs one only when it touches a covered path—**even when the PR otherwise falls back to selecting everything.** Sweeps always run them.
- **Split before moving.** Keep light regression cases on PRs and move only the scale proof. In one file, 17 light cases stayed on PRs while three scale proofs—representing most of the file's runtime—moved out.
- **Keep moved proofs honest.** A bounded model check or fuzz run in a slower tier is only worth its slot if it stays faithful to the code: actions that correspond to real code, a deliberate break each rule catches, recorded scope and bounds, and generators that reach edge cases. [`skills/proof-tiers/`](../../skills/proof-tiers/) covers this (optional for stacks without model checks or property tests).
- **Never shrink a proof to make it fit.** Change *when* it runs, not its bounds or input size so it proves less.
- **No separate release-only test tier for checks the sweep can run.** Because release already waits on the sweep, a release-only tier would just duplicate work. Release still builds and validates the platform artifacts it publishes.
- **Deep property tests:**
  - On PRs, run at normal depth with a fixed seed so failures reproduce deterministically.
  - In the daily sweep, run deeper (2,000 TS / 1,000 Rust cases) seeded from the run ID so each sweep explores new cases while a rerun repeats the same ones, with the seed logged.
  - Previously, running the deep job on every broad PR made it finish last—after every shard—while repeating cases PRs already covered.
- **End-to-end proofs and session replays** run on PRs only when their own implementation or inputs change. Broad "select everything" fallbacks no longer pull them in: in one sample, 49 of 78 proof-running PRs had triggered solely because of the fallback.

## Cron is not a scheduler you can trust

**Applies when:** GitHub's scheduled runs carry checks such as sweeps or `main`-only jobs. **Skip when:** The repo has no scheduled or `main`-only jobs.

GitHub's scheduled runs frequently arrived **hours late**, and during one period 7 of 9 never started at all.

- **Merge fallback:** The first merge after each scheduled slot checks whether a run has started since that slot and dispatches one if not. Serialized controller concurrency groups prevent duplicates, and slots recognize each other's coverage.
- **Verify the schedule itself:** A dispatch isn't a pass. Schedule a one-off follow-up check at the time of a new job's first run and read its result.
- **Plan `main`-only jobs before merging.** A notice and later check only produce evidence once something actually runs, and a new `workflow_dispatch` workflow can't be dispatched until it lands on the default branch. Before merging:
  - verify syntax and event logic locally, and explicitly name the job and what remains untested;
  - for an existing dispatchable workflow, present the command, ref, inputs, permissions, and run budget for user approval;
  - stage any new or `main`-only job so it cannot affect gates, releases, or issues until its first eligible run is reviewed, and record a deadline, owner, and rollback plan in case it never starts.

## One issue for a red main, and a bisect with a budget

**Applies when:** A sweep on `main` runs checks that PRs skip, so failures must be traced back to a merge. **Skip when:** `main` has no sweep.

- **One issue:** A failed sweep opens or updates a single "main failed" issue listing every merge since the last pass; a passing sweep closes it.
- **Rerun before bisecting:** Failed jobs rerun at the same commit first. If the rerun passes, it's a flake and no bisect starts.
- **Bisect:** A still-failing server run reruns at most four failed files, then halves the merge range in up to six midpoint runs.
- **Record verdicts on the issue:** Confirmed-failing files and completed verdicts are posted to the issue so later slots don't pay to rediscover them.
- **Bounded spend:** The bisect controller charges every probe job against a **monthly vCPU-minute allowance**—cancelled and in-flight jobs included—and refuses new probes if its accounting is incomplete.
- **Skip unrepeatable checks:** Don't bisect non-deterministic checks. A run-seeded property test can only be bisected with the failing run's recorded seed, case count, size, and versions held fixed.

## Releasing what the sweep checked

**Applies when:** Any PR coverage is moving to a sweep, or releases and deploys should ship only what the sweep checked. **Skip when:** PRs keep all their coverage.

The release and deploy tiers above depend on seven steps. Map each to your own release process before deferring any PR coverage to a sweep. [`templates/github/README.md`](../../templates/github/README.md#release-integration-checklist) maps steps 2–7 to scripts; step 1 is the first step of `ci.yml`'s plan job.

Two prerequisites come first:

- **Prove one complete sweep.** Before routing any check off PRs or enabling the release gate, demonstrate one sweep that executed every deferred check, and list each check with evidence of its success. A sweep can report green on an unchanged commit after running only its plan, and the release helper matches a passing sweep by workflow, branch, title, and shipped content—neither confirms which deferred checks were wired in or ran. Your gate must therefore check the sweep's coverage policy or a verified coverage record (including when a sweep inherits an earlier run's result). [`release-checked.ts`](../../scripts/sweeps/release-checked.ts) uses `sweeps.requiredJobs` to list the jobs a release relies on: add each job there before taking its check off PRs. Checks against live systems (staging, external tools) need their own freshness rule.
- **Gate every shipping path.** Keep required coverage on PRs until every path that ships verifies a passing full run at the exact release commit (or a proven-equivalent input identity). Define behavior for missed, failed, or stale sweeps and for manual promotions. Bind direct deploys to a checked commit or artifact digest. A repo that deploys on every merge—or lacks a reliable release gate—must keep its coverage on PRs.

Our seven release steps (for npm packages with optional native children; adapt for other artifacts—for a Python wheel or sdist, verify build metadata, resolved inputs, and a clean-environment install and smoke test; for a container, verify the image digest):

1. **Reject unpublished snapshot dependency URLs** in ordinary PRs, sweeps, and releases, permitting them only in explicitly targeted manual experiments. Run the guard in [`scripts/sweeps/`](../../scripts/sweeps/) right after the plan job checks out.
2. **Run the content-equality guard before tagging or publishing:** shipped files must match what a passing sweep checked.
3. **Build every release platform fresh.**
4. **Pack once, then install each tarball with the plain package manager alone** (`npm` for us) and validate the installed artifacts.
5. **Publish optional platform packages before the parent package** that depends on them.
6. **On retry, publish only still-missing versions** from the same tarballs; never overwrite an already published version.
7. **After publishing, advance production to the sweep's checked commit** using an ancestor or fast-forward check.
