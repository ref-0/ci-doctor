<!--
What: the completeness and estimator contract for numbers collected from GitHub's and the CI provider's APIs.
Where: read by an agent collecting a CI baseline, a delivery-time study or a spend audit from API history.
Configure: nothing; your collector's paths go in `.agents/repo/ci.md`'s Runners, budgets and records.
Reference implementation from a production monorepo; adapt to your repo.
-->

# CI history data

Part of the [`speed-up-tests`](../SKILL.md) skill, beside [measuring](measuring.md): where CI's records are and how to read them. Read it before you build a baseline, a delivery-time study or a spend audit from API history, and before the plan is approved, since it says what you may read then. How to judge the number you get is [`prove-it`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/prove-it/SKILL.md). An unread outcome is never a zero wait, a zero cost or a success.

## Before approval: read-only samples

- **Bounded, one-time reads only,** with the access you already have: a window of run and job metadata, a few logs. Installing a collector, a timer, a backfill or persistent storage is a plan item the user approves.
- **Probe access first,** with the least permission: `gh auth status`, `gh api repos/<org>/<repo>/actions/runs?per_page=1`, `gh api rate_limit` for the reserve you'd spend, and the billing read the plan needs. Leave a reserve for everyone else on the login.
- **On a denial,** ask for the exact missing permission, or for an owner's redacted export. Don't widen a token yourself.
- **Mark what you couldn't get** in the plan: expired logs, an SSO block, billing you can't read, deploys with no build identity. Give each number its confidence. Missing file timings make instrumentation the first proposal and the file inventory "pending"; return the plan without dispatching a run.

## A collection that pages everything

`ci-time.ts` is a spot check of recent runs. A baseline uses a closed UTC window, every page and every attempt:

```sh
slug=<org>/<repo>; wf=<workflow-file>
for day in <each UTC day of the window>; do          # one day a query, below the search cap
  gh api --paginate "repos/$slug/actions/workflows/$wf/runs?event=pull_request&created=${day}T00:00:00Z..${day}T23:59:59Z&per_page=100" \
    --jq '.workflow_runs[] | tojson' >> runs.jsonl  # split a day into hours if it reaches 1,000 runs
done
jq -r '"\(.id) \(.run_attempt)"' runs.jsonl | while read -r id n; do
  for a in $(seq 1 "$n"); do                         # every attempt, not only the latest
    gh api "repos/$slug/actions/runs/$id/attempts/$a" --jq tojson >> attempts.jsonl
    gh api --paginate "repos/$slug/actions/runs/$id/attempts/$a/jobs?per_page=100" --jq '.jobs[] | tojson' >> jobs.jsonl
  done
done
gh api --paginate "repos/$slug/pulls?state=all&per_page=100" --jq '.[] | tojson' > pulls.jsonl   # PRs with no run count too
```

Repeat for every workflow the gate waits on, and for `push`, `schedule` and `workflow_dispatch` runs when you count spend. Page each relevant PR's timeline (`repos/$slug/issues/<pr>/timeline`) for its ready and draft events. Note partial reruns: an attempt that reran only failed jobs lists the others from the attempt before. API reference: [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs), [workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs).

## Collect all of it

- **Split search windows below the API's cap** and reconcile the totals: GitHub's run search returns at most 1,000 results a query, so list one UTC day, or less, at a time.
- **Page every list.** Follow every `next` link or cursor; refuse a reading that stopped early.
- **Keep every attempt,** separately from the latest conclusion: a rerun that passed hides the failure before it.
- **Join by explicit relations first,** such as a run's pull request list, before branch names. A reused branch name belongs to the PR whose lifetime holds the run.
- **Keep shared costs separate:** `main`'s and release runs aren't any one PR's.
- **Name what you sampled and what you couldn't read,** and count them beside the results.

## Name the clock

Ask what a reported number measures before you compare with it: "14 minutes" can be several clocks. Report each apart, with its denominator:

- **trigger to gate:** the run's `created_at` to the gate job's `completed_at`;
- **first job to gate:** the first job's `started_at` to the gate's end;
- **queue:** each job's `created_at` to its `started_at`, where the API gives both;
- **first ready to final green:** a PR's first ready event, from its timeline, to its last passing gate.

Classify a historical run by the PR's state at that time, from its timeline, never by today's draft state, and by the checks required then. The job that ended last may only post reports, and an earlier job can sit on the critical path through `needs`: read the dependencies and each job's step timestamps to split setup, execution, waits on artifacts and queueing. Label a join you inferred or a timestamp that stands in for another.

## Report what it is

- **Report missing, failed and unfinished outcomes** beside the success quantiles, never only the successes.
- **Name the quantile estimator,** such as nearest-rank, and which timestamps are exact and which are proxies. A run's `updated_at` can span idle time between attempts; use the gate job's actual completion.
- **Pair deploys by build identity,** not by time order. Check a package's publication in its registry, not by its tag.
- **Measure delivery, not only CI.** Successful first-attempt run time is one interval. Measure first-ready to final-green, final-green to merge, merge to deploy and merge to published package too; count runs per PR, including PRs with none; and split evidenced waits into CI, local resource contention, review, approval and release holds. Rank the present constraint before choosing CI work.
- **A local-contention measure names its denominator,** such as all active time or only covered work. Match records to one worktree and work interval, and report ambiguous, unmatched and missing completions. Waits summed across parallel files overlap, so they aren't lost time: union the intervals first.

## Keep the raw data

Keep dated, immutable raw snapshots with their cutoffs, so a later reader can recompute. Keep sensitive excerpts, such as log lines with names or tokens, out of the durable archive.
