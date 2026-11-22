[Guide](../README.md)

# Sharding

Split tests into shards by measured time, size runners from the work and the bill, and shorten the critical path before buying cores.

## Shards from measured time, not file count

**Applies when:** Tests run, or should run, across several shards, and each file's time on main is recorded. **Skip when:** There are no per-file times yet.

Start simple. A fixed assignment per suite, from the files' recorded times, run as an exact list through the installed test runner, and checked against the collected inventory, gets most of the balance ([`scripts/shards/`](../../scripts/shards/README.md#start-simple-a-fixed-split)). Keep test families that share fixture state together, cap the matrix by your organization's concurrency limits, and split a file that dominates before tuning the layout. Work stealing and lanes, below, are later optimizations to measure on their own.

Vitest's built-in split balances file *counts*; two shards once differed by about a quarter in test-seconds. The plan computes one split from **each file's newest timing on main** and hands it to every shard:

```text
shards = clamp(ceil(total_test_seconds / (workers_per_shard * target_seconds_per_worker)), 1, max_shards)
# ours: 6 workers, 75 s per worker, at most 16 shards
```

- **Model the overheads.** Add a per-file process overhead and a per-task-group startup cost, and **measure both in your current CI**: ours changed as the harness and the task cache changed, and the group startup came out about twice our early estimate. Ignoring them once packed 200+ tiny files into one batch that ran about three times its planned length.
- **New and split files get pessimistic estimates.** New server files take the p90 of server durations; others take their kind's median. Three new files once guessed at about a tenth of their real time landed together and made their shard the slowest by far.
- **Mind the billing cliff.** On a provider that rounds each job up to whole minutes, aim for **two minutes elapsed or less per shard, including setup**. An invented example: 14 shards that each end just under 2 minutes bill 28 shard-minutes, while 9 shards that each spill just past 2 minutes bill 27, so the faster layout costs about the same. We warn when shard p95 passes 110 s, because one extra minute across 14 eight-vCPU shards is 112 vCPU-minutes.

## Work stealing over cache-key claims

**Applies when:** Fixed shards from measured time are in place and runner speed still varies, measured on its own. **Skip when:** Fixed shards aren't in place yet.

Runner speed varies: one shard ran 1.6× the median.

- **Half fixed, half queued.** Reserve roughly half the estimated work in fixed assignments. Each shard's first group, untimed groups and explicitly pinned groups stay fixed even when that passes the target. The rest is a shared queue, slowest first, of batches formed by adding whole groups until their summed estimated work (file times plus modelled startup) reaches about 60 seconds; that's summed work, not a 60-second batch on the clock. A one-shard run uses no queue.
- **Claims are cache reservations.** A shard claims a batch by **reserving a unique Actions cache key**; the first reservation wins. In races of 10 and 20 contenders over 540 keys, each key had exactly one winner, and a claim took a fraction of a second.
- **Retries and ambiguity.** Requests have a 10 s deadline and 3 tries. **An ambiguous claim runs the batch anyway:** duplicate work beats a lost batch.
- **Reruns and coverage.** Reruns restore every attempt's claims. The aggregate fails if any batch has no owner.
- **Result:** the gap between the slowest and the median shard shrank about sevenfold.

## Independent lanes

**Applies when:** A shard runs its workers in rounds, so a lane waits for the slowest. **Skip when:** Each lane already starts its next task the moment it finishes.

Each shard runs a lane per worker, and a lane starts its next task the moment it finishes. Round-based scheduling had kept lanes busy only **43%** of the time.

## Size runners from the work and the bill

**Applies when:** Per-job CPU over at least three runs, the high tail included, shows a job sized wrongly, or tiny selections pay a big runner's minimum minute. **Skip when:** Fewer than three runs agree.

- **Small selections run on 2 vCPU with 2 workers.** "Small" means `server_files + other_files/10 ≤ 6`. In one sample 28 of 40 one-shard runs were tiny: tests took about half of each job, and setup the rest. On 8 vCPU they'd pay 4× for the minimum minute.
- **More workers isn't faster.** Nine workers on 8 vCPU took about 1.5–1.8× as long as six, and added timing failures.
- **Resize only when three runs agree.** Read per-job CPU over at least 3 runs before proposing a new size (on Blacksmith, `blacksmith jobs stats`; elsewhere, sample it in the job), and check the high tail, not just the median. On GitHub-hosted runners, start every job on the repo's existing label, and compare queue, capacity, startup and priced cost before asking for a larger runner.
- **Split static from type-aware lint.** Together they had been one of the longest jobs. Lint got 8 vCPU / 32 GB after p95 memory hit 97% of 16 GB.
- **Container tests** are packed longest-first into jobs targeting ~150 s, one file at a time, on a small runner (2 vCPU for us; size yours from its own CPU). Re-estimate a file only when it's off by more than 20%.
  - **Pack from a wall-clock measurement around the whole file command,** collection and setup included, from successful files that actually ran. Vitest's per-module duration, which our records store, leaves collection out (the records keep it separately), so it isn't that number. A sum of printed case durations is only a lower bound: if it exceeds the estimate, the estimate is low; if it's lower, that proves nothing. Don't replace estimates with case sums, and remember skipped files have no execution time.
- **Size each architecture separately.** Going to 8 vCPU halved the Arm compile but didn't help x64.
- **A lower minute price isn't better service.** Arm runners at ~37% lower minute price ran our JS tests ~30% slower, and three files failed.

## Shorten the critical path before buying cores

**Applies when:** Jobs wait for upstream jobs before starting their own setup, or test binaries run one after another. **Skip when:** The critical path is a single job's own work.

- **Overlap setup with upstream work.** Proof jobs check out and install while the pack runs, then wait for the specific "snapshot published" *step*, not the whole job. A small wait action polls the latest attempt every 5 s and fails immediately if the prerequisite fails. Proof jobs started their tests about twice as early.
- **Packing** waits for the binaries, not the Rust test suites. Waiting only orders the jobs: the Rust job still has to save its binaries and the pack job restore them, by an exact key.
- **Rust tests:**
  - Compile all test binaries first, then run independent test binaries concurrently.
  - Use tmpfs for scratch, mimalloc instead of musl's allocator in test builds, and no core dumps for deliberate aborts.
  - Result: Arm unit tests took about a quarter of their old time, x64 under half, and one abort group became near-instant.
- **Run the suite against the shipped profile.** We removed a second debug-profile execution of the same cases, which had cost several times the release-profile run. This also removed debug-only overflow checking, an explicit coverage tradeoff. Compare profile settings before treating two runs as equivalent, and keep separate checks where their behaviour matters.
- **macOS:** one 6-vCPU Apple-silicon runner builds and tests both architectures, with x64 under Rosetta.
