# Records: evidence of what ran

CI's test jobs print one structured line per Vitest run into their logs. A nightly timer on a maintainer's machine collects those lines into one compressed JSON-lines file per ISO week. Two scripts then rank slow, spread-out and flaky files from that archive.

Why logs and not artifacts, and why agents never run the bulk collection: [guide section 13](../../docs/pages/13-records-evidence-of-what-ran.md). A bounded, one-time read for a baseline is a different thing: see [collecting from the API](../../docs/pages/13-records-evidence-of-what-ran.md#collecting-from-the-api-without-losing-runs). How to use the rankings: [guide section 10](../../docs/pages/10-slow-tests-the-method.md).

## Files

| File | What it does | Where it runs |
| --- | --- | --- |
| `test-record.ts` | Vitest reporter, for Vitest 4 or later. Prints `ci-record {json}` when a run ends: each file with its state and Vitest's module duration in ms (its own test time; collection is reported separately, and neither is the file command's wall time), failed tests, tests that passed only on retry (with retry count), errors outside tests, and each file's import time with its 5 slowest imports. Can also write a flakes file with error excerpts. | Every CI job that runs Vitest |
| `ci-records.ts` | Collector. Reads the record lines back from job logs with `gh`, one log zip per attempt, 6 attempts at once. One invocation stops at `--calls` API calls (1,500 by default), counting its own, and keeps 1,000 of the hour's calls in reserve. Incremental with `--out`. A record whose job log it couldn't read is marked `complete: false` and read again on the next collection. A day past GitHub's 1,000-run listing cap is listed by the hour, and a listing still short of GitHub's count is reported. `--run <id>` prints one run's attempts, to check against its page. Exits 3 when it stops at the budget. | Maintainer's machine |
| `ci-records.test.ts` | Tests for the log parsing and the zip reader. `node --test ci-records.test.ts` | Anywhere |
| `ci-records.sh` | The nightly job. Looks back 21 days, writes `<records-dir>/<YYYY-Www>.jsonl.gz` atomically, drops a truncated last line, optionally commits. Runs the collector from `<remote>/<branch>` (configurable), not a working checkout's, and passes `--repo` when set. It shares one nightly budget across the days from the calls each invocation reports it made. | Systemd user timer |
| `ci-records.service`, `ci-records.timer` | Systemd user units: 03:30 nightly, `Persistent=true`, `Nice=19`. | Maintainer's machine |
| `ci-slow-files.ts` | Ranks files, from complete records only, by the median of their newest 5 passing runs (flagging fewer than 3 as thin), widest spread, failures and retry-passes, and large runs' fresh recorded test-seconds. A run is large when its plan selected everything, or by a shard-count heuristic it labels as such; replays aren't recorded, so neither is a whole-suite time. `--sha-file` keeps a sample to chosen commits. It prints each failure's first runs as JSON `[run, event, branch, when]` arrays. Its helpers for reading records, the median and the command line are shared with `ci-wait-hints.ts`. | By hand |
| `ci-slow-files.test.ts` | Tests for the ranking, the large-run reasons, the median, the row order and reading a large records file. `node --test ci-slow-files.test.ts` | Anywhere |
| `ci-wait-hints.ts` | Lists files past 10 s with counts of sleeps, timeouts, polls, retries, fake clocks and literal periods, in TSV batches by area for parallel review. | By hand, in a checkout |
| `ci-wait-hints.test.ts` | Tests for the hint counts, the areas, the timing and the batches. `node --test ci-wait-hints.test.ts` | Anywhere |

The per-job CI time spot-check (`ci-time.ts`) belongs to the `ci-workflows` skill: see [`skills/ci-workflows/scripts/`](../../skills/ci-workflows/scripts/). It reads a recent sample of runs, from each run's latest attempt only, and prints two clocks: "checks", from the first job's start to the last non-gate job's end, and "to gate", from the first job's start to the gate's end, where there is one. Neither counts queueing before the first job. It names the job that ended last, which isn't necessarily the limiter. Its cost is started minutes times each label's vCPUs (`RUNNERS`), or billed vCPU-minutes with `--bill blacksmith`, which counts every attempt; a money total prints only when `PRICES` (label pattern, price per started minute) prices every job. Its file timings are log matches of unknown freshness. Use it to look around, not as a baseline; the baseline and the archive come from complete collection, here and in guide section 13.

## Wire it in

### 1. The reporter

