<!--
What: the repo's flake policy this skill reads, in short, and what to do when the repo has none.
Where: read by an agent before it reruns, retries, repeats or files anything for a flaky test.
Configure: your repo's `.agents/repo/ci.md`, its Flaky tests and Verifying a flake's fix, from the template this page links.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The repo's flake policy

Part of the [`fix-flaky-test`](../SKILL.md) skill. What the gate does with a flaky test is the repo's call, so the skill reads it before it reruns, repeats or files anything.

## What the policy says

Where the repo has one, it's in `.agents/repo/ci.md`'s **Verifying a flake's fix** and **Flaky tests** (template: [`repo-facts/ci.md`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/agent-knowledge/templates/repo-facts/ci.md)). It answers:

- **In-job retries:** whether CI retries a failed test inside the job, and how many times. A pass on a retry still counts as a flake.
- **A diagnostic rerun:** whether one rerun of the failed job, on the same revision and configuration, is allowed, and who may start it.
- **A second failure:** where it goes: an issue, and to whoever briefed you.
- **Infrastructure:** what a runner, network or cache-service failure gets, which isn't a test result.
- **Filing:** whether CI files an issue for each flake itself, by which script, under what title and labels, with what per-run cap, and when the issue closes (in the source repo, 7 quiet days and 50 clean executions of the file, with cache replays counting as zero).
- **Proof of a fix:** the one way a fix is verified: in the source repo, the cause proved locally with no retries and a mutation, then the PR's own ready run, once.
- **Extra CI repeats:** how many repeats of a file a run by hand may ask for, and whose yes it needs.

## Retries, reruns and infrastructure

Three different events, each reported apart. Keep the repo's current gate behaviour until the user approves a change.

- **An in-job test retry:** the test runner reruns a failed test inside the job, where the repo turns that on. A pass on the retry is recorded as a flake and doesn't turn the job red, so turning retries on changes what the gate accepts.
- **One diagnostic job rerun,** where the repo's policy allows one: a failed job rerun once with `--failed`, on the same revision and configuration. A test that failed and then passed that way is a confirmed flake. Where the policy allows none, or there's no policy, don't rerun: report the failure and prove the cause locally.
- **A second failure:** the rerun failed too. It isn't a flake until shown otherwise: stop and report it to whoever briefed you, with both runs.

A runner or infrastructure failure, such as a lost runner, a full disk, a quota or a network error before any test ran, is none of these: it isn't a flake, and goes to whoever owns the runners.

## An extra CI repeat

- **An extra CI repeat needs a reason and a yes:** a specific question a local run can't answer, such as a failure seen only on CI's runners, and the approval of whoever briefed you, as [manual runs](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-merge-workflow/references/manual-runs.md) says. A repeat of no-retry runs then also measures the failure rate: a test that failed 1 in 10 repetitions passes 50 in a row by chance about 1 time in 200.

## When the repo has none

Ask the user once whether the repo keeps this policy elsewhere, such as a contributing guide or CI's own workflow. Until there's an answer, work to the strictest reading:

- **Add no retry and no rerun,** and don't turn either on: both change what the gate accepts. Read CI's retry settings from the workflow and the test runner's config, and report what you find.
- **Prove everything locally:** the forced interleaving that shows the cause, the whole file repeated with retries off, and a mutation that reopens the race and fails the test. Say how many runs passed in a row and at what load.
- **Treat the PR's ready run as the only CI evidence,** and a failure in it as a failure to report, with the run's link, not to rerun.
- **Start no run by hand** and no CI repeat without the user's yes.
- **File nothing automatically.** Log a confirmed flake by hand as [filing](filing.md#a-flake-ci-doesnt-file) says, where the repo uses issues.

At the end, offer to write the policy into `.agents/repo/ci.md` from the template, with the user's answers.
