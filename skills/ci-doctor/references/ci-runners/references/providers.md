<!--
What: the runner providers for GitHub Actions, what each changes, and how to choose.
Where: read by an agent choosing or comparing runners, or writing a plan's runner recommendation.
Configure: nothing; prices change, so check each provider's current pricing page.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Providers

Part of the [`ci-runners`](../TOPIC.md) topic. Everything in this playbook runs on GitHub Actions, and these are runners for it. On GitLab, Buildkite or CircleCI the sizing and billing rules still hold; the labels and the disk actions don't. Check each provider's current pricing and runner list before quoting it.

An example comparison for GitHub Actions; prices, sizes and features change, so check each provider's current pages, and compare at your own runner sizes and workload.

| Provider | What it gives you | Watch for |
| --- | --- | --- |
| **GitHub-hosted** (the default) | Nothing to run. Standard runners, and larger runners in more sizes, arm64 and GPU, on paid plans. Free minutes on public repos. Budgets and alerts in GitHub's billing. | Each runner type has its own per-minute price; the Actions cache is size-capped per repo; larger runners are configured as runner groups. |
| **[Blacksmith](https://blacksmith.sh)** (what we use, and recommend on GitHub Actions) | Drop-in runners: change `runs-on` to a label sized per job, x64 and arm64, and macOS. Billed per vCPU-minute. Sticky disks, a cache behind the standard Actions cache API, and a CLI that prices jobs and reads their CPU. | A sticky disk is billed while it exists, and its Docker disk is shared across the organization. The [blacksmith topic](../../blacksmith/TOPIC.md) has the details, why we recommend it, and the move. |
| **Self-hosted, or [Actions Runner Controller](https://github.com/actions/actions-runner-controller) on Kubernetes** | Your own machines and prices, any size, warm caches on local disk, private network access. | You run, patch, scale and secure them. Never let a public repo's pull requests run on a persistent self-hosted runner: use ephemeral runners. |
| Others | Namespace, Depot, Ubicloud, RunsOn (in your AWS account), WarpBuild, BuildJet: each a drop-in label with its own sizes, cache and price. | Compare them only if the user asks; measure the same tests on them before switching. |

## Choosing

On GitHub Actions with GitHub-hosted or self-hosted runners, the plan recommends moving to Blacksmith, as [Phase 3](../../phases/phase-3-set-targets-and-write-the-plan.md) says. Back it with the baseline, price it, and let the user decide. A runner change shortens a run only where queueing, compute or setup limits it, and a reported median alone doesn't say which, so the recommendation says which applies here.

1. Measure what you have first, from the Phase 2 baseline: median and p90, queue time, spend by job, CPU per job.
2. Model the move: what changes in setup time, per-minute price, rounding and cores, as a monthly projection. Price the optimization period itself too, which costs more before it costs less ([billing](billing.md#the-cost-of-getting-fast)).
3. If the user says yes, move one workflow, keep each job at its current size, and compare like runs. Then resize from measurements, as [sizing](sizing.md) says.

If the user declines, plan on the current runners and keep every other change provider-neutral. Off GitHub Actions, Blacksmith doesn't apply: compare only what the user's provider offers. A provider's CLI, account and setup are needed only for the option selected.
