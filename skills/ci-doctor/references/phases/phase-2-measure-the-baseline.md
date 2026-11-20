[Start: ci-doctor](../../SKILL.md) · Previous: [Phase 1](phase-1-map-the-repo.md) · Next: [Phase 3](phase-3-set-targets-and-write-the-plan.md)

# Phase 2: measure the baseline

From the CI provider's API and logs, with no new runs.

- **Ask what the reported number measures.** "CI takes 14 minutes" can mean several clocks. Report these separately, each with its denominator:
  - trigger to the required gate's conclusion;
  - first job start to the gate;
  - queue to start, per event and job, where the API gives it;
  - first ready to final green, per PR.
- **Which runs count:** for each historical PR event and head, establish whether the PR was ready at that time (from its timeline, not its present state) and which checks were required then. The last job to finish may only post reports; trace `needs` and step timestamps to separate setup, execution, artifact waits and queueing. Label unknown joins and proxy timestamps.
- **Wall time per PR run:** median, p75 and p90 over a closed 2–4 week UTC window of **successful first attempts on ready PRs**. Leave out skipped draft runs and say how many runs were counted, the window and the hours. Do the same for small and full runs if the repo has both. Report failed, missing and unfinished runs beside the quantiles, and name the quantile method.
- **The whole delivery interval,** not only the gate run: first ready to final green, final green to merge, merge to staging, and merge to a published package, where those exist. Count runs per PR, including PRs with no runs. Split the waits you can evidence into CI, local resource contention, review, approval and release or measurement holds. Rank which one constrains delivery now before choosing CI work.
- **Critical path:** which job ends the gate most often, through which chain of dependencies, and within it which shard and file.
- **Spend,** priced by the runner's own billing model:
  - **GitHub-hosted:** each job's duration rounded up per job, by its actual runner SKU, at the verified per-runner rate ([GitHub's job execution time](https://docs.github.com/en/actions/how-tos/monitor-workflows/view-job-execution-time)). Include every attempt.
  - **Per-vCPU providers such as Blacksmith:** rounded minutes × vCPUs, at their rate.
  - Report raw runner minutes, a list-price projection, and actual usage against any included allowance, as three separate numbers. Actual spend comes only from authorized billing reports; say "unavailable" when you can't read them.
  - Attribute only measured jobs to logical categories. Count cache storage and other provider costs separately.
  - Follow [guide section 12's audit rules](../excerpts/phase-2.md#audit-spend-over-comparable-windows): equal complete windows, job renames reconciled, and any current cap read from its configuration.
- **Per-file test time,** if the runner reports it. Vitest needs a reporter ([the reporter](../excerpts/phase-2.md#1-the-reporter)); pytest can write JUnit XML and per-phase durations ([Python tests](../excerpts/phase-2.md#python-tests)). Label case durations as durations, not file wall time. If there are no file timings, the plan's first step proposes recording them (guide section 13), and the slow-file inventory is marked pending.
- **Flake history:** tests that failed then passed on the same commit. Keep test-level retries, failed-job reruns and infrastructure failures apart.
- **Selection waste:** how many PR runs ran everything, and why.
- **What a change triggers,** for a JavaScript or TypeScript workspace: [`scripts/graph/`](../../../../scripts/graph/README.md#what-a-change-triggers) replays the last 200 merges through the import graph, read-only. Paste its headline: the p50 and p90 share of tests a commit reaches, beside what package-level selection would run, the share that reaches everything, and the widest triggers. It's the graph's reach, not what ran; label it so.
- **Local contention,** if agents share a machine: slot waits logged apart from test time, with the denominator named ([guide section 14](../excerpts/phase-2.md#sharing-one-machine)).

**How to collect it.** Follow the guide's [read-only collection recipe](../excerpts/phase-2.md#collecting-from-the-api-without-losing-runs) and [`ci-history-data.md`](../speed-up-tests/references/ci-history-data.md): page everything, split date windows below the API's caps, keep every attempt, cover every workflow in the current gate, include non-PR events for spend, and count what you couldn't read. The `ci-time.ts` script in the `ci-workflows` topic is a spot-check of recent runs, not this baseline.

This is a bounded, one-time read of metadata and log samples. It isn't a backfill or a standing collector: those need the user's yes (guide section 13). Keep an API-call reserve for other users of the quota.

**A pasted `<ci-report>`,** from `npx @ref0/ci-doctor` or ci-doctor.ref0.dev, is dated data from a sample of recent runs, not the baseline. Check each of its headline numbers against the runs you collect, one by one: the PR wait p50, p75 and p90, the queue p90, red heads, green only on rerun, and the critical path. Where they agree, take them and spend the collection on what it left out; where they don't, say so and use yours. Its guide links name pages in this repo's `docs/pages/`.

**When evidence is missing,** mark it unavailable with your confidence, and say what would supply it. Don't dispatch a run, install a collector or widen permissions to fill a gap.

**Separate the baseline from experiments.** History gives a retrospective baseline. If its logs lack CPU, memory or the limiter, mark them unknown. Estimate the noise floor from comparable existing runs. A causal comparison (paired runs, telemetry, a control cohort) is a Phase 4 experiment the plan prices and the user approves.
