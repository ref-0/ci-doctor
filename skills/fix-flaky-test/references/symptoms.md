<!--
What: flaky tests' symptoms, each with the cause to check, the fix, and how to force it.
Where: read by an agent with a flaky failure's exact error, before it looks for a cause of its own.
Configure: nothing.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Match the symptom

Part of the [`fix-flaky-test`](../SKILL.md) skill. Cases from the source repo, each forced on purpose to prove its cause, then fixed in the fixture rather than retried around. Match the symptom first, then check the cause before taking the fix. [Guide section 11](https://ci-doctor.ref0.dev/guide/docs/pages/11-flakes.md#cause-symptom-fix) has each with what the forced runs showed.

These apply when a fixture forks, spawns, binds a socket, runs Git or uploads a stream, or a CI step reports without gating.

- **`ETXTBSY` starting a program a test just copied in** → another test forked a child while the copy was open for writing, and the child holds the descriptor until its exec; a rename onto the path doesn't help, since the leaked descriptor holds the inode → every start in the process takes the copy's lock, readers' starts included; where the test process can't fence every start, copy with a child `cp`, so the test process never holds it open. **Force it:** trace inherited descriptors (`ls -l /proc/<pid>/fd` in the parked child) and fork while the copy is open: ordinary runs rarely show it on either side.
- **A vanished `.git/objects/maintenance.lock`, or `ENOTEMPTY` removing a test repo** → Git's detached auto maintenance, started by a commit, fetch, merge or push, still writing after the command returned → `-c maintenance.auto=false -c gc.auto=0` on the fixture's own commands, or in the repo's config where a server-side Git reads that instead; a test about maintenance keeps it on. **Force it:** `GIT_TRACE` shows the start and `strace -f` the child's writes; a loop that makes and removes the lock after the commit fails the test every time.
- **`listen EINVAL`, or a fixture that waits out the test's timeout, only with a long `TMPDIR`** → the socket path is past 107 bytes (Linux) or 103 (macOS), and the fixture ignored the server's `error` event → socket homes under a short root, removed when the test ends, a length check before binding, and a setup that fails on `error`. **Force it:** run with a long `TMPDIR`.
- **A fixture server still running after an interrupted run** → it runs in its own session, out of the group kill's reach, and a killed worker ran no cleanup → it exits on EOF of a pipe only the test process holds. **Force it:** `SIGKILL` the run's process group mid-file, then check nothing is left.
- **`EPIPE` or `ECONNRESET` (`fetch failed`) from a call that should be refused** → the test bridge carries the body and the answer on one exchange, and the server answered and closed while the body was still being sent → the fake drains the body before answering, and the test keeps asserting the refusal; check production's transport first ([Workers](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/speed-up-tests/references/workers.md#a-refused-upload-through-the-local-proxy)). **Force it:** a slow upload.
- **A non-gating reporting step does nothing, and the run is green** → an earlier sparse checkout in the workspace left the step an empty tree, and `continue-on-error` hid it → each sparse checkout in its own folder, a test that the step's files exist after the last checkout, and a warning from the step's `outcome` ([check a CI change](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/ci-workflows/references/change-checks.md#a-step-that-must-not-gate)).
- **An install that fails with only "see log for details"** → the installer's own log stays on the runner → print it on failure only, and add no retry until it names the cause ([triage](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/ci-doctor/references/triage/TOPIC.md#an-installer-that-says-only-see-the-log)).