Set this up only once the user approves the plan ([PROMPT, "Before approval"](../../PROMPT.md#before-approval-read-only)). Adding records changes nothing about what the gate accepts: keep the repo's current failure and retry behaviour in the same change.

In your Vitest config, add the reporter when CI asks for records. Vitest times every import anyway; the limit only says how many it reports per file, one more than the record keeps because the file itself is among them.

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

const ciRecord = process.env.CI_RECORD === '1';

export default defineConfig({
  test: {
    // 0 unless the user approved the in-process retry as its own change: with 1, a test that fails
    // then passes doesn't turn the run red, and is recorded as flaky (../flakes/).
    retry: Number(process.env.TEST_RETRY ?? 0),
    ...(ciRecord
      ? {
          reporters: ['default', 'github-actions', './scripts/records/test-record.ts'],
          experimental: { importDurations: { limit: 6 } },
        }
      : {}),
  },
});
```

A job that doesn't use the config's reporters can pass `--reporter=default --reporter=./scripts/records/test-record.ts`.

### 2. The CI job

```yaml
- name: Tests
  env:
    CI_RECORD: '1'
    # The job's display name on the run's page, shard included, as the Actions jobs API returns it:
    # the collector and ../flakes/flake-issues.ts filter by it. Not github.job, the ID every shard shares.
    CI_JOB: Tests ${{ matrix.shard }}/${{ strategy.job-total }}
    # Outside the checkout: a file in the root changes what a task cache hashes.
    TEST_FLAKES_FILE: ${{ runner.temp }}/test-flakes.jsonl
  run: pnpm exec vitest run
```

### Python tests

The reporter and collector here are Vitest's. For pytest, use the runner you have and its own reports:

- **Cases:** if CI already writes JUnit XML, read that. Otherwise propose `--junitxml=<file>` ([pytest's JUnit XML](https://docs.pytest.org/en/stable/how-to/output.html#creating-junitxml-format-files)). Its `time` per case includes setup and teardown by default (`junit_duration_report`).
- **Phases:** `--durations=0` prints every setup, call and teardown time ([profiling durations](https://docs.pytest.org/en/stable/how-to/usage.html#profiling-test-execution-duration)), so you can see a session fixture's cost.
- **These are durations, not file wall time.** Case times, session fixtures, collection and concurrent workers (`pytest-xdist`) don't sum to how long a file took. For shard balancing, time collection and each file's, or each worker lane's, elapsed time around the command itself.
- **Each observation carries** suite, path and environment, plus the SHA, run attempt, shard, skip, failure and retry status, and whether it ran or was replayed from a cache.
- **Keep them small:** a structured log line like `ci-record`'s, or a small artifact, once the user approves it.
- **Keep Python and TypeScript timings apart** unless they were measured on the same basis.

### 3. The plan's record (optional)

The collector also keeps one `plan` record per attempt: what the plan job chose. Print it from the plan job. `continue-on-error` keeps a failure here from failing the checks.

```yaml
- name: The plan's record
  continue-on-error: true
  env:
    EVENT: ${{ github.event_name }}
    PR: ${{ github.event.pull_request.number }}
    SELECTED: ${{ steps.plan.outputs.tests }} # a JSON array of what the plan chose
  run: |
    set -o pipefail
    changed=null
    case "$EVENT" in pull_request | push)
      changed=$(git diff --name-only --no-renames -z HEAD^1 HEAD | jq -Rsc 'split("\u0000") | map(select(length > 0))') ;;
    esac
    jq -nc --arg event "$EVENT" --arg pr "$PR" --arg sha "$(git rev-parse HEAD)" \
      --argjson changed "$changed" --argjson selected "${SELECTED:-[]}" \
      '{kind: "plan", event: $event, pr: ($pr | tonumber? // null), sha: $sha, changed: $changed, selected: $selected}' \
      | sed 's/^/ci-record /'
```

### 4. The nightly timer

```sh
# 1. Fill in the config block at the top of ci-records.sh (or export the CI_RECORDS_* variables):
#    the checkout, the remote and branch whose collector runs, and the repo (or set REPO in the
#    collector). Set ExecStart in ci-records.service to the script's path.
# 2. Commit and push the configured collector to that branch: the timer runs the pushed copy.
# 3. Check one run, read-only: its jobs and record counts must match the run's page.
node scripts/records/ci-records.ts --run <run-id>
# 4. Collect one day by hand, and see the week's file appear and the journal name its attempts.
bash scripts/records/ci-records.sh <YYYY-MM-DD>
# 5. Only then, with the user's yes for a new timer:
bash scripts/records/ci-records.sh install
systemctl --user list-timers ci-records.timer
journalctl --user -u ci-records.service -n 50   # check it after the first night
```

The units need `gh` signed in as a login that can read the repo's Actions logs, and Node 24 or later on `PATH`.

The nightly budget is 1,500 calls by default (`CI_RECORDS_CALLS`). Each invocation stops at the calls it's given and writes the calls it actually made (`--used <file>`), and the wrapper subtracts that real count before the next day, so retries count against the budget too. The 1,000-call reserve is separate: the collector never leaves fewer than that of the hour's calls for everything else on the login.

**Incomplete records.** An attempt whose log GitHub denied, expired or failed to send stays `complete: false`, naming the jobs in `unreadable`, and the next collection tries it again until GitHub's 90 days have dropped the logs. Leave incomplete records out of clean-run counts and timing claims, and say how many there were.

### 5. Reading the archive

```sh
gzip -dc <records-dir>/2026-W4*.jsonl.gz > records.jsonl
node scripts/records/ci-slow-files.ts records.jsonl --event pull_request --top 30
node scripts/records/ci-wait-hints.ts records.jsonl --over 10 --out batches/
```

## Placeholders

| Placeholder | Where | What to put |
| --- | --- | --- |
| `<org>/<repo>` | `ci-records.ts` `REPO`, or `repo` in `ci-records.sh` (which passes `--repo`) | The GitHub repository whose runs to read |
| `<checkout-dir>` | `ci-records.sh` | A clone of that repo, with the `remote` and `branch` the script names |
| `<records-dir>` | `ci-records.sh` | Where the weekly `.jsonl.gz` files go, ideally a private repo |
| `<project>` | `ci-records.sh` | A short name for the cache folder |
| `<ci-records-script>` | `ci-records.service` | The absolute path of `ci-records.sh` |

Also match `RECORDED_JOBS`, `PLAN_JOB` and `WORKFLOW` in `ci-records.ts` to your job names, and keep `RECORD_PREFIX` the same in `test-record.ts` and `ci-records.ts`.
