[Guide](../README.md)

# 1. Principles

These eight rules shape every decision in the rest of the guide:

- **Terms used throughout:**
  - A *shard* is one job's slice of the test suite.
  - The *critical path* is the longest chain of dependent jobs and steps from trigger to required result.
  - A *sweep* is a scheduled run on `main` that checks everything PRs left out.
  - A *covered-only* test runs on a PR only when the PR touches one of the source paths it declares.
- **Measure before changing CI.** Price recent runs by job and event, identify the critical path, and find the file that finishes last in the slowest shard. Several of our "obvious" wins measured at zero, while several boring changes delivered the biggest gains.
- **Keep the four timing and cost metrics separate—and always say which one moved:**
  - *test-seconds* (summed across files) show where the actual work lives;
  - *test-matrix wall time* (set by the slowest shard) is how long the tests take;
  - *end-to-end time* (trigger to required result along the critical path) is what people wait on, and it often ends on lint, packaging, or queueing rather than a test shard;
  - *billed units* are what you pay: on a provider that rounds each job up to whole minutes and bills per vCPU (such as Blacksmith), rounded minutes × vCPUs; on GitHub-hosted runners, rounded minutes at each runner SKU's rate. Keep raw runner minutes, list-price projections, and actual billed usage distinct.
- **A draft runs nothing; marking ready starts one run.** That single run answers "can this merge?" This is our trigger policy—on a repo with a different policy, evaluate the switch separately and measure the work it actually avoids.
- **Assign every expensive check a deliberate tier:** PR, PR-only-when-covered, scheduled sweep, or release (for platform builds and artifact checks only a release can do). Anything deferred off PRs must still block shipping.
- **Never trade proof for speed.** Never add a retry to a test, raise a timeout by itself, or skip a test to save time. A faster test must still fail when you break what it guards. Our one recorded exception is in section 7. (CI's single in-process retry exists to *detect* flakes—every recovery is recorded. Because it also lets a retry-recovered test leave the gate green, treat turning it on as a separate policy decision, not an automatic part of adding records.)
- **Code is the source of truth.** When docs and code disagree, the code is right—fix the doc in the same change.
- **Record what was tried.** A measured-and-dropped idea only comes back with new numbers.
