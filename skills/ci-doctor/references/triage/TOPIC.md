<!--
What: reading a PR's CI result: which job failed and why, whether the run counts, and where each kind of failure goes.
Where: read by any agent whose PR's check failed or was cancelled.
Configure: your repo's facts file, `.agents/repo/ci.md`, from agent-knowledge/repo-facts/ci.md.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Triage: a PR's CI result

Part of the [`ci-doctor`](../../SKILL.md) hub. Read `.agents/repo/ci.md` first, where the repo has one: its Entry points and gate names the workflow and its gate job, and its Selection and tiers says what a PR's run checks and what waits. `<org>/<repo>` below is your repo's slug. This page reads a run's result. Readying, rerunning by hand and merging belong to `ci-merge-workflow`, if the repo adopted it; otherwise to the repo's own merge path.

**Check:** [check what CI ran](../checks/check-what-ci-ran.md).

## Read the result

```sh
gh pr checks <pr> --repo <org>/<repo>
gh run view <run-id> --repo <org>/<repo> --log-failed | grep -E "FAIL|Error|Test Files|Tests  "
```

Wait with `--interval 60`, or your harness's PR watcher: every run on one login shares 5,000 API calls an hour, and `gh run watch` polls every 3 s by default.

1. **Did the run test the PR's current head, against its target?** If not, it doesn't decide anything: [does this run count](ci-result.md#does-this-run-count).
2. **Which job failed, and on what line?** Read the failed log, not the summary. A failure in setup, install or a cache step is the workflow's, not the tests'.
3. **Is the failure the PR's?** Check the base's latest run before blaming the PR. A failure outside the PR's files goes by [CI exceptions](ci-result.md#exceptions).
4. **Which of three is it?** A test that passes only on its in-job retry, a failed job that passes on one rerun, and a runner or infrastructure failure (a lost runner, a full disk, a network or quota error) are three different things; [flakes](../speed-up-tests/references/flakes.md#retries-reruns-and-infrastructure) says what each gets.

## Then

| It's | Go to |
| --- | --- |
| A real failure in the PR's code or tests | Fix it locally, by file, and push |
| A flake | [speed-up-tests](../speed-up-tests/TOPIC.md) |
| The workflow: setup, install, caches, the job graph | [ci-workflows](../ci-workflows/TOPIC.md) |
| A runner or infrastructure failure | Whoever owns the runners; [ci-runners](../ci-runners/TOPIC.md) |
| Green, and ready to merge | `ci-merge-workflow`, if adopted |
