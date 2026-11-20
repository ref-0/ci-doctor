[Guide](../README.md)

# 20. Thresholds cheat sheet

These are our starting values from one repository. Don't copy them blindly as targets—derive your own from your bottlenecks and comparable runs.

| Setting | Value |
|---|---|
| Slow test file | > 10 s in CI |
| Split a file | > ~90 s, by subject (ordinary shard files; container files have a 10-minute file timeout) |
| Shard target | 75 s of tests per worker, 6 workers, ≤ 16 shards |
| Shard length | ≤ ~2 min elapsed including setup (on a per-job rounding provider); p95 warning at 110 s |
| Full PR run / small run budget | 5 min / 3 min |
| Job budget | p95 + 15%, rounded up to 5 s |
| Small runner | `server_files + other/10 ≤ 6` → 2 vCPU, 2 workers |
| Work stealing | ~50% of estimated work fixed; queued batches of whole groups summing ~60 s of estimated work |
| Near-selection fan-in cutoff | 20 importers |
| Rust pass reuse window | 30 h (sweep refreshes at 20 h) |
| Flake priority bump | 3 occurrences in 7 days |
| Flake close | ≥ 7 quiet days and 50 clean executions (7 clean executions for sweep-only and job-level issues) |
| In-CI retry | 1, in-process; 0 locally and in proof repeats |
| Runner resize | Only when ≥ 3 runs agree on CPU |
| Re-estimate container test time | Off by > 20% |
| Local test slots | `max(2, floor(cores / 4))`, unless `TEST_SLOTS` is set |
| Wait hints | Files > 10 s |
| Like-for-like noise band | ~±40% on single comparisons in our CI; measure your own |
| Records collector | ≤ 1,500 API calls per night (counted as made); keep 1,000 in reserve |
