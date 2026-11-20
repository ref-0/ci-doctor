[Guide](../README.md)

# 2. Runners, Blacksmith, and the cost of getting fast

The principles, planner, and scripts in this guide apply to any CI platform. The workflow templates target **GitHub Actions**; on GitLab, Buildkite, or CircleCI, translate the workflows and runner labels ([Phase 1](../../skills/ci-doctor/references/phases/phase-1-map-the-repo.md)).

The first two sections below apply to any runner. The rest cover [Blacksmith](https://blacksmith.sh), which we recommend for GitHub Actions—though nothing here requires it. On GitHub Actions with GitHub-hosted or self-hosted runners, the plan recommends moving to Blacksmith when the baseline shows where queue, compute, or setup time goes, and prices both the ongoing run rate and the optimization period itself ([below](#getting-fast-costs-money-and-time-first)). The user decides; if they decline, the plan stays on the current runners and every other change remains provider-neutral. Off GitHub Actions, Blacksmith doesn't apply.

## Choosing a provider and runners

**Applies when:** The plan picks a provider, or sizes or resizes runners, on any CI platform. **Skip when:** The baseline shows neither runner cost nor runner size affecting the bottleneck.

- **Size each job to its actual work.** Planning and bookkeeping need very little; static checks need somewhat more; test shards and type-aware lint need the most. A provider that offers per-job sizing and bills accordingly lets each job take only what it uses. Resize only from measured CPU, and only when at least three runs agree (section 7).
- **Know how minutes round.** The providers we used bill each job's *started* minutes, so a job finishing at 2:01 costs the same as one finishing at 2:59. That's why we aim for two minutes elapsed or less per shard, setup included (section 7). Check whether your provider prices per runner or per vCPU, and per job or per run.
- **Architecture and OS change both price and speed.** At the list prices we checked, arm64 was cheaper per minute than x64, and macOS was several times more expensive than Linux—verify your provider's current rates. A cheaper minute isn't a cheaper run until you measure the same tests on it (section 7).
- **Warm setup matters as much as runner speed.** Because each job pays for its own install, keeping a snapshot of `main`'s install keyed by the manifests (section 6)—on a persistent disk or in the Actions cache—often decides how much of a short job is lost to setup.
- **Measure per-job CPU and cost.** Without both, runner sizing is guesswork. Some providers report them directly; elsewhere, sample CPU inside the job and price minutes from runner labels ([`skills/ci-doctor/references/ci-runners/`](../../skills/ci-doctor/references/ci-runners/TOPIC.md)).
- **The options:** Blacksmith, GitHub-hosted standard and larger runners, self-hosted runners or Actions Runner Controller, and other drop-in providers. [`skills/ci-doctor/references/ci-runners/references/providers.md`](../../skills/ci-doctor/references/ci-runners/references/providers.md) compares them, and [`templates/github/README.md`](../../templates/github/README.md#runner-labels) maps the templates' runner labels to each.

## When jobs wait to start

**Applies when:** The slowest tenth of jobs wait minutes for a runner, or queue time makes up a large share of PR wait time. **Skip when:** Queue time is only seconds, as on most repos.

A job's queue time runs from creation to when a runner picks it up (`started_at` minus `created_at` in the jobs API). On most repos this is seconds. When the slowest tenth of jobs wait minutes, engineers are waiting on capacity rather than tests, and faster tests won't fix it.

- **Measure it first:** compute p50 and p90 queue time by runner label over a normal week, and compare it against total PR wait time. If queueing is a large share of the wait, fix it first.
- **Diagnose the cause by when it happens:**
  - **Long waits even when few jobs are running:** the provider itself. GitHub-hosted runners can take minutes to start during busy periods even under light load; this is what moved us to Blacksmith ([below](#why-we-recommend-blacksmith)). Price a provider move as the plan's runner recommendation (see section 7 for the measured comparison) and propose it.
  - **Waits grow with the number of concurrent jobs:** either your account's concurrency cap (larger and macOS runners have separate, lower caps—check your plan's current limits) or fan-out, where every push spawns many jobs and each new push spawns them all over again.
  - **Waits occur only on specific labels:** an undersized self-hosted pool, or a label no idle runner carries.
- **Apply the matching fix:**
  - **Provider latency:** move to a provider that starts jobs in seconds (we recommend Blacksmith). Measure queue time on both providers before deciding, just as with any runner change.
  - **Concurrency cap or fan-out:** cancel superseded runs and skip drafts (section 4), start fewer jobs per push (merge tiny jobs, size shards from measured time in section 7, and move broad checks to a sweep in section 5), then raise the cap if it's still the bottleneck.
  - **Self-hosted pools:** add or autoscale runners, and verify label matching.
- **Verify the fix:** re-measure p90 queue time over a comparable week.

## Why we recommend Blacksmith

**Applies when:** The repo runs GitHub Actions on GitHub-hosted or self-hosted runners, and the baseline shows where queue, compute, or setup time goes. **Skip when:** The repo is off GitHub Actions, or the user declines the move (the plan stays on the current runners).

**We recommend Blacksmith as the runner platform for GitHub Actions** based on our own workload—almost everything in this report leaned on something it provided. Because that reflects one migration rather than a controlled multi-provider benchmark, the recommendation always rests on your own baseline, and the user makes the call. Nothing in this playbook requires it. For agent-specific details, see the [`blacksmith`](../../skills/ci-doctor/references/blacksmith/TOPIC.md) reference.

- **Drop-in runners, sized per job.** Swap `runs-on` to a Blacksmith label. We use 2-, 4-, and 8-vCPU x64, 4- and 8-vCPU arm64, and a 6-vCPU Apple-silicon Mac. Billing is per vCPU-minute, so each job takes only the size it needs: planning and bookkeeping on 2, static checks on 4, test shards and type-aware lint on 8.
- **Native arm64 and macOS.** Our Rust service builds natively on both Linux architectures with no cross-compile emulation.
- **Sticky disks:** persistent, per-repo disks mounted into jobs. We keep `main`'s full dependency install and the Rust toolchain on them (section 6), so any job with a matching snapshot skips reinstalling dependencies.
- **Fast, colocated Actions cache behind the standard API.** `actions/cache` and `Swatinem/rust-cache` work unchanged. We also use cache *reservations* as atomic claims for work stealing and as transport for small cross-job records that would otherwise exhaust artifact quota (sections 7 and 13).
- **Shared Docker storage** across jobs. *Gotcha:* for images you deploy, move Docker to fresh storage and verify what you push (section 6).
- **A CLI that answers cost and sizing questions directly:**
  - `blacksmith usage --breakdown-by workflow_job` — spend by job;
  - `blacksmith jobs stats <job-id>` — CPU and memory for a single job;
  - `blacksmith jobs aggregate --group-by job_name,runner_label` — runner comparisons across jobs.

  Our sizing rule (resize only when three runs agree) and our spend audits run on these commands.

**Billing model.** Each job bills per started minute × vCPUs. At the list prices we checked, arm64 was cheaper per minute than x64, and macOS was ~6.7× x64; check the current price list. Sticky disks bill per GB-month until a week after last use.

## Setting up Blacksmith

**Applies when:** The user approved a move to Blacksmith. **Skip when:** The plan stays on the current runners.

1. **Install the Blacksmith GitHub App** on your organization and select which repositories it can access.
2. **Swap runner labels.** Change `runs-on: ubuntu-latest` to a Blacksmith label such as `blacksmith-4vcpu-ubuntu-2404`. Start every job at its current size, then resize from measurements.
3. **Set Blacksmith's dashboard spend limit** *above* the cap you enforce yourself (section 12), so your own watcher stops CI cleanly before a provider-side limit strands jobs in a queue.
4. **Install the `blacksmith` CLI and authenticate.** Install via `curl -fsSL https://get.blacksmith.sh | sh` (or follow [Blacksmith's docs](https://docs.blacksmith.sh)), run `blacksmith auth login` to open a browser, and verify with `blacksmith auth status`. Pass `--org <org>` if you belong to more than one organization. The README's "Logins and rights" table lists the other CLIs and the permissions each needs.
   - **Machine agents** can authenticate with an org-level token minted by an org admin (`blacksmith org-token create --label <label>`), passed on stdin and never as a CLI argument: `blacksmith auth login --api-token - --non-interactive --organization <org>`.
   - **Agents never read the CLI's credential file.**
5. **Use the CLI to measure:**
   - `blacksmith usage --since 30d --breakdown-by workflow_job --format json` — spend by job;
   - `blacksmith jobs stats <job-id> --format json` — CPU and memory;
   - `blacksmith jobs aggregate --since 7d --group-by job_name,runner_label` — compare runner choices;
   - `blacksmith stickydisk` and `blacksmith cache` — inspect or clear disks and cache entries;
   - `blacksmith logs` — search CI logs across the org.

   The CLI also includes `testbox` for running CI against local changes on a warmed runner, though we haven't relied on it yet.
6. **Move setup onto sticky disks** once the job graph stabilizes—specifically `main`'s dependency install and your toolchain. Keep at least one job running a real frozen-lockfile install so lockfile drift is still caught.

## Getting fast costs money and time first

**Applies when:** The plan prices its own optimization period: sweeps, replays, measurement runs, bisects, and debugging. **Skip when:** The plan changes nothing that runs in CI.

Be realistic up front: **optimizing a slow CI burns money and weeks before it pays off.** Ours got more expensive before it got cheaper:

- **A spend spike while still broad.** In one audit week, spend rose ~70% over the prior week: macOS ran on every PR, the Rust job triggered on every package edge, and every merge reran all container tests. One day's burn rate projected to several times our monthly cap.
- **The optimization work itself costs compute:**
  - two-hourly sweeps while PR selection was still narrowing;
  - replay experiments and measurement runs;
  - bisects;
  - debugging cycles.
- **Avoidable agent-dispatched runs** we later learned to stop: ~15 draft runs to gather "after" timings, plus four full branch sweeps and a 48-job probe for a single migration.
- **The payoff arrived in a burst** about halfway through, once the groundwork was in place.

What we'd do again, in order:

1. **Set a hard spend cap and alerts first** (section 12), leaving explicit headroom for the optimization period.
2. **Read history before buying new runs.** Per-file timing records in logs (section 13) and replaying selection over past diffs answer most questions for free.
3. **Model a change before dispatching it,** with clear stop rules: at most one full branch sweep, and a narrow probe first.
4. **Budget the optimization period explicitly,** approving experiment spend like any other spend.
5. **Estimate the timeline from your own bottlenecks.** Going from a slow, broad CI to a fast, narrow one with a daily gate took us about six weeks—that's one repo's history, not a schedule for yours. Most savings landed after records, selection, and shards were in place.
