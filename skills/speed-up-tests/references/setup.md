<!--
What: where this skill's work starts: the repo's facts file and CI's records, or a local baseline of the named test.
Where: read by an agent before step 1 of the skill, in a repo it hasn't worked in.
Configure: your repo's `.agents/repo/speed-up-tests.md`, from the template this page links.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Start here

Part of the [`speed-up-tests`](../SKILL.md) skill. Which start fits depends on what the repo has and what was asked.

## With the repo's facts file

`.agents/repo/speed-up-tests.md` names, for this repo:

- **Records and scripts:** the command that collects CI's per-file times, and the scripts that rank them and list each file's wait hints by area.
- **Thresholds:** the triage cutoff (10 s in CI in the source repo), the window a file's time is the median of (its newest five passing runs), and the band that sends a decided file back for review (±40%).
- **Settings:** where a production period the tests inherit is read, with production's value and the test harness's shorter one.
- **Holds and fakes:** the helpers that pause an operation until a test releases it, the services answered from fakes and where those live, and what runs for real, and why.
- **Fixtures and timers:** the ID factories, how a test starts a scheduled job now, and where lease periods and timers come from.
- **What campaigns measured:** dated findings, so no one measures them again.

Read it, then start at the skill's step 1.

## With no facts file

Ask the user once whether the repo keeps these facts elsewhere. If it doesn't, work from what you find, and at the end offer to write the file from [the template](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/agent-knowledge/templates/repo-facts/speed-up-tests.md), filled with what you learned. Until it exists, say which values you assumed: the source repo's thresholds above are a start, not this repo's.

## A test that's slow locally, or no CI records

When the user names a test, a file or a suite, or CI keeps no per-file times, take a local baseline of exactly that before anything else:

1. **Run it uncached,** so no task runner or test cache replays an old pass: the runner's own command for the one file or suite, such as `vitest run <file>` or `pytest <file>`, outside any task cache (`--force`, `--no-cache`, or the runner run directly), with retries off.
2. **Five times in a row,** on an otherwise quiet machine, noting the commit, the machine and its load average. Keep each run's time and the per-test durations it prints (`--reporter=verbose`, `--durations=0`), and quote the median with its spread.
3. **Split the time:** process start and module load, the harness's setup, then each test. The tests that hold most of it are where step 2's waits are.
4. **Then name the wait,** as the skill's step 2 says, and measure after the change with the same command, on the same machine, interleaved with runs of the old code.

A local baseline is evidence for this machine only. When CI runs the test too, take CI's before and after from its own runs once the pull request is ready, as step 5 says.
