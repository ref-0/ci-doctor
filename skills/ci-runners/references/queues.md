<!--
What: runner queues: measuring a job's wait for a runner apart from its work, telling the causes apart, and the fixes.
Where: read by an agent when jobs wait to start, or queue time is a large share of a PR's wait.
Configure: your runner labels, plan or pool limits and autoscaling in `.agents/repo/ci.md`'s Runners, budgets and records.
Reference implementation from a production monorepo; adapt to your repo.
-->

# When jobs wait to start

Part of the [`ci-runners`](../SKILL.md) skill. [Guide section 2](https://ci-doctor.ref0.dev/guide/docs/pages/02-runners-blacksmith-and-the-cost-of-getting-fast.md#when-jobs-wait-to-start) has the story behind it. On most repos a job waits seconds for a runner. In 219 public repos scored in November 2026, the median repo's p90 queue was 4 seconds, and one repo in ten waited about 10 minutes (596 seconds) at p90 ([ci-doctor-db's findings](https://github.com/ref-0/ci-doctor-db/blob/main/FINDINGS.md)). A queue that long is the first thing to explain, and the fix follows its measured cause: a provider slow to start a runner needs a different provider, while in a pool that's full, shorter jobs free their slots sooner, so faster tests and fewer jobs shorten the queue too.

## Measure it apart from the jobs

- **Queue time** runs from a job's creation to its start: `started_at` minus `created_at` in the jobs API (`gh api repos/<org>/<repo>/actions/runs/<run-id>/attempts/<n>/jobs --paginate`). It isn't the job's work, from `started_at` to `completed_at`, and it isn't the time the job was blocked on its `needs:`.
- **GitHub creates a job when its needs finish,** so a job created well after its last `needs:` finished waited on something else: a concurrency group, an environment's approval or another workflow. Count that wait on its own; it isn't a runner's queue, and more runners won't shorten it. The scorer's "Job graph" block (`npx @ref0/ci-doctor`) splits each job on the run's critical path into blocked, hidden, queued and work time ([guide section 21](https://ci-doctor.ref0.dev/guide/docs/pages/21-optimize-all-of-your-graphs.md#ci-jobs)).
- **Read it at p50 and p90, by runner label and by hour of day,** over a normal week, every attempt, and beside the PR's wait: a queue that's a large share of the wait is the first thing to fix. A queue on a job off the critical path costs nobody time.
- **Label the numbers** with the window, the count of jobs and the labels they ran on, as [`prove-it`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/prove-it/SKILL.md) says.

## Tell the causes apart by when they happen

| The queue | Usual cause |
| --- | --- |
| Long at busy hours even when few jobs run, account-wide | The provider's start-up. GitHub-hosted runners can take minutes to start at busy times, macOS especially. |
| Grows with the number of jobs running at once | A concurrency limit, or fan-out: each push starts many jobs, and every push starts them again. GitHub-hosted runners have a total cap per plan, a macOS cap shared by standard and larger runners, and on larger runners a limit each runner pool sets when it's configured; [GitHub's limits](https://docs.github.com/en/actions/reference/limits) has the current figures, and Support can raise them. |
| Only on some labels | A label no idle runner carries, a typo in `runs-on`, or a self-hosted pool, or a larger runner's pool, too small for that label. |
| Long after a quiet spell, then short | Autoscaling: a self-hosted or Actions Runner Controller pool scaled to zero, starting a machine per job. |
| On Blacksmith, in some repos only | The Blacksmith GitHub app lacks access to a repo that uses its labels: runners Blacksmith starts for one repo can take another's jobs, and the first repo's queue ([Blacksmith's FAQ](https://docs.blacksmith.sh/blacksmith-runners/overview#faq)). |
| On Blacksmith, on jobs that are meant to wait | Flex scheduling: a label with `;scheduling=flex` starts when Blacksmith has spare capacity, within a day. Keep it off anything a person waits on. |

**Before blaming the provider's start-up, check account-wide use.** The cap counts every concurrent job in the account or organization, from every repo and workflow, so read how many jobs were running across the account in the minutes a job queued, not only this repo's. A queue that lines up with many jobs running elsewhere is the cap or fan-out; one that's long with few running is the provider.

## Fixes

- **For the provider:** move to one that starts jobs in seconds, priced as a monthly projection like any runner change ([providers](providers.md#choosing)). On GitHub Actions the plan recommends Blacksmith, which moved the source repo off GitHub-hosted runners for this. Measure queue time on both before deciding.
- **For a full pool, a concurrency limit or fan-out:** shorten the jobs that hold its slots, since a shorter job frees its runner sooner; cancel superseded runs and skip drafts ([guide section 4](https://ci-doctor.ref0.dev/guide/docs/pages/04-run-only-what-a-change-can-reach.md)), start fewer jobs per push (merge tiny jobs, size shards from measured time as [sizing](sizing.md#shards-against-a-runners-size) says, and move broad checks to a sweep), then raise the limit if it's still the limit. A higher plan or more concurrency is recurring spend: the user decides.
- **For labels:** match each `runs-on` to a label a runner carries, and drop labels no pool serves.
- **For Blacksmith:** as the [`blacksmith`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/blacksmith/SKILL.md) skill says, install its GitHub app on every repo that uses a `blacksmith-*` label, and take `;scheduling=flex` off jobs people wait on.
- **For self-hosted pools and Actions Runner Controller:** add runners or autoscale them, keep a warm minimum of idle runners at busy hours, so a job doesn't wait for a machine to boot, and use ephemeral runners for any public repo's pull requests.
- **Check it moved:** queue time at p90 again, by label, over the same kind of week.
