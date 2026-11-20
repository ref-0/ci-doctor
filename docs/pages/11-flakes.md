[Guide](../README.md)

# 11. Flakes

**Applies when:** CI records show tests that failed and then passed, or jobs that passed on rerun. **Skip when:** Records show no failed-then-passed tests or jobs.

- **Retry once in-process in CI—never locally.** A test that passes on retry leaves the run green, but is **recorded as a flake**. Local runs and repeat runs proving a fix always run with **zero retries**. Because enabling a retry changes what the gate accepts, approve it as a standalone policy change (separate from adding records), and keep test-level retries, failed-job reruns, and infrastructure failures distinct in every report.
- **File one issue per flaky test automatically.** The aggregate result job reads flake records across attempts and opens or updates one issue per test:
  - it also tracks jobs that failed and then passed on rerun;
  - it caps creation at 10 issues per run, rolling up > 5 failing tests in one job into a single job-level issue;
  - 3 occurrences within 7 days raise the issue's priority;
  - each issue notes whether the PR modified the failing file, since a branch's own bug isn't a flake;
  - an older run cannot reopen an issue whose fix commit it predates.
- **Record every retry recovery.** Log every recovery and file or update issues subject to the per-run cap and job roll-up rule above.
- **Close flake issues only after real clean runs:** require at least 7 quiet days *and* 50 qualifying clean executions of the file (or 7 clean executions for sweep-only and job-level issues). Cache replays count as zero.
- **Run manual stress repeats when investigating:** dispatch 1–100 repeats across up to 10 runners, or up to 20 concurrent repeats of a single container test file.
- **Lessons from real investigations:**
  - **Split by commit first.** A failure isolated to one branch belongs to that branch; verify the failing run's SHA actually contains the fix before calling it a recurrence.
  - **Read the actual error, not the test name.** Apparent "memory ceiling" failures turned out to be a fetch library's body-close bug, reproduced cleanly in isolation (17/20 before the patch, 0/20 after).
  - **Treat a retry pass as a clue.** One test passed on retry only because the first attempt's teardown delivered a late read after counters reset.
  - **Isolate retry state.** Each retry must start fresh—shared names, holds, or records from the first attempt create collisions.
  - **Check the oracle too.** In one randomized test, the reference model was wrong, not the production code.
  - **Use stable fixture dates.** Hardcoded dates in fixtures eventually expire; that's deterministic rot, not flakiness.
  - **Clean up completely in teardown.** Wait for teardown side effects to finish, and ensure detached child processes can't outlive a process-group kill.
