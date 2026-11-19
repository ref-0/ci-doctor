[Guide](../README.md)

# 2. Runners, Blacksmith, and the cost of getting fast

The principles, the planner and the scripts hold on any CI platform. The workflow templates are written for **GitHub Actions**: on GitLab, Buildkite or CircleCI, translate the workflows and runner labels ([PROMPT Phase 1](../../skills/ci-doctor/references/phases/phase-1-map-the-repo.md)). The first part of this section holds for any runner; the second is what's specific to [Blacksmith](https://blacksmith.sh), which we recommend but nothing requires. On GitHub Actions with GitHub-hosted or self-hosted runners, the plan recommends moving to Blacksmith, backed by the baseline: where queue, compute or setup time goes, and what the move would change. It prices both the run rate and the optimization period itself ([below](#getting-fast-costs-money-and-time-first)). The user decides; if they decline, the plan stays on the current runners and every other change is provider-neutral. Off GitHub Actions, Blacksmith doesn't apply.

## Choosing a provider and runners

- **Size each job from its work.** The plan and bookkeeping need little; static checks some more; test shards and type-aware lint the most. A provider that offers a size per job, and bills by it, lets each job take only what it uses. Resize only from measured CPU, when three runs agree (section 7).
- **Know how minutes round.** The providers we used bill each job's *started* minutes, so a job at 2:01 costs the same as one at 2:59. That's why we aim for two minutes elapsed or less per shard, including setup (section 7). Find whether your provider prices per runner or per vCPU, and per job or per run.
- **Architecture and OS change the price and the speed.** At the list prices we checked, arm64 was cheaper per minute than x64 and macOS several times dearer than Linux; check your provider's current prices. A cheaper minute isn't a cheaper run until the same tests are measured on it (section 7).
- **A warm setup matters as much as the runner.** Each job pays for its own install, so a snapshot of main's install keyed by the manifests (section 6), on a persistent disk or in the Actions cache, decides how much of a short job is setup.
- **You need per-job CPU and cost.** Without them, sizing is a guess. Some providers report both; elsewhere, sample CPU in the job and price minutes from runner labels ([`skills/ci-runners/`](../../skills/ci-doctor/references/ci-runners/TOPIC.md)).
- **The options:** Blacksmith, GitHub-hosted standard and larger runners, self-hosted runners or Actions Runner Controller, and other drop-in providers. [`skills/ci-runners/references/providers.md`](../../skills/ci-doctor/references/ci-runners/references/providers.md) compares them, and [`templates/github/README.md`](../../templates/github/README.md#runner-labels) maps the templates' labels to each.

## When jobs wait to start

A job's queue time runs from when it's created to when a runner picks it up (`started_at` minus `created_at` in the jobs API). On most repos it's seconds. When the slowest tenth of jobs wait minutes, people wait on capacity, not on tests, and faster tests won't help.

- **Measure it first,** at p50 and p90, by runner label, over a normal week. Compare it with the PR wait: a queue that's a large share of the wait is the first thing to fix.
- **The usual cause is the runners themselves.** GitHub-hosted runners can take minutes to start at busy times, even with few jobs running. That's what moved us off them to Blacksmith ([below](#why-we-recommend-blacksmith)). Tell it from the other causes by when it happens:
  - **Long even when few jobs run:** the provider. Price a move as the plan's runner recommendation (section 7 for the measured comparison), and propose it.
  - **Grows with the number of jobs running at once:** the account's concurrency cap (larger and macOS runners have their own, lower caps; check the plan's current limits), or fan-out, where each push starts many jobs and every push starts them again.
  - **Only on some labels:** a self-hosted pool that's too small, or a label no idle runner carries.
- **Fixes:**
  - **For the provider:** move to one that starts jobs in seconds; we recommend Blacksmith. Measure queue time on both before deciding, as with any runner change.
  - **For the cap or fan-out:** cancel superseded runs and skip drafts (section 4), start fewer jobs per push (merge tiny jobs, size shards from measured time, section 7, and move broad checks to a sweep, section 5), then raise the cap if it's still the limit.
  - **For self-hosted:** add or autoscale runners, and check the labels match.
- **Check it moved:** queue time at p90 again, over the same kind of week.

## Why we recommend Blacksmith

**We recommend Blacksmith as the runner platform for GitHub Actions,** from our own workload: almost everything in this report leaned on something it gave us. That's one migration's experience, not a comparison across providers at the same workload, so the recommendation rests on your own baseline, and the user decides. Nothing in this playbook needs it. The [`blacksmith`](../../skills/ci-doctor/references/blacksmith/TOPIC.md) skill has the specifics for agents.

