[Guide](../README.md)

# 1. Principles

- **Words used throughout.** A *shard* is one job's share of the tests. The *critical path* is the longest chain of dependent jobs and steps from trigger to the required result. A *sweep* is a scheduled run on main that checks what PRs left out. A *covered-only* test runs on a PR only when the PR touches the source paths it declares.
- **Measure before changing CI.** Price recent runs by job and event, name the critical path, and find the file that ends the slowest shard. Several of our "obvious" wins measured as zero; several boring ones were the biggest.
- **Several different numbers:**
  - *test-seconds*, summed over files, says where the work is;
  - *test-matrix wall time*, set by the slowest shard, is how long the tests take;
  - *end-to-end time*, trigger to required result along the critical path, is what people wait for, and it can end on lint, packing or queueing rather than a shard;
  - *billed units* are what you pay: on a provider that rounds each job up to whole minutes and bills per vCPU (Blacksmith), rounded minutes × vCPUs; on GitHub-hosted runners, rounded minutes at each runner SKU's own rate. Keep raw runner minutes, a list-price projection and your actual billed usage apart.
  Say which one moved.
- **A draft runs nothing. Ready starts one run.** That run answers "can this merge?". This is our trigger policy; on a repo with another, evaluate the change separately and measure the work it avoids.
- **Every expensive check gets a deliberate tier:** PR, PR-only-when-covered, scheduled sweep, or release for the platform builds and artifact checks only a release can do. Deferred coverage must still block shipping.
- **Never trade proof for speed.** No retry added to a test, no timeout raised alone, no test skipped to save time. A faster test must still fail when you break what it guards. Our one recorded exception is in section 7. (CI's one in-process retry exists to *detect* flakes: every recovery is recorded. It also lets a retry-recovered test leave the gate green, so it's a policy to approve on its own, not part of adding records.)
- **Code is the source of truth.** When docs and code disagree, the code is right and the doc is fixed in the same change.
- **Record what was tried.** A measured-and-dropped idea comes back only with new numbers.
