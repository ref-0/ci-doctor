[Guide](../README.md)

# History

Follow our six weeks of CI changes week by week, with what each one measured and what it cost.

1. **Week 1: CI moved to Blacksmith, with a plan job.** For a week before, checks had run only locally, with no recorded comparison. Then we packed fewer, fuller jobs: billed minutes more than halved for slightly more wall time. Sized each job from CPU use. Drafts stopped running CI.
2. **Week 2: shared bundles and Postgres templates.** Added machine-wide test slots, and an explicit-input build cache with a lint rule enforcing complete inputs.
3. **Weeks 2–3: sweeps instead of per-merge reruns.** Before, 33 merges had each rerun every sandbox file. Near selection, in replay, cut ordinary-test billed minutes ~65% and moved most PR runs from 3 shards to 1. Then macOS moved to release, and a merge-triggered fallback covered late cron.

   The sweep cadence moved several times. These steps are superseded; section 5 has today's tiers:
   - Week 2: twice-daily broad sweeps replaced broad per-merge runs.
   - Week 3: sweeps became two-hourly while PR selection narrowed.
   - Week 4: indirect proofs and replay moved to four-hour sweeps.
   - Later in week 4: a daily full sweep became the release gate.
   - Week 5: three server slots between sweeps cut the delay to detect server regressions, with the merge-triggered fallback.
4. **Week 4: cheap evidence.** Records in logs, the nightly collector and an API-call budget. Moved binaries out of artifact quota. Admission control for paid model calls. Restored the per-merge type check after two green PRs broke types together. Deterministic recording and replay stayed, and the staging-connected extension was removed; the available evidence doesn't say why.
5. **Week 4 (~20 changes): the critical path.** In our run history, full PR runs fell to well under half their wall time, and small runs to about half. We kept no matched before-cohort, so read that as an observation, not a controlled comparison:
   - time-based shards and work stealing;
   - Rust gating, pass reuse and promotion;
   - sticky disks;
   - split static and lint jobs;
   - overlapped setup;
   - the Rust allocator, tmpfs and core-dump fixes, and dropping the debug-profile Rust run (a recorded proof tradeoff, section 7);
   - budgets and the health report;
   - auto-filed flake issues;
   - the release gate.
6. **Week 5: tests as cached tasks.** The remote cache, then fixing every real-world miss: paths, salts, directory listings, env leaks. An early tiny-package cache (week 4) had no billing benefit. Broader caching became useful only after independent lanes and stable task identities, and its first full-run comparison failed our agreed speed criterion (section 6). Warm gains came with cold-path overhead, and the cold and warm results were separate observations under different load.
7. **Week 5: restore missed coverage.** Fan-in selection, generated-SDK edges, covered-only proofs, the 6-hourly server tier.
8. **Week 5: remove waits.** Holds instead of sleeps, retry periods as settings, a socket for test SQL that kept synchronous statement completion because clock-driven tests rely on it, alarm floors set after fixing ordering.
9. **Weeks 5–6: harden the plumbing.** Bounded bisect, and the standing campaign three times a week.
10. **Week 6: control records out of artifact quota.** Moving binary handoffs out of artifacts relieved the first quota outage. A later outage still failed passing shards while they saved control records, so claims, flakes and timings moved to the cache too. Trusted pass provenance and other retained artifacts remain separate quota dependencies.

**Where it landed**, as an example: across 189 successful first-attempt runs of ready PRs over one week (skipped draft runs left out), wall time had a **median ~3.2 min and p90 ~4.5 min**. That's one cohort of successful first attempts: it doesn't show queue delay, failed-attempt latency or a change measured against a matched earlier cohort. Every test file is still covered on main daily before anything ships, as a fresh run or a verified cached pass, with heavy proofs running whenever their inputs changed.
