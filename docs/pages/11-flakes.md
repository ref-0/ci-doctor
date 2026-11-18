[Guide](../README.md)

# 11. Flakes

- **Retry once, in-process.** A recovered test leaves the run green but is **recorded as a flake**. Local runs and repeat runs that prove a fix use **no retry**. Turning the retry on changes what the gate accepts, so adopt it as its own approved change, apart from adding records, and keep a test-level retry, a failed-job rerun and an infrastructure failure as three different things in reports.
- **One issue per flaky test, filed by CI.** The aggregate job reads flake records across attempts and opens or updates one issue per test.
  - It also counts a job that failed then passed on rerun.
  - At most 10 issues per run, and over 5 failing tests in one job means one job-level issue.
  - Three occurrences in 7 days raise the priority.
  - The issue notes whether the PR edited the failing file: a branch's own bug isn't a flake.
  - An old run can't reopen an issue its commit predates.
- **Record every retry recovery.** File or update issues subject to the per-run cap and the job roll-up rule above.
- **Close only after real clean runs:** at least 7 quiet days *and* 50 qualifying clean executions of the file, or 7 clean executions for sweep-only and job-level issues. Cache replays count as zero.
- **Repeat runs by hand:** 1–100 repeats over up to 10 runners, or up to 20 concurrent repeats of one container test file.
- **Rules from investigations:**
  - Split by commit first. A failure on one branch is that branch's; check the run's SHA contains the fix before calling it a recurrence.
  - Read the error, not the test name. "Memory ceiling" failures were a fetch library's body-close bug, reproduced in isolation (17/20 before, 0/20 after).
  - A pass on retry is a reason to look closer. One retry passed only because the failed attempt's teardown delivered a late read after counters reset.
  - Retries must start from fresh state: names, holds and records from the first attempt cause collisions.
  - Check the oracle, too. A randomized test's reference model was wrong, not the code.
  - Dates embedded in fixtures expire, which is deterministic, not flaky. Use stable dates.
  - Make teardown wait for its effects, and don't let a detached child outlive a process-group kill.
