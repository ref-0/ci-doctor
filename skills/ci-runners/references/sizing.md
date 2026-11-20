<!--
What: how to size a CI job's runner and architecture, the small-runner rule, and shard counts against runner size.
Where: read by an agent changing a job's runner, its test workers or a run's shard count.
Configure: your sizes and their measurements in `.agents/repo/ci.md`'s Runners, budgets and records.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Sizing runners

Part of the [`ci-runners`](../SKILL.md) skill. [guide section 7](https://ci-doctor.ref0.dev/guide/docs/pages/07-shards-runners-and-billing.md#size-runners-from-the-work-and-the-bill) has the measurements behind each rule. Read the repo's current runners, file concurrency and shard limits in the workflows and scripts ci.md names; don't copy them here.

## Size and architecture

- **Start each job on the repo's existing label.** Where only one hosted size is eligible, keep that label static and drop any size output. Set worker counts and shard targets from the actual runner and repeated observations. Compare queue, capacity, startup and priced cost before asking for a larger runner or more concurrent jobs.
- **Size by measured CPU.** One 8 vCPU shard running six test files at once used about half its CPU, while nine saturated it and took longer. Re-measure before changing concurrency. The check [size a runner by its CPU](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-doctor/references/checks/ci-size-a-runner-by-its-cpu.md) has the rule: resize only when three runs agree.
- **Read CPU from the provider, or sample it yourself.** If you run on Blacksmith, `blacksmith jobs stats` gives it ([CLI](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-doctor/references/blacksmith/references/cli.md)). Elsewhere, sample `/proc/stat` or `vmstat 5` from inside the step you measure, started at its first command and stopped at its last, so setup and teardown don't dilute it, and print the percentiles. Where history has no CPU figures, record CPU as unknown, not as a guess.
- **A job that waits can take the smallest compatible runner:** on containers, the network, timers or a harness, more cores sit idle. The check decides, from its p90 and memory as well.
- **More workers isn't faster.** Past the CPU a runner has, extra test workers slowed the shard and added timing failures.
- **Size each architecture separately.** A bigger runner halved one architecture's compile and didn't help the other's.
- **Cheaper cores aren't cheaper service.** Runners at a lower minute price ran the same tests slower, and some failed. Measure the same tests on both before switching.
- **Watch memory too.** A job whose p95 memory nears its runner's limit gets a bigger runner whatever its CPU says.
- **Keep a slow install to the one job that needs it:** an apt update can cost more than the job's work.
- **Run macOS only where it's needed,** such as a release, and by hand only with a person's yes: a macOS minute costs several Linux ones on every provider we know.

## The small-runner rule

Where the provider offers several sizes, most pull requests select little: give a small selection the smallest runner and as many workers as it has cores. In the source repo, an example to replace with your own measurements, "small" meant `server_files + other_files / 10 ≤ 6` (heavy integration files count whole, quick ones a tenth), on 2 vCPU with 2 workers. In one sample, most one-shard runs were that small, with setup about half of each job; on 8 vCPU each would have paid four times as much for its minimum minute. Let the plan choose the size from what it selected.

## Shards against a runner's size

```text
shards = clamp(ceil(total_test_seconds / (workers_per_shard * target_seconds_per_worker)), 1, max_shards)
```

- **Workers per shard come from the runner's measured CPU,** and the target, where the provider rounds per job, from the billing cliff: a shard should end, setup included, just under a whole billed minute (two in the source repo). [Billing](billing.md#packing-against-minute-rounding) says why.
- **Twice the shards with half the work each costs about the same compute,** plus each shard's setup again. More shards shorten wall time only until setup and the slowest file set the floor.
- **Model the overheads,** per-file process start and per-group start, measured in your current CI, and give new or split files a pessimistic estimate.
- **Keep one plan's assignment for every shard,** from a full run's times, so shards don't disagree about who runs what.
- **A shard can't end before its longest file;** split or shorten that file first, as [slow runs](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-workflows/references/performance.md) says.

## Reviewing sizes on a schedule

Tests change, so a size that fit when it was chosen drifts. A standing review re-checks each job; it only proposes, and a resize needs the user's yes.

- **Cadence from PR volume.** Daily when PRs land often enough that each job gets a fair sample of runs every day; weekly otherwise. Judge a job only once it has at least the health report's minimum runs since the last review; below that, report "too few to judge".
- **Read per job, per runner label:** median and p90 CPU, p95 memory, wall time and whether the job sits on the critical path. On Blacksmith, `blacksmith jobs stats` ([CLI](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-doctor/references/blacksmith/references/cli.md)); elsewhere, the job's own `/proc` samples.
- **Propose a smaller runner** for a job that stays well under its CPU and isn't on the critical path, a **bigger one** for a job near its memory limit or CPU-bound on the critical path, and a **shard-count change** whenever a test job's runner changes. Apply the check [size a runner by its CPU](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-doctor/references/checks/ci-size-a-runner-by-its-cpu.md) to each.
- **Price each proposal** as a monthly projection from the job's measured frequency, with its effect on median and p90 wall time.
- **Report in one place:** one issue or one comment on the health report's issue, listing proposals and jobs too new to judge. Nothing changes until the user approves.

