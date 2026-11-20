<!--
What: the facts about one repo's CI that the shared skills read: its entry points, selection, tiers, runners, caches, runs by hand, flakes and merges.
Where: copy to `.agents/repo/ci.md` in your repo. The ci-doctor hub's topics and the ci-merge-workflow skill point here.
Configure: replace every <placeholder>. The commented "Example" blocks are the source repo's values; delete them once yours are in.
Reference implementation from a production monorepo; adapt to your repo.
-->

# <repo>'s CI

What the shared skills read about this repo's CI. Each workflow's header says how it works; the skills hold the procedures. Keep this page to facts and pointers: a value that lives in code is named here by its file, not copied. When this page and the code disagree, the code is right; fix the page in the same change.

## Entry points and gate

- `<workflow-file>` runs on pull requests to `<target-branches>` `<that aren't drafts / on every push>`. `<If drafts run no CI: marking one ready starts its one run.>`
- Stacked pull requests: `<whether a PR to a non-main base runs CI, and whether it waits as a draft until its parent merges>`.
- Its `<gate-job>` job (the job ID; its display name is `<gate-name>`) is the gate: it must pass at the pull request's current head. Required checks: `<names>`; a required check that was skipped `<counts as passed here / fails the gate>`.
- Merging: `<merge method: squash / merge / rebase>`, `<approvals required>`, `<merge queue: none / its name, and what it reruns>`.
- `<what else the gate reads, such as a review record in the PR body>`.

<!-- Example:
- `ci.yml` runs on every pull request to `main` that isn't a draft; each push after marking it ready runs again.
- Its `CI result` job is the gate. It also reads the review record, a `No review:` line in the body or a review
  comment, as the review-gate skill's `scripts/review-record.ts` parses it.
- Each container test job's summary, on the run's page, has its Vitest totals and every failing test.
-->

## Selection and tiers

- A pull request runs what its diff reaches, as `<selector-script>` lists it. `<covered-only list>` there names what only a change to its inputs runs.
- A path the selector doesn't recognise runs `<everything / the fallback set>`. Sentinel cases that must select everything, with the test that checks it: `<the workflow folder, the selector itself, the lockfile, …>`.
- Jobs by ID, which the selector and gate key on, not by display name: `<job-id>: <display name>`.
- `<sweep-workflow>`, main's scheduled sweep, runs everything at `<sweep-time>` and fills the cache.
- A release waits for `<what a release waits for>`.

### What a change selects

- `<kind of change>`: `<what it runs>`.

<!-- Example:
- Docs, `.agents/**` and `.gitignore` reach no package. The static job still runs.
- A package's source runs its own tests and its dependents' near the change; the server's tests run only those
  near the change, by the selector's named edges.
- A lockfile change routes by the packages whose resolved versions changed, not to everything.
- A change to `.github/`, the selector or the shard script runs everything.
- The daily sweep runs once a day, off the hour; main's server tests also run every 6 hours between sweeps.
-->

### Real-container files

Fill each row, or write "not applicable" with why. A real-container or covered-only file may be selected by inputs no import shows.

| File | Boundary it checks | Hidden inputs that select it (bundles, disks, images, config) | Run it by hand |
| --- | --- | --- | --- |
| `<file>` | `<what real system it proves>` | `<paths>` | `<dispatch command naming the file>` |

### Checks tied to the tested base

Checks a PR's run made against its base as it was when the run started, or "none". When the base moves, the ci-merge-workflow skill's decision table (does this run count) says whether to recheck or run again:

- `<check>`: `<how to recheck it against the moved base, such as migration numbering or a generated schema>`.

## Runners, budgets and records

### Where each value lives

