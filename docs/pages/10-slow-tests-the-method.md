[Guide](../README.md)

# 10. Slow tests: the method

## Find them from CI's own records, not intuition

- **Records:** a custom Vitest reporter logs one structured record per run, with per-file duration, failures, retries and import time (section 13). For pytest, start from its own JUnit XML and durations report ([`scripts/records/`](../../scripts/records/README.md#python-tests)), and keep Python and TypeScript timings apart unless they're measured on the same basis.
- **Rank** by the **median of the newest 5 runs**, widest spread, and every test that failed or passed only on retry.
- **A file is slow past 10 s.** Small files add up: one day the 133 files at 10–45 s together held *more test-seconds than the 33 files past 45 s.* Review every file past 10 s, not the top of the list.
- **Rank two ways:** total test-seconds (where the work is) and which file ends its shard (what sets wall time). One file is never split across workers.
- **Wait hints.** A script scans files over 10 s for sleeps, polls, retries, fake clocks, long timeouts and literal periods, and batches them by area. Hints tell you where to read, not the cause.

## Name the wait before changing anything

Give each file a verdict: **slow for a wrong reason** (which), **real work**, or **unknown** (with what to measure). Then look for *shared* causes; one helper's poll can reach a hundred files. Reconcile the reviewed population against the sum of its verdicts. When the record doesn't account for every file, keep an explicit unclassified group rather than changing the denominator to make the categories add up. One of our reviews covered 198 files: 119 slow for a wrong reason, 47 real work and 24 needing measurement, which leaves 8 unclassified.

| Kind of wait | Fix that worked |
|---|---|
| A production period or retry the test inherits | Make it a **setting**: production's value deployed, a shorter one in the test harness. Keep the attempt count, doubling and final error, and shrink only the first period. Pick the test value from the window other tests need, not the smallest that passes (100 ms, not 50). Keep one test on production's value with a test clock. |
| A sleep that arranges a race | **Hold the operation the race turns on** in the fake and release it once the other side is ready. Scope the hold to the identity of the operation the assertion is about, signal that exactly that operation reached it (after any durable state it needs exists), then start the other side, and assert which call consumed it. A hold on "the next call" can be stolen by background work, and one placed too early leaves the real race unordered. Prove it: delay the other side on purpose, and the test must pass with the hold and fail without it. |
| A poll | Shorter default interval for test waits, **same ceiling**. Find every helper that overrides the default. Don't sleep one more interval after the job ends. |
| A pace or floor in production code | Find *why* it was added (`git log -S`) first. Keep it where it protects something, as a setting. Delete it where it only delays. A floor that prevents spinning stays above zero. |
| A rate limit | Test the behaviour, never the delay: the fake answers 429 when asked. Count in-flight work with holds. |
| A wall-clock window (a limiter's minute) | Count with a windowless stand-in, and keep one test on the real binding. |
| A fake clock | Fake only the APIs the waited code uses: faking `setImmediate` stopped React's and Effect's schedulers. Step it in small slices. Don't fake time around Web Crypto: the clock outran the crypto work and the test timed out on a fake 15 s before its request was sent. |
| A long file | Split by subject past ~90 s. Stop when the next split costs a harness start (measure yours) for a few seconds of tests. After splitting, replay representative production edits through both the local and CI selectors: a new file that imports only shared helpers may have no production edge. Add an explicit coverage mapping and a selector test that the relevant source edit selects it; a green direct run doesn't prove future selection. Then update proof references and timing estimates. |
| An expensive prerequisite | Cache it keyed by everything it reads. Build expensive fixtures lazily inside the suite: a skipped suite still runs its file's top-level code. |
| Transport overhead | Sending a test's SQL over one socket instead of a request per statement took 19 files from 309 to 158 test-seconds, measured locally. Preserve the caller's statement-completion and transaction-visibility semantics: our socket kept synchronous completion because clock-driven tests relied on it (section 18). |
| Real work at the size it proves | Leave it, or move it to a later tier with its covered paths. |

A wait can hide behind another: a server retry *and* an SDK's own retry loop both waited out the same outage. Trace every layer.

## Keep what each test proves

- **Never** add a retry, raise a timeout alone, or skip a test to go faster.
- **Keep both sides of every deadline:** nothing fires before it, and it fires within a bound after.
- **Break the guarded code (mutate it)** and watch the faster test fail, for the intended reason. Do it in a disposable checkout, with remote cache writes off and the test run uncached, so a replay can't stand in for the run and the altered state can't reach a shared cache. Use the repo's real test command, then restore the source and run the clean whole file with retries off. Keep the mutation out of commits and CI. In one batch, all 13 deliberate mutations failed their intended tests.
- **Time the event the test claims.** Timing a later step once let a test pass with a lock freed early, because the next request stalled too.
- **Wait for progress, not absence.** "No second restore" waits for the close retry to finish, then checks.
- **Repeat the whole file with no retry,** since a fix can break neighbours. One fix passed its target 50/50 while neighbouring cases failed; after fixing those it ran 2,400 executions clean.
- **A shortened shared setting reaches tests your run didn't select.** Find and run every reader.
- **A shorter period changes what's due.** When you lower a retry or wake period, look at helpers that run all due work: they may now run unrelated jobs too. If the test concerns one job while another must stay pending, drive exactly the selected jobs. Turn off automatic scheduling before releasing a hold when that order is part of the fixture. Recheck both the explicit-job and the automatic-wake proofs, and don't restore a delay to hide an ordering error.
- **Faster tests expose real bugs.** Shorter timing revealed a missing alarm, a lock released before waiters were notified, and fixture races. Fix the bug; don't slow the test back down.

## Measure honestly

- **Same command, field and machine** on both sides, and test time, not wall time, when setup is shared.
- **Interleave** before/after/before/after on a loaded machine, and state the load.
- **Like hours on the same files:** full-run totals swung ~50% between morning and afternoon on the same day. Compare a file with its own history.
- **Judge a file against its shard:** shards in one run differed as wholes by 1.35–1.62×.
- **A static estimate is a guess.** A code read once estimated a poll at many times what it measured. A ceiling, a cancelled hold or a step count costs no time.
- **Label models and replays as such,** and check them against real runs.
- **Report the honest outcome.** One campaign cut the total test-seconds of files past 10 s by about a quarter, but its briefs reached only 48 of 119 wrong-reason files. The report said so, and the rest was queued.
- **Separate the raw change from what the work caused.** Over the same window, untouched files also got faster (by about a fifth at the median), so part of that campaign's drop wasn't its doing. Compare a common cohort of files, count observations per file and flag sparse samples, list new and split files apart, and give the untouched files' change beside the treated ones.
- **Reconcile before declaring done.** Map every original finding to fixed, moved, justified, open or unclassified. A lower total and merged briefs don't show that the original finish line was met.
