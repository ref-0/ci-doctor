[Guide](../README.md)

# 10. Slow tests: the method

## Find them from CI's own records, not intuition

**Applies when:** Test time contributes to the measured bottleneck and CI records per-file durations. **Skip when:** Per-file records don't exist yet—add recording first (section 13).

- **Collect structured records.** A custom Vitest reporter logs one structured record per run containing per-file duration, failures, retries, and import time (section 13). For pytest, start from its JUnit XML and durations report ([`scripts/records/`](../../scripts/records/README.md#python-tests)), keeping Python and TypeScript timings separate unless measured on the same basis.
- **Rank by the median of the newest 5 runs,** widest spread, and any test that failed or passed only on retry.
- **Treat any file past 10 s as slow.** Medium-slow files add up fast: on one day, the 133 files between 10–45 s summed to *more test-seconds than the 33 files past 45 s*. Review every file over 10 s, not just the top of the leaderboard.
- **Rank two ways:** by total test-seconds (where compute goes) and by which file finishes its shard last (what sets wall time). Remember that a single file is never split across workers.
- **Scan for wait hints.** A script scans files over 10 s for sleeps, polls, retries, fake clocks, long timeouts, and literal durations, then batches them by area. Hints tell you where to read—not what the root cause is.

## Name the wait before changing anything

**Applies when:** A file past 10 s—or a shard-ending file—is on the inventory. **Skip when:** The inventory is empty.

Classify every file on the list as **slow for a wrong reason** (naming the wait), **real work**, or **unknown** (naming what to measure). Then look for *shared* root causes—a single helper's poll interval can affect a hundred files. Always reconcile the reviewed population against the sum of its verdicts: if the record doesn't account for every file, keep an explicit *unclassified* bucket rather than altering the denominator. In one of our reviews covering 198 files, 119 were slow for a wrong reason, 47 were real work, and 24 needed measurement, leaving 8 unclassified.

| Kind of wait | Fix that worked |
|---|---|
| A production period or retry inherited by tests | Turn it into a **setting**: deploy production's value, pass a shorter one in the test harness. Keep the attempt count, backoff doubling, and final error; shrink only the initial period. Size the test value from the window other tests need rather than the razor-thin minimum that passes (e.g., 100 ms, not 50). Keep one test exercising production's value under a test clock. |
| A sleep used to arrange a race | **Hold the specific operation the race turns on** inside the fake and release it once the other side is ready. Scope the hold to the identity of the operation under test, signal only after that exact operation reaches it (and any durable state it needs exists), start the other side, and assert which call consumed the hold. A generic "next call" hold can be stolen by background work, and a hold placed too early leaves the real race unordered. Prove it: delay the other side on purpose—the test must pass with the hold and fail without it. |
| A polling loop | Lower the default poll interval for test waits while keeping the **same timeout ceiling**. Audit every helper that overrides the default, and never sleep one extra interval after the condition is already met. |
| A pace or floor in production code | Check *why* it exists first (`git log -S`). Where it protects real behavior, make it a setting; where it only delays, delete it. Keep any spin-prevention floor above zero. |
| A rate limit | Test the behavior, never the wall-clock delay: have the fake return `429` on demand, and count in-flight work with holds. |
| A wall-clock window (e.g., a per-minute limiter) | Count with a windowless stand-in, keeping one test on the real binding. |
| A fake clock | Fake only the APIs the waited code actually uses—faking `setImmediate` broke React's and Effect's schedulers. Advance in small slices. Never fake time around Web Crypto: the fake clock outran the crypto work and timed out at a fake 15 s before the request was even sent. |
| A long file | Split by subject once past ~90 s, stopping when another split would pay a full harness start (measure yours) for only a few seconds of tests. After splitting, replay representative production edits through both local and CI selectors: a new file importing only shared helpers may lose its production graph edge. Add an explicit coverage mapping and a selector test proving relevant edits select it (a green direct run proves nothing about future selection), then update proof references and timing estimates. |
| An expensive prerequisite | Cache it keyed by everything it reads, and construct expensive fixtures lazily inside the suite—skipped suites still execute file top-level code. |
| Transport overhead | Sending test SQL over a single socket instead of one HTTP request per statement cut 19 files from 309 to 158 test-seconds (measured locally). Preserve statement-completion and transaction-visibility semantics: our socket kept synchronous completion because clock-driven tests depended on it (section 18). |
| Real work at the scale it proves | Leave it alone, or move it to a later tier with explicit covered paths. |

Watch for stacked waits: in one case, both a server retry loop *and* an SDK retry loop waited out the same outage. Trace every layer.

## Keep what each test proves

**Applies when:** Any test is modified to run faster. **Skip when:** No tests change.

- **Never** add a retry, raise a timeout by itself, or skip a test to go faster.
- **Test both sides of every deadline:** assert that nothing fires before the deadline *and* that it fires within a bound after.
- **Mutate the guarded code to prove the test still catches breaks.** Break the production behavior in a disposable checkout—with remote cache writes off and the test run uncached so a replay can't mask it and altered state can't leak into a shared cache—using the repo's real test command, and verify the faster test fails for the intended reason. Then revert the mutation and run the whole file cleanly with retries off. Never commit or push mutations to CI. In one batch, all 13 deliberate mutations failed their intended tests.
- **Time the exact event the test claims to check.** Timing a downstream step once let a test pass even when a lock was released early, because the next request stalled too.
- **Wait for progress, not absence.** For example, "no second restore" should wait for the close retry to finish, then assert.
- **Repeat the entire file with retries off,** since speeding up one test can expose races in neighbors. One fix passed its target test 50/50 while neighboring tests failed; after fixing those, the file ran 2,400 clean executions.
- **Audit every consumer of a shortened shared setting.** Lowering a shared harness value affects tests your narrow run didn't select—find and run every reader.
- **Watch what becomes due sooner.** Lowering a retry or wake period can cause helpers that run "all due work" to execute unrelated jobs. When a test targets one job while another must stay pending, drive only the selected jobs explicitly and disable automatic scheduling before releasing a hold if ordering matters. Recheck both explicit-job and automatic-wake proofs—never restore a sleep to mask an ordering bug.
- **Fix the real bugs faster tests uncover.** Tighter timing exposed a missing alarm, a lock released before waiters were notified, and fixture races. Fix the bug rather than slowing the test back down.

## Measure honestly

**Applies when:** Reporting a before/after speedup or any timing comparison. **Skip when:** Nothing is being compared.

- **Match command, metric, and machine** on both sides, and compare test time (not wall time) when setup is shared.
- **Interleave runs** (`before / after / before / after`) on a loaded machine, and state the load.
- **Compare like hours on the same files:** full-run totals swung ~50% between morning and afternoon on the same day. Compare each file against its own history.
- **Judge a file relative to its shard:** shards within the same run varied as wholes by 1.35–1.62×.
- **Don't trust static estimates.** A code read once estimated a poll at many times its actual cost. A timeout ceiling, a cancelled hold, or a step count costs zero runtime when not hit.
- **Label models and replays explicitly,** and validate them against real runs.
- **Report the honest scope.** One campaign cut total test-seconds of files past 10 s by about a quarter, even though its briefs reached only 48 of 119 wrong-reason files. The report stated that plainly and queued the rest.
- **Separate raw change from causal effect.** Over that same window, untouched files also got ~20% faster at the median, meaning not all of the drop came from the campaign. Compare a common cohort of files, count observations per file and flag sparse samples, separate new and split files, and report the untouched cohort's shift alongside the treated one.
- **Reconcile before declaring done.** Account for every original finding as fixed, moved, justified, open, or unclassified. A lower total and merged briefs don't by themselves prove the original finish line was met.
