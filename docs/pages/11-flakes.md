[Guide](../README.md)

# 11. Flakes

**Applies when:** CI's records show tests that failed and then passed, or jobs that passed on rerun. **Skip when:** The records show no failed-then-passed tests or jobs.

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

## Cause, symptom, fix

**Applies when:** A failure's symptom matches one below, or a fixture forks, spawns, binds a socket, runs Git or uploads a stream. **Skip when:** None of the tests start processes, open sockets or run Git.

Each case is one we hit, forced on purpose to prove its cause, then fixed in the fixture rather than retried around. Match the symptom first, then check the cause before taking the fix.

- **A writable executable crosses fork and exec.**
  - *Symptom:* a spawn fails at random with `ETXTBSY` ("Text file busy"), on a program another test just copied in.
  - *Cause:* test A holds its copy open for writing; test B forks a child at that moment, and the child inherits A's descriptor until its own exec. A closes and runs its copy, which is still open for writing in B's child. A rename onto the path doesn't help: the leaked descriptor holds the inode.
  - *Fix:* every start in the process takes the same lock the copy takes, readers' starts included. Where the test process can't fence every start, for example when it runs a server that spawns its own children, make the copy in a child process (`cp`), so the test process never holds it open. Forcing the interleaving failed every one of ten unguarded runs and none of ten guarded ones; ordinary local runs showed it on neither side, so force it before claiming a fix.
- **Git's background maintenance races the fixture.**
  - *Symptom:* a walk or copy of `.git` fails on a file that vanished, such as `objects/maintenance.lock`, or removing a test folder fails with `ENOTEMPTY`.
  - *Cause:* a commit, fetch, merge or push starts `git maintenance run --auto --detach`, which keeps writing after the command returns. `GIT_TRACE` shows the start, and `strace -f` the child's writes.
  - *Fix:* turn it off for the fixture's own commands, `-c maintenance.auto=false -c gc.auto=0`, or in the repo's config where a server-side command reads that config instead of `-c`. Scope it to the fixture: a test about maintenance keeps it on. A detached loop making and removing the lock after the commit failed both affected tests five times in five; with the fix they passed 20 in a row with retries off.
- **A socket path is too long.**
  - *Symptom:* `listen EINVAL`, or a fixture that waits out its test's whole timeout, only on machines with a long `TMPDIR`.
  - *Cause:* a Unix socket path is at most 107 bytes on Linux and 103 on macOS; a home under a long temp root leaves no room. The fixture never heard the server's `error` event, so it waited instead of failing.
  - *Fix:* socket homes under a short root, removed when the test ends; check the length before binding; fail on `error` ([section 8](08-a-cheaper-test-harness.md)).
- **A detached fixture server outlives its run.**
  - *Symptom:* a Git server, proxy or host still running after an interrupted test run, holding ports or files the next run wants.
  - *Cause:* it was started in a session of its own, so a kill of the run's process group never reached it, and a killed worker ran no cleanup.
  - *Fix:* hold a pipe to it from the test process and have it exit on EOF. Prove it by killing the group mid-file and checking nothing is left.
- **A refused upload resets the connection.**
  - *Symptom:* `EPIPE` or `ECONNRESET` (`fetch failed`) from a call that should have been refused cleanly, more often on a loaded runner.
  - *Cause:* a test bridge carried the request body and the answer on one HTTP exchange; the server answered and closed while the client was still sending the body.
  - *Fix:* the fake drains the body before it answers, and the test keeps asserting the refusal. Check how production carries the stream first: ours carried the stream and the answer separately and didn't race. A forced slow upload failed four of six runs before the fix and passed six of six after ([Workers notes](../../skills/ci-doctor/references/speed-up-tests/references/workers.md#a-refused-upload-through-the-local-proxy)).
- **A reporting step reads an empty tree.**
  - *Symptom:* a non-gating step, such as the flake filer, silently does nothing, and the run stays green.
  - *Cause:* an earlier sparse, blob-less checkout used the workspace, so the later full checkout landed on a clone already at its commit and restored nothing. `continue-on-error` hid the failure.
  - *Fix:* give every sparse checkout its own folder, test that the files each step runs exist after the last checkout, and add a step that warns in the summary when the checkout, setup or the step's own `outcome` failed. CI's time and cost didn't change.
- **An installer fails with only a summary.**
  - *Symptom:* every retry prints the same "see log for details", and the log stays on the runner.
  - *Fix:* on failure only, print the installer's own log into the job's log, so the next failure names its cause. Add no retry until it does. We had one such failure in several hundred failed-job logs; collecting the log costs nothing on a passing run.
