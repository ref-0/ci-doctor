[Guide](../README.md)

# 20. Thresholds cheat sheet

Look up the starting values we used for slow files, shards, budgets and flakes, as examples to derive your own from.

Our starting values, as examples from one repo. Don't adopt them as targets: derive yours from your own bottlenecks and comparable runs.

| Setting | Value |
|---|---|
| Slow test file | > 10 s in CI |
| Split a file | > ~90 s, by subject (ordinary shard files; container files have a 10-minute file timeout) |
| Shard target | 75 s of tests per worker, 6 workers, ≤ 16 shards |
| Shard length | ≤ ~2 min elapsed including setup, on a provider that rounds per job; p95 warning at 110 s |
| Full PR run / small run budget | 5 min / 3 min |
| Job budget | p95 + 15%, rounded up to 5 s |
| Small runner | `server_files + other/10 ≤ 6` → 2 vCPU, 2 workers |
| Work stealing | ~50% of estimated work fixed; queued batches of whole groups summing ~60 s of estimated work |
| Near-selection fan-in cutoff | 20 importers |
| Rust pass reuse window | 30 h (sweep refreshes at 20 h) |
| Flake priority bump | 3 in 7 days |
| Flake close | ≥ 7 quiet days and 50 clean executions (7 clean executions for sweep-only and job-level issues) |
| In-CI retry | 1, in-process; 0 locally and in proof repeats |
| Runner resize | Only when 3 runs agree on CPU |
| Re-estimate container test time | Off by > 20% |
| Local test slots | `max(2, floor(cores / 4))`, unless `TEST_SLOTS` is set |
| Wait hints | Files > 10 s |
| Like-for-like noise band | ~±40% on single comparisons in our CI; measure your own |
| Records collector | ≤ 1,500 API calls a night, counted as made; keep 1,000 spare |
| Startup gate | Bytes allocated at module load, 15% over the measured value, for each deploy bundle; CPU only as a gross ceiling |
| Build-once fixture | Only where setup is at least ~⅓ of the file's time |
| Unix socket path | ≤ 107 bytes on Linux, ≤ 103 on macOS: check before binding |
| Interactive proof wait | Completion evidence, polled every 0.2 s; stillness only for the first prompt, or as a logged fallback after 20 s |
| Persisted-wait replay test | First pass sleeps 10 min, replay 1 s |
