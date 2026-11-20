[Guide](../README.md)

# 7. Shards, runners and billing

## Shards from measured time, not file count

**Applies when:** Tests run (or should run) across multiple shards and per-file timings on `main` are recorded. **Skip when:** Per-file timings aren't recorded yet.

Start simple: a fixed per-suite assignment built from each file's recorded duration, passed as an exact file list to the test runner and checked against the collected inventory, delivers most of the balance ([`scripts/shards/`](../../scripts/shards/README.md#start-simple-a-fixed-split)). Keep test families that share fixture state together, cap matrix size to your organization's concurrency limits, and split any single file that dominates a shard before tuning the layout. Work stealing and independent lanes (below) are follow-on optimizations to measure separately.

Vitest's built-in sharding splits by file *count*; two shards once differed by roughly a quarter in test-seconds. Instead, the plan computes one split from **each file's latest timing on `main`** and passes it to every shard:

```text
shards = clamp(ceil(total_test_seconds / (workers_per_shard * target_seconds_per_worker)), 1, max_shards)
# ours: 6 workers, 75 s per worker, at most 16 shards
```

- **Model fixed overheads.** Include both per-file process overhead and per-task-group startup cost, and **measure both in your current CI**. Ours shifted as the harness and task cache evolved, with group startup turning out roughly twice our initial estimate. Omitting overheads once packed 200+ tiny files into a single batch that ran three times longer than planned.
- **Use pessimistic estimates for new and split files.** Assign new server files the p90 of server durations, and other files the median of their kind. Three new files initially estimated at a tenth of their real duration once landed in the same shard and made it the slowest by far.
- **Respect the billing cliff.** On providers that round each job up to whole minutes, target **two minutes elapsed or less per shard, setup included**. For example (hypothetical): 14 shards finishing just under 2 minutes bill 28 shard-minutes, whereas 9 shards spilling just past 2 minutes bill 27—meaning the faster layout costs nearly the same. We warn when shard p95 exceeds 110 s, because spilling one extra minute across 14 eight-vCPU shards costs 112 vCPU-minutes.

## Work stealing over cache-key claims

**Applies when:** Time-based fixed shards are already in place and runner speed still varies—measured on its own. **Skip when:** Fixed time-based shards aren't in place yet.

Runner performance fluctuates: one shard ran 1.6× the median.

- **Half fixed, half queued.** Keep roughly half of estimated work in fixed shard assignments (each shard's first group, untimed groups, and explicitly pinned groups stay fixed even if that exceeds the 50% target). Put the rest into a shared queue ordered slowest-first, grouped into batches of whole task groups until each batch's summed estimated work (file durations plus modelled startup) reaches ~60 seconds—note that's *summed work*, not 60 seconds of wall clock. Single-shard runs skip the queue.
- **Claim batches with cache reservations.** A shard claims a batch by **reserving a unique Actions cache key**; the first reservation wins. In contention tests of 10 and 20 contenders over 540 keys, every key had exactly one winner and claims completed in a fraction of a second.
- **Handle ambiguity by running.** Claims use a 10 s deadline and 3 tries. **If a claim result is ambiguous, run the batch anyway:** duplicate work is far better than a silently dropped batch.
- **Reruns and completeness.** Reruns restore claims from every attempt, and the aggregate result job fails if any batch has no recorded owner.
- **Result:** The gap between the slowest shard and the median shard shrank roughly sevenfold.

## Independent lanes

**Applies when:** A shard runs workers in synchronized rounds, forcing faster lanes to wait for the slowest task in each round. **Skip when:** Each worker lane already starts its next task immediately upon finishing.

Each shard runs one independent lane per worker, and each lane grabs its next task the moment it finishes. Round-based scheduling had left lanes busy only **43%** of the time.

## Size runners from the work and the bill

**Applies when:** Per-job CPU over at least three runs (including the high tail) shows a runner is mis-sized, or tiny selections are paying a large runner's minimum-minute cost. **Skip when:** Fewer than three runs agree.

- **Route small selections to 2 vCPU with 2 workers.** We define "small" as `server_files + other_files/10 ≤ 6`. In one sample, 28 of 40 single-shard runs were tiny—tests took about half the job and setup took the rest. Running them on 8 vCPU would pay 4× for the minimum minute.
- **More workers doesn't mean faster.** Running 9 workers on 8 vCPU took 1.5–1.8× as long as 6 workers and introduced timing failures.
- **Resize only when three runs agree.** Check per-job CPU across at least three runs before changing runner size (`blacksmith jobs stats` on Blacksmith, or in-job CPU sampling elsewhere), inspecting the high tail as well as the median. On GitHub-hosted runners, start jobs on the repo's existing label and compare queue time, concurrency caps, startup, and total priced cost before asking for a larger runner.
- **Split static checks from type-aware lint.** Combined, they had been one of our longest jobs. Type-aware lint got an 8-vCPU / 32 GB runner after p95 memory hit 97% of 16 GB.
- **Pack container tests longest-first** into jobs targeting ~150 s, running one file at a time on a small runner (2 vCPU for us; size yours from measured CPU). Re-estimate a file only when actual time drifts by more than 20%.
  - **Measure whole-command wall clock for packing,** including collection and setup, from successful files that actually executed. Vitest's per-module duration (stored in our records, with collection separate) omits collection, so don't use it directly for packing. Summing printed test-case durations gives only a lower bound: if it exceeds your estimate, the estimate is too low, but being lower proves nothing. Never replace estimates with case sums, and remember skipped files have no execution time.
- **Size each architecture independently.** Upgrading to 8 vCPU halved Arm compile time but made no difference on x64.
- **Cheaper cores aren't always cheaper runs.** Arm runners priced ~37% lower per minute ran our JS tests ~30% slower and failed three integration files.

## Shorten the critical path before buying cores

**Applies when:** Jobs sit idle waiting on upstream jobs before starting setup, or compiled test binaries run sequentially. **Skip when:** The critical path is already bounded by a single job's own work.

- **Overlap setup with upstream work.** Proof jobs check out and install dependencies while packaging runs, then wait only for the specific "snapshot published" *step* rather than the entire upstream job. A small wait action polls the latest attempt every 5 s and fails immediately if the prerequisite fails. Proof jobs began running tests roughly twice as early.
- **Let packaging wait on binaries, not Rust test suites.** Remember that waiting only orders execution: the Rust job must still save its binaries and the pack job must restore them by exact key.
- **Speed up Rust tests:**
  - Compile all test binaries up front, then execute independent test binaries concurrently.
  - Use `tmpfs` for scratch space, `mimalloc` instead of `musl`'s allocator in test builds, and disable core dumps for deliberate-abort tests.
  - *Result:* Arm unit tests dropped to about a quarter of their prior time, x64 dropped under half, and one abort group became near-instant.
- **Run the suite against the shipped profile.** We dropped a duplicate debug-profile execution of the same test cases that cost several times the release-profile run. Because this also removed debug-only overflow checking, we recorded it as an explicit coverage tradeoff. Always compare profile settings before treating two runs as equivalent, and retain separate checks where profile differences matter.
- **macOS:** A single 6-vCPU Apple-silicon runner builds and tests both architectures, running x64 under Rosetta.
