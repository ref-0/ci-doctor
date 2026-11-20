[Guide](../README.md)

# 13. Records: evidence of what ran

**Applies when:** CI cannot prove which test files actually executed, or per-file timings are missing. **Skip when:** The repo already logs every executed file and its duration on each run.

A green check can easily hide a file that never ran. To prevent blind spots:

- **The plan logs** its selected inputs and test files on every run.
- **A custom Vitest reporter logs** structured lines for every file that actually executes. Its per-file timing is Vitest's module duration (with collection time reported separately), not whole-command wall time. Records write to **logs rather than artifacts** so they never consume artifact quota:
  - we built a custom reporter because Vitest's built-in JSON reporter omitted retry details;
  - cached tasks emit only fresh records—replays never count as executions.
- **A nightly collector** on the maintainers' machine harvests those log lines into **one compressed JSON-lines file per ISO week**:
  - it reads one log archive per attempt across 6 concurrent readers, spending from a 1,500-call nightly budget (counted from each invocation's reported calls, retries included) while keeping 1,000 calls/hour in reserve for other work;
  - it resumes cleanly from where it left off. Unreadable logs, expired logs, and days hitting the API result cap are marked *incomplete*—never quiet—retried on the next approved collection, and excluded from clean-run and timing claims;
  - **agents never bulk-collect records:** a week-long backfill once exhausted the shared 5,000/hour API quota for every agent. A bounded, one-time, read-only baseline sample is fine (below); bulk backfills and standing collection require explicit user approval.
- **Verify the collector before trusting a quiet week.** A copied script missing a new import once halted collection silently for days.
- **Count fresh runs separately from replays.** Shard count alone doesn't prove full coverage: compare the plan's selected inventory against the full eligible inventory at that commit—separately for ordinary, heavy, and container tests—and report selected, executed, and replayed counts. A sweep that mostly replays yields very few fresh timings. Rank durations only from successful, complete file executions, tag every observation with its SHA and attempt, and flag files with fewer than three observations.
- **Move small cross-job records to the Actions cache** (shard claims, flake files, timing files). Artifact quota filled twice and failed *passing* shards while uploading bookkeeping. Treat a missing cache key as "no record," but treat a transport error as a real failure, not a miss. Verdicts read by another workflow can travel as notice annotations instead of artifacts. Because GitHub recalculates artifact storage only every 6–12 hours, deleting artifacts won't immediately unblock CI—alert on a percentage of quota well before uploads fail.
- **Match retention to usefulness:** pass CI binaries between jobs via the Actions cache; keep release binary artifacts for 1 day, pass artifacts for 2 days, proof diagnostics for 7 days (uploaded on failure only), and financial receipts for 90 days. Note that trusted pass provenance and these retained artifacts still depend on artifact quota.

## Collecting from the API without losing runs

**Applies when:** Building a baseline, audit, or report from the CI provider's API. **Skip when:** All evidence comes from the repo's own records.

Any baseline, audit, or report pulled from the provider's API (Phase 2) follows the completeness and estimator contract in [`skills/ci-doctor/references/speed-up-tests/references/ci-history-data.md`](../../skills/ci-doctor/references/speed-up-tests/references/ci-history-data.md). In brief: split search windows below API result caps and paginate every list; include every attempt; join runs to PRs by explicit relations rather than branch names; separate `main` and release costs; state the quantile estimator and timestamps used; pair deploys by build identity; and explicitly count unread data. An unread outcome is never a zero wait, a zero cost, or a success.

Here is a read-only GitHub Actions baseline using your existing access, writing into a scratch folder:

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

Repeat the workflow-runs query without `event=` when measuring spend so pushes, schedules, and dispatches are included. Document partial reruns, expired logs, and any denied endpoints along with how much of the window they cover. If current access can't read a resource, ask for that exact scope or a user-redacted export—never widen tokens or archive unfiltered logs. Sources: GitHub's [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs) and [workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs) APIs.
