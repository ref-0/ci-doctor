<!--
What: the exceptions when reading a PR's CI result, and the Verification comment's format.
Where: read by an agent whose PR's run failed for a reason outside its change, or before merging.
Configure: the gate job's name and what it reads, in your repo's `.agents/repo/ci.md`.
Reference implementation from a production monorepo; adapt to your repo.
-->

# CI result and exceptions

Part of the hub's [triage](TOPIC.md) topic. The gate is the job `.agents/repo/ci.md`'s Entry points and gate names.

## Exceptions

- **The review isn't on record.** Where the gate reads the [review record](../../../review-gate/references/record.md), it reads the comments and body last. Post the comment or add the line. Where ci.md says the repo reruns the gate for a new record, it does so when the gate was the run's only failed job. If another job failed too, fix or rerun that one with `--failed`, and the gate reruns with it.
- **A failure outside the PR's files.** Check the base's latest run before blaming the PR. Tell a test failure from a runner or infrastructure one (a lost runner, a full disk, a network or quota error): an infrastructure failure isn't a flake, and goes to whoever owns the runners. For a test failure, rerun the failed job once with `--failed`, if the repo's policy allows. A test that fails and then passes on the same revision and configuration is a flake: handle it as [`fix-flaky-test`](../../../fix-flaky-test/SKILL.md#retries-reruns-and-infrastructure) says. The PR can merge on the rerun's result. A second failure isn't a flake until shown otherwise: stop and report it.
- **A flake in the PR's own files.** When a test the PR adds or changes passes only on its retry, it's likely the PR's own. Fix it before the PR merges, and prove the fix locally with no retries and a mutation, as [`fix-flaky-test`](../../../fix-flaky-test/SKILL.md#prove-the-fix) says.

## Does this run count

GitHub doesn't promise the order runs start in, and `gh run rerun` reuses the run's original merge ref. Decide by what the run tested:

| The run | Then |
| --- | --- |
| Tested an older head than the PR's current one | Find the run on the current head. If none started, mark the PR draft and ready again (or push, where the repo runs on every push); don't rerun the old one. |
| Was cancelled, or failed only by being cancelled, on the current head and base | Rerun it, if the repo's policy allows reruns. |
| Passed on the current head, and the base has moved since, with no conflict | It counts, unless the repo requires branches to be up to date. Recheck ci.md's checks tied to the tested base against the new base; if one fails, or the repo requires it, update the branch (`gh pr update-branch <pr> --repo <org>/<repo>`) and use the new run. |
| The base moved and the PR now conflicts | Update the branch, resolve, push, and use the new run. |
| Ran in a merge queue | Only the queue's run on its own SHA counts for the merge. |

Read the run's plan, and ci.md's Selection and tiers, to see what waits for a later tier. Failures there are still yours.

## The Verification comment

Post one comment that starts with `Verification:`. Name the run, the PR's head and the `main` it merged, each job's result, the test and file totals, and what didn't run and why:

```md
Verification: CI run <run-id> on `<head-sha>`, merged into `main` at `<main-sha>`, passed.

- Plan: types and tests for `<server-package>`, and the sandbox tests.
- Build and generated files, and Format, lint and types: passed.
- Tests 1/3 to 3/3: passed. <n> files, <n> tests.
- Sandbox, <n> jobs: passed. <n> files, <n> tests.
- Review: the session at `<short sha>`; changed since: `<what, or nothing>`.
```

ci.md says which jobs' summaries, on the run's page, hold their test totals and every failing test.