| What | Where |
| --- | --- |
| Each pull request job's budget, and the month's spend ceiling (`<monthly-cap>`) | `<budgets-file>` |
| Each runner label's price, unit and rounding (`<per started minute, per runner type / per vCPU-minute>`) | `<price list or the provider's pricing page, and the date read>` |
| A test file's shard cap, the statistic it's judged by (`<p90 over newest N passing runs>`) and its exemptions | `<shard-script>` |
| Each job's runner, and why that size | `runs-on`, and the comment above it, in each job of `<workflow-file>` |
| What a diff reaches | `<selector-script>` |
| How many shards a run takes, and which files each runs | `<shard-script>` |
| Which run cancels which | `<workflow-file>`'s `concurrency` and the comment above it |
| When the sweep starts | `<sweep-workflow>`'s header |
| What a failed sweep does: the rerun, the bisect and the issue | `<bisect-workflow>` |
| What a release waits for | `<release-workflow>` |
| Test retry policy | `<retry-setting>` |
| Each flaky test's issue: who files it and when it closes | `<flake-script>` |
| What each run chose, ran and failed | `<records-script>`, reading the jobs' logs |
| Each job's own report (test totals, failing tests) | `<where: the run's summary page, an artifact, a log section>` |
| Each cache's key and who writes it | The cache steps in `<workflow-file>`, and `<shared-actions>` |

<!-- Example: budgets in scripts/budgets/ci-budgets.ts, shards in scripts/shards/test-shards.ts, records in
     scripts/records/ci-records.ts, flaky tests' issues in scripts/flakes/flake-issues.ts. Each pull request job has
     a runner and a p95 budget, and the budgets' test fails on a job without one, a budget whose job is gone, or a
     runner past its budget. -->

### Runner sizes, as measured

- `<runner>`: `<what was measured, when, and what it showed>`.

<!-- Example: six concurrent test files on 8 vCPU used about half the CPU, while nine saturated it and took
     longer. Small runs finished well inside a minute on 8 vCPU and still billed a full minute on all cores. Native
     Node compile caching cut module load by about a quarter. -->

### Tried and dropped

- The register: `<register-file>`. One row per idea dropped, with what limited it, its evidence and the week, as the ci-read-what-was-tried check says. Read it before designing a CI change or a test campaign.

## Caches

- `<cache>`: `<its key, who writes it, who reads it>`.

<!-- Example:
- Dependencies and the Rust toolchain from Blacksmith's sticky disks, through shared composite actions.
- A remote task cache holds the static, lint and test groups' passes; its runbook says who may write.
- The Actions cache is scoped by branch, so the sweep runs the static job itself.
- Small files a run's jobs read back (shard claims, flakes, shard times) go in the Actions cache, never artifacts.
- Sub-second code generation isn't cached: replaying it took longer than the work.
-->

## Spend watcher

Fill this in only if a person approved an external watcher; provider budgets come first.

| What | Value |
| --- | --- |
| Where it runs, and its read-only token's scope | `<deployment>` |
| Repos and workflows it watches (an allowlist) | `<repo>: <workflows>` |
| Spend source and its units | `<billing API or bill export, units>` |
| Freshness cutoff: older data stops it reporting | `<hours>` |
| What it does: report only, or cancel with an override | `<report only>` |
| Status command | `<command>` |
| Who stops it, and who recovers after a stop | `<owner>` |

## Platform probes

Checks that rely on a platform guarantee run against the real platform, in authorized environments only.

- Environments: `<which accounts or projects may be used>`.
- Commands: `<command per probe>`.
- Result archive: `<where each probe's result is kept, with its date and revision>`.

## Manual runs and failures

- Approver: `<who says yes to a run by hand>`. Approved exceptions, which need no new yes: `<a failure you're chasing / a file a pull request's run leaves out>`.
- Dispatch modes and their declared inputs: `<workflow: inputs it declares>`. Pass only declared inputs.
- Repeat limits: `<max repeat per run, per file kind>`. CI's own retries stay as configured: `<retry-setting>`.
- `--ref <branch>` picks the workflow's revision; a `ref` input, where the workflow declares one, picks the code it checks out. Pass both when testing a branch's workflow change. A workflow with no `ref` input checks out `--ref`'s code: drop `-f ref`. On another CI system, replace the whole dispatch command, not only its placeholders.
- Name at most `<n>` paths in `test_paths`; name folders to cover more.
- Keep `repeat` at 3 or under, unless measuring a flake's rate with a yes: `<n>` of an ordinary file, `<n>` of a slow container file.
- `<expensive runner>` needs a person's yes.

