<!--
What: how to find a flaky test's cause and prove it, by forcing the order of events.
Where: read by an agent when a flake's symptom matches nothing known, or a match needs checking.
Configure: nothing.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Find the cause

Part of the [`fix-flaky-test`](../SKILL.md) skill. Read it when a flake's symptom matches none of [the symptoms](symptoms.md), or to check a match before taking its fix.

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
- **Dates embedded in fixtures expire,** which is deterministic, not flaky. Use stable dates.
- **Don't change product code for a test's fault.** Fix the fixture, the oracle or the teardown. If the cause is a production bug, fixing the production code is in scope.
