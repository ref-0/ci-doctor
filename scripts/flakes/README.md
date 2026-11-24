# Flakes: one issue per flaky test

With the in-process retry on, CI retries a failed test once, so a flake doesn't turn a run red. That retry changes what the gate accepts, so it's its own approved change, never part of adding timing records, and it starts off. The retry is never hidden: every recovery is recorded. Issues are filed or updated subject to the per-run cap and the job roll-up rule, and the daily health check closes one once the test has been quiet long enough. A test-level retry, a rerun of a failed job and a runner or infrastructure failure are three different things: the report names each apart. Why, and the thresholds: [guide section 11](../../docs/pages/11-flakes.md). The records it reads: [guide section 13](../../docs/pages/13-records-evidence-of-what-ran.md).

## Files

| File | What it does | Where it runs |
| --- | --- | --- |
| `flake-issues.ts` | Reads every test job's flakes file, from every attempt of the run. Opens or comments on `Flaky: <file> › <test>`, or `Flaky job: <job>` when a failed attempt names no test or more than 5. Each issue body keeps a tally in `<!-- ci-flake {...} -->`. Three occurrences in 7 days raise it to `P1`. On a pull request it notes when the branch changed the test's file. A closed issue stays closed when the run's commit predates the fix. At most 10 issues per run. | CI's final aggregate job, every attempt |
| `flake-issues.test.ts` | Tests for the filing, the marker, hot and quiet rules, and the fix check. | Anywhere |
| `records.ts` | The `ci-record ` log lines (`tests` and `plan` records), decoded with plain checks. | Imported here and by `../budgets/`, `../sweeps/`, `../reuse/` |

The reporter that writes the flakes file and the `tests` records is [`../records/test-record.ts`](../records/test-record.ts). Set `TEST_FLAKES_FILE` for it. The two must share the `ci-record ` prefix.

**Closing.** `../budgets/ci-health.ts` closes an issue after at least 7 quiet days **and** 50 qualifying clean executions of its file, or 7 clean executions for sweep-only files (`sweepOnly`) and job-level issues. Both conditions hold together. A run is clean when its records show the file passed with no retry. Records hold only files that really ran, so a cache replay counts as zero.

## Wire it in

Set it up only once the user approves the plan, and the test retry as its own approval ([ci-doctor, "Before approval"](../../skills/ci-doctor/SKILL.md#before-approval-read-only)). [`templates/github/workflows/ci.yml`](../../templates/github/workflows/ci.yml) wires all of it, with the retry off until the repository variable `CI_TEST_RETRY` is `1`; the steps below are the parts.

1. In each test job, turn on the reporter (see [`../records/README.md`](../records/README.md)) and, once approved, one retry. Write the flakes file outside the checkout, then save it when it exists. `hashFiles()` only sees files inside the workspace, so test for the file in the shell instead:

   ```yaml
   env:
     TEST_RETRY: ${{ vars.CI_TEST_RETRY || '0' }}
     TEST_FLAKES_FILE: ${{ runner.temp }}/test-flakes.jsonl
     # The job's display name on the run's page, shard included. It must match what the Actions
     # jobs API returns, which the collectors and flake-issues.ts filter by.
     CI_JOB: Tests ${{ matrix.shard }}/${{ needs.plan.outputs.shard_count }}
   steps:
     # ... the tests ...
     - id: cache
       if: ${{ always() }}
       uses: ./.github/actions/ci-cache # exposes the Actions cache's address and token
     - name: This job's flakes
       if: ${{ always() }}
       env:
         CI_CACHE_URL: ${{ steps.cache.outputs.url }}
         CI_CACHE_TOKEN: ${{ steps.cache.outputs.token }}
         KEY: test-flakes-${{ github.run_id }}-${{ github.run_attempt }}-tests-${{ matrix.shard }}.jsonl
       run: |
         [ -s "$RUNNER_TEMP/test-flakes.jsonl" ] || exit 0
         node scripts/shards/ci-cache.ts save "$KEY" "$RUNNER_TEMP/test-flakes.jsonl"
   ```

   An artifact named the same way works too. The Actions cache costs no artifact storage. [`ci-cache.ts`](../../skills/ci-runners/scripts/ci-cache.ts), from the `ci-runners` skill and copied to `scripts/shards/` with its shard scripts, saves and restores by exact key, with the [`ci-cache` action](../../templates/github/actions/ci-cache/)'s outputs.

2. In a job after the result (`ci.yml`'s `report`, so the required result keeps read rights only), restore every job's file for every attempt so far into one folder with the same `ci-cache` outputs (`ci.yml`'s "The run's flakes" step), then file:

   ```yaml
   - name: File the flakes
     id: file-flakes
     if: ${{ !cancelled() }}
     continue-on-error: true
     env:
       GH_TOKEN: ${{ github.token }}   # issues: write, actions: read, contents: read, pull-requests: read
       EVENT: ${{ github.event_name }}
       PR: ${{ github.event.pull_request.number }}
       BRANCH: ${{ github.head_ref || github.ref_name }}
       SHA: ${{ needs.plan.outputs.sha || github.sha }}
       SWEEP: ${{ inputs.sweep }}
     run: node scripts/flakes/flake-issues.ts "$RUNNER_TEMP/flakes"
   - name: Filing the flakes failed
     if: ${{ !cancelled() && steps.file-flakes.outcome == 'failure' }}
     run: echo "::warning title=Flakes not filed::Read this job's log." | tee -a "$GITHUB_STEP_SUMMARY"
   ```

   Filing warns but never fails the run. Before you rely on it, make a synthetic retry recovery on a branch (a test that fails once, then passes) and check it reaches its issue.

3. Have the plan job print its `plan` record. The jq step is in the header of `records.ts`. The bisect and merge-pass promotion read it, and so do the records collectors.

4. Set `CONFIG` in `flake-issues.ts`: the labels, `resultJob`, the `sweepOnly` pattern, and `proofOf`. `proofOf` is the run-by-hand command each issue suggests to prove a fix.

## Placeholders

| Placeholder | Where | What to put |
| --- | --- | --- |
| `<org>`, `<repo>` | `proofOf` in `flake-issues.ts` | Your GitHub owner and repo |
| `<branch>` | `proofOf` | Left for the reader: the fix's branch |
| `heavy_file`, `test_paths`, `repeat` | `proofOf` | Your CI workflow's `workflow_dispatch` inputs for one heavy file, test paths, and repetitions |