- **Drop-in runners, sized per job.** Change `runs-on` to a Blacksmith label. We use 2, 4 and 8 vCPU x64, 4 and 8 vCPU arm64, and a 6-vCPU Apple-silicon Mac. Billing is per vCPU-minute, so each job gets the size its work needs: the plan and bookkeeping on 2, static on 4, test shards and type-aware lint on 8.
- **Native arm64 and macOS.** Our Rust service builds natively on both Linux architectures, so there's no cross-compile emulation.
- **Sticky disks:** persistent, per-repo disks mounted into jobs. We keep main's full dependency install and the Rust toolchain on them (section 6), so a job with a matching snapshot skips reinstalling dependencies.
- **A fast, colocated Actions cache behind the standard API.** `actions/cache` and `Swatinem/rust-cache` work unchanged. We also use cache *reservation* as an atomic claim for work stealing, and as transport for small cross-job records that would otherwise eat artifact quota (sections 7 and 13).
- **Docker storage** that can be shared across jobs. Gotcha: for images you deploy, move Docker to fresh storage and verify what you push (section 6).
- **A CLI that answers cost questions:**
  - `blacksmith usage --breakdown-by workflow_job` gives spend by job;
  - `blacksmith jobs stats <job-id>` gives a job's CPU and memory;
  - `blacksmith jobs aggregate --group-by job_name,runner_label` compares runner choices.

  Our sizing rule (resize only when 3 runs agree) and our audits run on these.

**Its billing model.** Each job is billed per started minute × vCPUs. At its list price when we checked, arm64 was cheaper per minute than x64 and macOS ~6.7× x64; check the current price list. Sticky disks bill per GB-month until a week after last use.

## Setting up Blacksmith

1. **Install the Blacksmith GitHub app** on your organization and choose which repos it can run for.
2. **Swap the runner labels.** Change `runs-on: ubuntu-latest` to a Blacksmith label such as `blacksmith-4vcpu-ubuntu-2404`. Start every job at the size it runs on today, then resize from measurements.
3. **Set Blacksmith's own spend limit** in its dashboard, *above* the cap you enforce yourself (section 12), so your watcher stops CI cleanly before the provider's limit strands jobs in a queue.
4. **Install the `blacksmith` CLI and log in yourself.** Install it with `curl -fsSL https://get.blacksmith.sh | sh`, or as [Blacksmith's docs](https://docs.blacksmith.sh) say. Then run `blacksmith auth login`, which opens a browser, and check with `blacksmith auth status`. Pass `--org <org>` if you belong to more than one. README's "Logins and rights" table lists the other CLIs and the rights each needs.
   - **Machine agents** can use an org-level token that an org admin mints (`blacksmith org-token create --label <label>`). It's consumed with `blacksmith auth login --api-token - --non-interactive --organization <org>`, with the token on stdin and never on the command line.
   - **Agents never read the CLI's credential file.**
5. **Use it to measure:**
   - `blacksmith usage --since 30d --breakdown-by workflow_job --format json` for spend by job;
   - `blacksmith jobs stats <job-id> --format json` for CPU and memory;
   - `blacksmith jobs aggregate --since 7d --group-by job_name,runner_label` to compare runner choices;
   - `blacksmith stickydisk` and `blacksmith cache` to inspect or clear disks and cache entries;
   - `blacksmith logs` to search CI logs across the org.

   The CLI also has `testbox`, for running CI against local changes on a warmed runner. We haven't relied on it yet.
6. **Move setup onto sticky disks** once the job graph is stable: main's dependency install and your toolchain. Keep one job doing a real frozen-lockfile install so lockfile drift is still caught.

## Getting fast costs money and time first

Be honest with yourself about this: **optimizing a slow CI burns money and weeks before it pays off.** Ours got more expensive before it got cheaper:

- **A spike while broad.** In one audit week, spend rose ~70% over the week before: macOS running on every PR, the Rust job on every package edge, and every merge rerunning all container tests. One day's rate projected to several times our monthly cap.
- **The work itself costs:**
  - sweeps every two hours while selection was being narrowed;
  - replay experiments and measurement runs;
  - bisects;
  - debugging cycles.
- **Agents dispatched expensive runs by hand that we later learned not to do:** ~15 draft runs to get "after" timings, and four full branch sweeps plus a 48-job probe for one migration.
- **Most of the payoff came in a burst after the groundwork,** about half way through.

What we'd do again, in order:

1. **Put a hard spend cap and alerts in place first** (section 12), with headroom for the optimization period.
2. **Read history before buying runs.** Per-file timing records in logs (section 13) and replaying selection over past diffs answer most questions for free.
3. **Model a change before dispatching it,** and set stop rules: at most one full branch sweep, a narrow probe first.
4. **Budget the optimization period explicitly,** and approve experiment spend like any other spend.
5. **Plan the time from your own bottlenecks.** Ours took about six weeks from a slow, broad CI to a fast, narrow one with a daily gate; that's one repo's history, not an estimate for yours. Most savings came after the records, selection and shards were in place.
