[Guide](../README.md)

# 19. How we got here

Here is the six-week sequence in which the system came together:

1. **Week 1 — Move to Blacksmith and add a plan job.** After a week of running checks only locally (with no recorded comparison), we moved CI to Blacksmith, packed work into fewer, fuller jobs (more than halving billed minutes for slightly more wall time), sized each job from measured CPU, and stopped running CI on drafts.
2. **Week 2 — Shared bundles, Postgres templates, and local slots.** We added shared server bundles, template-based Postgres databases, machine-wide local test slots, and an explicit-input build cache guarded by a lint rule enforcing complete inputs.
3. **Weeks 2–3 — Sweeps instead of per-merge reruns.** Previously, 33 merges had each rerun every sandbox file. Near selection cut ordinary-test billed minutes by ~65% in replay and dropped most PR runs from 3 shards to 1. We then moved macOS to releases and added a merge-triggered fallback for late cron runs.

   Our sweep cadence evolved several times (these steps are superseded—see section 5 for today's tiers):
   - *Week 2:* twice-daily broad sweeps replaced broad per-merge runs.
   - *Week 3:* sweeps moved to every two hours while PR selection narrowed.
   - *Week 4:* indirect proofs and replays moved to four-hour sweeps.
   - *Later in week 4:* a daily full sweep became the release gate.
   - *Week 5:* three server slots between daily sweeps cut detection delay for server regressions, backed by the merge-triggered fallback.
4. **Week 4 — Cheap evidence.** We moved test records into logs, added the nightly collector with an API-call budget, moved binaries out of artifact quota, added admission control for paid model API calls, and restored the per-merge type check after two green PRs broke types together. Deterministic recording and replay stayed, while the staging-connected extension was removed (the available evidence doesn't record why).
5. **Week 4 (~20 changes) — Attack the critical path.** Across our run history, full PR runs dropped to well under half their prior wall time and small runs dropped to about half (we kept no matched before-cohort, so treat this as an observation rather than a controlled benchmark):
   - time-based shards and work stealing;
   - Rust gating, pass reuse, and merge promotion;
   - sticky disks;
   - split static and type-aware lint jobs;
   - overlapped setup;
   - Rust allocator (`mimalloc`), `tmpfs`, and core-dump fixes, plus dropping the debug-profile Rust run (a recorded proof tradeoff, section 7);
   - job budgets and the daily health report;
   - auto-filed flake issues;
   - the sweep-backed release gate.
6. **Week 5 — Tests as cached tasks.** We deployed the remote cache and fixed each real-world miss source: absolute paths, command salts, directory listings, and leaked env vars. An earlier tiny-package cache (week 4) had saved zero billed minutes. Broader caching became viable only after independent lanes and stable task identities—and even then, its first full-run comparison failed our speed criterion (section 6). Warm gains arrived alongside cold-path overhead, observed separately under different loads.
7. **Week 5 — Restore missed coverage.** We added fan-in selection, generated-SDK edges, covered-only proofs, and the 6-hourly server tier.
8. **Week 5 — Remove waits.** We replaced sleeps with targeted holds, turned retry periods into settings, moved test SQL onto a synchronous socket (preserving synchronous statement completion for clock-driven tests), and tuned alarm floors after fixing ordering bugs.
9. **Weeks 5–6 — Harden the plumbing.** We added budget-bounded bisecting and the standing slow-tests campaign three times a week.
10. **Week 6 — Move control records out of artifact quota.** Moving binary handoffs out of artifacts resolved our first quota outage, but a second outage still failed passing shards while uploading control records—so claims, flakes, and timings moved to the Actions cache as well. Trusted pass provenance and other retained artifacts remain separate quota dependencies.

**Where it landed (example):** Across 189 successful first-attempt ready-PR runs over one week (excluding skipped draft runs), wall time had a **median of ~3.2 min and p90 of ~4.5 min**. Keep in mind this is a single cohort of successful first attempts—it does not capture queue delay, failed-attempt latency, or a matched before/after comparison. Every test file still runs on `main` daily before anything ships (either fresh or via a verified cached pass), and heavy proofs run on PRs whenever their inputs change.
