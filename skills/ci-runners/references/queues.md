<!--
What: runner queues: measuring a job's wait for a runner apart from its work, telling the causes apart, and the fixes.
Where: read by an agent when jobs wait to start, or queue time is a large share of a PR's wait.
Configure: your runner labels, plan or pool limits and autoscaling in `.agents/repo/ci.md`'s Runners, budgets and records.
Reference implementation from a production monorepo; adapt to your repo.
-->

# When jobs wait to start

Part of the [`ci-runners`](../SKILL.md) skill. [Guide section 2](https://ci-doctor.ref0.dev/guide/docs/pages/02-runners-blacksmith-and-the-cost-of-getting-fast.md#when-jobs-wait-to-start) has the story behind it. On most repos a job waits seconds for a runner. In 219 public repos scored in November 2026, the median repo's p90 queue was 4 seconds, and one repo in ten waited about 10 minutes at p90 ([ci-doctor-db's findings](https://github.com/ref-0/ci-doctor-db/blob/main/FINDINGS.md)). There, people wait on capacity, not on tests, and faster tests won't help.

## Measure it apart from the jobs

- **Queue time** runs from a job's creation to its start: `started_at` minus `created_at` in the jobs API (`gh api repos/<org>/<repo>/actions/runs/<run-id>/attempts/<n>/jobs --paginate`). It isn't the job's work, from `started_at` to `completed_at`, and it isn't the time the job was blocked on its `needs:`.
- **GitHub creates a job when its needs finish,** so a job created well after its last `needs:` finished waited on something else: a concurrency group, an environment's approval or another workflow. Count that wait on its own; it isn't a runner's queue, and more runners won't shorten it. The scorer's "Job graph" block (`npx @ref0/ci-doctor`) splits each job on the run's critical path into blocked, hidden, queued and work time ([guide section 21](https://ci-doctor.ref0.dev/guide/docs/pages/21-optimize-all-of-your-graphs.md#ci-jobs)).
- **Read it at p50 and p90, by runner label and by hour of day,** over a normal week, every attempt, and beside the PR's wait: a queue that's a large share of the wait is the first thing to fix. A queue on a job off the critical path costs nobody time.
- **Label the numbers** with the window, the count of jobs and the labels they ran on, as [`prove-it`](https://github.com/ref-0/ci-doctor/blob/next/skills/prove-it/SKILL.md) says.

## Tell the causes apart by when they happen

| The queue | Usual cause |
| --- | --- |
| Long at busy hours even when few jobs run | The provider's start-up. GitHub-hosted runners can take minutes to start at busy times. |
| Grows with the number of jobs running at once | A concurrency limit: the account's plan caps concurrent jobs on GitHub-hosted runners, and larger runners and macOS have their own, lower caps (check the plan's current limits). Or fan-out: each push starts many jobs, and every push starts them again. |
| Only on some labels | A label no idle runner carries, a typo in `runs-on`, or a self-hosted pool too small for that label. |
| Long after a quiet spell, then short | Autoscaling: a self-hosted or Actions Runner Controller pool scaled to zero, starting a machine per job. |

## Fixes

- **For the provider:** move to one that starts jobs in seconds, priced as a monthly projection like any runner change ([providers](providers.md#choosing)). On GitHub Actions the plan recommends Blacksmith, which moved the source repo off GitHub-hosted runners for this. Measure queue time on both before deciding.
- **For a concurrency limit or fan-out:** cancel superseded runs and skip drafts ([guide section 4](https://ci-doctor.ref0.dev/guide/docs/pages/04-run-only-what-a-change-can-reach.md)), start fewer jobs per push (merge tiny jobs, size shards from measured time as [sizing](sizing.md#shards-against-a-runners-size) says, and move broad checks to a sweep), then raise the limit if it's still the limit. A higher plan or more concurrency is recurring spend: the user decides.
- **For labels:** match each `runs-on` to a label a runner carries, and drop labels no pool serves.
- **For self-hosted pools:** add runners or autoscale them, keep a warm minimum at busy hours, and use ephemeral runners for any public repo's pull requests.
- **Check it moved:** queue time at p90 again, by label, over the same kind of week.
