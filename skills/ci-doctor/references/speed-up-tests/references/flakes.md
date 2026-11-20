<!--
What: how to find a flaky test's cause, fix it, prove the fix and record it.
Where: read by an agent when a test fails sometimes or passes only on a retry.
Configure: your repo's `.agents/repo/ci.md` says whether CI retries and files flakes itself, and its one
verification policy for a flake's fix.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Flakes

Part of the [`speed-up-tests`](../TOPIC.md) topic. Read it when a test fails sometimes, or passes only on a retry. [guide section 11](../../../../../docs/pages/11-flakes.md) describes the automation that files and closes flake issues. This page owns intermittent failures; a property test's seeds and replay are [`proof-tiers`' properties](../../../../proof-tiers/references/properties.md#findings-and-replay).

## Retries, reruns and infrastructure

Three different events, each reported apart. The repo's policy for each is in `.agents/repo/ci.md`'s Flaky tests; keep the repo's current gate behaviour until the user approves a change.

- **An in-job test retry:** the test runner reruns a failed test inside the job, where the repo turns that on. A pass on the retry is recorded as a flake and doesn't turn the job red, so turning retries on changes what the gate accepts.
- **One diagnostic job rerun:** a failed job rerun once with `--failed`, on the same revision and configuration. A test that failed and then passed that way is a confirmed flake.
- **A second failure:** the rerun failed too. It isn't a flake until shown otherwise: stop and report it to whoever briefed you, with both runs.

A runner or infrastructure failure, such as a lost runner, a full disk, a quota or a network error before any test ran, is none of these: it isn't a flake, and goes to whoever owns the runners.

For a confirmed flake, use the issue CI filed for it, or, where CI didn't file one, log this first sighting yourself, as below.

## Find the cause

- **Explain the spread with a mechanism.** A mail test's time spread several-fold because its limiter's window followed the wall clock's minute. Without a mechanism, it's a hypothesis, and load is one too.
- **Seen only in CI?** Load the machine as CI's runner is loaded: on Linux, pin the one test to two cores with `taskset`, with busy loops beside it, and run it about 30 times. Keep console output, since a JSON reporter swallows it. Then force each candidate order to prove the cause.
- **Can't reproduce it? Add what the next failure needs to say:** the read's result, the watch's state, the step a hang stopped at. Don't raise the bound.
- **Reproduce it outside the stack.** A standalone reader that paused before the last body bytes isolated a fetch library's bug from the local runtime. Then vary the protocol, such as length, chunked, close-delimited or 304, not just the failing case.
- **Try the fix against what it might bring back.** Removing a per-request socket reset failed half of another file's tests, so the fix went where the bug was.
- **A randomized failure: replay its exact inputs and environment,** at the exact seed, count and versions, to tell a counterexample in the code from a nondeterministic harness, then against the oracle, before choosing which is wrong. A queue's oracle removed an entry by position while the server settled by ID. Git aborted on a rename limit below -1, so the code was made to refuse it too.
- **Pin the oracle** to the version the code copies, not the one on `PATH`.
- **Make the generator reach the fault.** Among other settings, a bad one refused first and hid the fault; a generator for the setting alone found it.
- **Raise a property's timeout only by its count:** measure one case, then allow the count times that, with room for the sweep's slower runner.
- **Teardown can land after a reset.** An unmount's last read arrived after the counters were reset and satisfied the retry's check. Drain it, then reset.
- **A retry must start clean** of what the first attempt left in a shared fake or database: names, holds, rows.
- **A job failure that names no test** is a file-level hook's error, such as a network guard in `afterAll`: read the file's own output.
- **A fixture that writes one state in several calls** lets a background job, such as an alarm, act between them on a half-written state. Write what the rest refers to first. A throttle in the code can make a faked state impossible too: wait it out, don't fake past it.
- **Don't change product code for a test's fault.** Fix the fixture, the oracle or the teardown. If the cause is a production bug, fixing the production code is in scope.

## Match the symptom

Cases from the source repo, each forced on purpose before it was fixed. [guide section 11](../../../../../docs/pages/11-flakes.md#cause-symptom-fix) has each with what the forced runs showed.

- **`ETXTBSY` starting a program a test just copied in** → another test forked a child while the copy was open for writing, and the child holds the descriptor until its exec → every start in the process takes the copy's lock; where the test process can't fence every start, copy with a child `cp`. Trace inherited descriptors (`ls -l /proc/<pid>/fd` in the parked child) and force the interleaving: ordinary runs rarely show it.
- **A vanished `.git/objects/maintenance.lock`, or `ENOTEMPTY` removing a test repo** → Git's detached auto maintenance, started by a commit, fetch, merge or push, still writing → `-c maintenance.auto=false -c gc.auto=0` on the fixture's commands, or in the repo's config where a server-side Git reads that instead. Confirm with `GIT_TRACE` (the start) and `strace -f` (the child's writes) first.
- **`listen EINVAL`, or a fixture that waits out the test's timeout, only with a long `TMPDIR`** → the socket path is past 107 bytes (Linux) or 103 (macOS), and the fixture ignored the server's `error` event → socket homes under a short root, a length check, and a setup that fails on `error`.
- **A fixture server still running after an interrupted run** → it runs in its own session, out of the group kill's reach → it exits on EOF of a pipe only the test process holds. Prove it with a `SIGKILL` to the run's process group mid-file.
- **`EPIPE` or `ECONNRESET` from a call that should be refused** → the test bridge carries the body and the answer on one exchange, and the server answered while the body was still being sent → the fake drains the body before answering; check production's transport first ([Workers](workers.md#a-refused-upload-through-the-local-proxy)).
- **A non-gating reporting step does nothing, and the run is green** → an earlier sparse checkout in the workspace left the step an empty tree, and `continue-on-error` hid it → each sparse checkout in its own folder, a test that the step's files exist, and a warning from the step's `outcome` ([check a CI change](../../ci-workflows/references/change-checks.md#a-step-that-must-not-gate)).
- **An install that fails with only "see log for details"** → the installer's own log stays on the runner → print it on failure only ([triage](../../triage/TOPIC.md#an-installer-that-says-only-see-the-log)).

## Prove the fix

Prove the cause locally: the whole file repeated with no retries, noting how many passed in a row and the load average, and a mutation that reopens the race and fails the test. Then:

- **The PR's own ready run is the CI evidence.** It runs once. A flaky failure in it gets one diagnostic rerun; a second failure is reported, as [above](#retries-reruns-and-infrastructure) says.
- **An extra CI repeat needs a reason and a yes:** a specific question a local run can't answer, such as a failure seen only on CI's runners, and the approval of whoever briefed you, as [manual runs](../../../../ci-merge-workflow/references/manual-runs.md) says. A repeat of no-retry runs then also measures the failure rate: a test that failed 1 in 10 repetitions passes 50 in a row by chance about 1 time in 200.
- **The PR body** gives the local count and load, the mutation, and `Closes #<n>`.

A pull request that closes the issue by hand still has to hold: the next occurrence reopens it.

## When CI files a flake itself

Where the repo's CI retries a failed test and files an issue for each flake, a flake doesn't turn a run red, and the run that hits one files it or comments on its issue, within the per-run cap and the job roll-up its flake script names. So when your pull request's run passed with a flake, or a rerun passed a job that failed, read the issue the run filed; if the cap or a roll-up left it unfiled, log it as below. When the comment says the pull request changes the test's file, the flake is likely the pull request's own: fix it there before it merges.

## A flake CI doesn't file

Log a confirmed flake yourself the first time you see it, not the second: two threads that each see it once never file it otherwise. That covers a test that fails and then passes on a run with no retry, such as a Rust test, or one you saw on another machine. Search the `flake` issues, closed ones too, for the test's file:

```sh
gh issue list --repo <org>/<repo> --label flake --state all --search "<the test file's name>"
```

If one covers it, comment with the run's link, the commit, the job and the failing line, one comment a sighting, so its comments count how often it fails. Reopen it if it's closed, since its fix didn't hold. Otherwise open one that names the run it came from.

A race you find in the repo's own code, such as two writes landing out of order, goes the same way, labelled `bug` without `flake`, even before a test fails on it.