```sh
# The ordinary tests whose paths contain one of these, without the container tests.
gh workflow run <workflow-file> --repo <org>/<repo> --ref <branch> -f ref=<branch> <container-tests-off> \
  -f test_paths='<path> <path>'

# One file 50 times with no retry, to measure a flake's rate, only with the coordinator's yes.
gh workflow run <workflow-file> --repo <org>/<repo> --ref <branch> -f ref=<branch> <container-tests-off> \
  -f test_paths=<file> -f repeat=50
```

<!-- Example: at most 4 paths (a run naming 12 wasn't started, likely an over-long concurrency group); repeat 50 for
     an ordinary file, 20 for a container file; macOS needs a yes, at several times a Linux minute. -->

### Verifying a flake's fix

This repo's one policy: `<the policy>`.

- A test retry inside the job, `<retry-setting>`, is CI's own, and a pass on retry still files the flake.
- One diagnostic rerun of the failed job: `<allowed / not allowed>`, on the same revision and config.
- A second failure of the same test: `<an issue, and to the coordinator>`.
- An infrastructure failure (runner lost, network, cache service) isn't a test result: `<rerun the job once / who to tell>`.

<!-- Example (a standing campaign): prove the cause locally with no retries and a mutation; the PR's ready run is
     the CI evidence and runs once; a flaky failure gets one rerun; a second failure becomes an issue. An extra CI
     repeat needs a specific unresolved question and the coordinator's yes. -->

### Flaky tests

- CI retries each failed test `<n>` time(s), so a flake doesn't turn a run red. The run that hits one files it, as `<flake-script>` says.
- The issue is `Flaky: <file> › <test>`, or `Flaky job: <job>` when a rerun job named no test. Each later sighting is a comment.
- `<when it rises in priority>`.
- Close after at least 7 quiet days and 50 qualifying clean executions, or 7 clean executions for sweep-only and job-level issues. Cache replays count as zero. `<or this repo's rule>`

<!-- Example: retry once; labels flake, bug, ci, test-infra and P2; a `hot` count of sightings in as many days raises
     it to P1; the daily health check closes it by the rule above; at most 10 flakes filed a run. -->

## Merge, releases and deploy

- Merge `<by hand / through the merge queue>` after `<gate-job>` passes, as the `ci-merge-workflow` skill says.
- Releases `<are batched / publish on merge>`, and publish only `<what>`.
- A failed sweep files `<main's failure issue>` and starts `<the bisect>`.
- After a merge: `<the command that finds main's run for the merge commit>`; after the sweep: `<the command that shows its result>`.

### Release owners and reserved operations

- Owners: `<who>`. Only they merge a release PR, push to its branch or change its labels, change a package's version, start or rerun a release workflow, and move a branch production deploys from.
- Released versions before ready: `<the command that finds snapshot URLs in manifests, catalog and lockfile>`.
- Snapshot of a branch, for a draft only: `<the command>`.

### Deploys and how to verify them

| App | Deploys from | How to see the deploy for a commit | How long to wait | What identifies it (commit SHA, version) |
| --- | --- | --- | --- | --- |
| `<app>` | `<branch or release>` | `<command>` | `<minutes>` | `<field>` |

<!-- Example: releases are batched and publish only a commit the daily sweep passed; a failed sweep files
     "CI on main failed" and bisects the day's merges; Workers Builds deploys staging after each merge, and
     `wrangler deployments list --env staging` shows it. -->
