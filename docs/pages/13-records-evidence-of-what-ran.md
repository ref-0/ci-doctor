[Guide](../README.md)

# Records

Record which test files ran and how long each took, so a green check can't hide a file that never ran.

**Applies when:** CI can't show which test files ran, or per-file timings are missing. **Skip when:** The repo already logs every executed file and its time on each run.

A green check can hide a file that never ran. So:

- **The plan logs** its selected inputs and tests.
- **A Vitest reporter logs** structured lines for every file that actually executed. The per-file time it stores is Vitest's module duration, with collection reported separately; it isn't the whole file's wall-clock time. Records go to **logs, not artifacts**, so they don't count against the artifact quota.
  - The built-in JSON reporter lacked retry information, hence the custom reporter.
  - Cached tasks emit only fresh records: replays never count as runs.
- **A nightly collector** on the maintainers' machine pulls those log lines into **one compressed JSON-lines file per ISO week**.
  - It reads one log archive per attempt and uses 6 concurrent readers. A night's collection spends from a 1,500-call budget, counted from the calls each invocation reports it made, retries included, and keeps 1,000 of the hour's calls in reserve for everything else.
  - It resumes where it left off. A log it couldn't read, a log that has expired, and a day that hit the API's result cap are incomplete, not quiet: mark them, retry them on the next approved collection, and leave them out of clean-run and timing claims.
  - **Agents don't bulk-collect records:** a week's backfill once exhausted the 5,000/hour API quota every agent shares. A bounded, one-time, read-only sample for a baseline is different (below); bulk backfill and standing collection need the user's yes.
- **Check the collector before believing a quiet week.** A copied script missing a new import silently stopped collection for days.
- **Count fresh runs as fresh.** Shard count doesn't prove a run selected everything: compare the plan's selected inventory with the eligible inventory at that commit, separately for ordinary, heavy and container tests, and report selected, executed and replayed counts. A sweep that mostly replays leaves few fresh timings. Rank timings only from successful, complete file executions, carry each observation's SHA and attempt, and flag files with fewer than three observations.
- **Small cross-job records go through the Actions cache:** shard claims, flake files, timing files. Artifact quota had filled twice and failed *passing* shards while they saved bookkeeping. A missing key means no record, but a transport failure is an error, not a miss. A job's verdict that another workflow reads can travel as a notice annotation instead of an artifact. GitHub recounts artifact storage only every 6 to 12 hours, so deleting artifacts doesn't unblock CI at once: warn at a share of the quota before uploads are refused.
- **Retention follows usefulness:** CI binaries pass between jobs through the Actions cache, and release binaries are artifacts kept 1 day; pass artifacts 2 days, proof diagnostics 7 days and uploaded only on failure, financial receipts 90 days. Trusted pass provenance and these retained artifacts still depend on artifact quota.

## Collecting from the API without losing runs

**Applies when:** A baseline, audit or report is built from the provider's API. **Skip when:** The evidence comes only from the repo's own records.

Any baseline, audit or report you build from the provider's API (Phase 2) follows the completeness and estimator contract in the [`speed-up-tests`](../../skills/speed-up-tests/SKILL.md) skill's [CI history data](../../skills/speed-up-tests/references/ci-history-data.md). In short: split search windows below the API's caps and page every list; keep every attempt; join runs to PRs by explicit relations, not branch names; keep main's and release costs apart; name the quantile estimator and the timestamps used; pair deploys by build identity; and count what you didn't read. An unread outcome is never a zero wait, a zero cost or a success.

A read-only baseline on GitHub Actions, run with the access you already have, into a scratch folder:

```sh
gh auth status                                  # who you are; ask for a missing scope, never a token
gh api rate_limit --jq .resources.core          # keep a reserve for other work
# Runs of each workflow in the current gate, in a closed UTC window. A query returns at most
# 1,000 runs: if total_count reaches it, split the window and query again.
gh api --paginate "repos/$slug/actions/workflows/$workflow/runs?event=pull_request&created=2026-11-01T00:00:00Z..2026-11-14T23:59:59Z&per_page=100" \
  --jq '.workflow_runs[] | [.id, .run_attempt, .head_sha, .status, .conclusion, .created_at, .run_started_at, .updated_at] | @tsv'
# Every attempt of each run, and its jobs and steps (queue, start, end and conclusion).
gh api "repos/$slug/actions/runs/$run/attempts/$attempt"
gh api --paginate "repos/$slug/actions/runs/$run/attempts/$attempt/jobs?per_page=100"
# PRs, paged on their own: those with no runs count too. Each PR's timeline says when it was ready.
gh api --paginate "repos/$slug/pulls?state=all&per_page=100"
gh api --paginate "repos/$slug/issues/$pr/timeline?per_page=100"
```

Repeat the run query without `event=` for spend, which counts pushes, schedules and dispatches too. Note partial reruns, expired logs and anything you were denied, with how much it covers. If the user's access can't read something, ask for that exact permission or an export they redact; don't widen tokens or archive unfiltered logs. Sources: GitHub's [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs) and [workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs) APIs.
