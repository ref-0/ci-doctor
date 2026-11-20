<!--
What: how to split a run's tests into shards by measured time, run them, and keep their times current; the scripts are in this skill's scripts/.
Where: read by an agent planning, wiring or changing test shards, their queue, lanes or container packing.
Configure: the placeholders at the end, and the constants each script's header names, measured on your runners.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Shards: splitting tests by measured time

Part of the [`ci-runners`](../SKILL.md) skill, which owns planning and running shards. The plan job splits the test files into shards by measured time, in whole cached groups. Each shard runs its own files in independent lanes, then claims batches from a shared queue through Actions cache keys, so a shard on a fast machine takes more of them. Container test files are packed into jobs of a target length (`JOB_SECONDS`, an example value). The ordinary tests' runner size follows from how much work the run has.

Why each piece is shaped this way: [guide section 7](https://ci-doctor.ref0.dev/guide/docs/pages/07-shards-runners-and-billing.md), in particular [shards from measured time](https://ci-doctor.ref0.dev/guide/docs/pages/07-shards-runners-and-billing.md#shards-from-measured-time-not-file-count), [work stealing over cache-key claims](https://ci-doctor.ref0.dev/guide/docs/pages/07-shards-runners-and-billing.md#work-stealing-over-cache-key-claims), [independent lanes](https://ci-doctor.ref0.dev/guide/docs/pages/07-shards-runners-and-billing.md#independent-lanes) and [sizing runners](https://ci-doctor.ref0.dev/guide/docs/pages/07-shards-runners-and-billing.md#size-runners-from-the-work-and-the-bill). Why tests are tasks: [guide section 6](https://ci-doctor.ref0.dev/guide/docs/pages/06-reuse-work-by-its-real-inputs.md#a-remote-task-cache-with-tests-as-tasks). How many shards a runner's size takes: [sizing](sizing.md#shards-against-a-runners-size).

## Where the scripts live

Every script below is in this skill's [`scripts/`](../scripts/), with its `node --test` tests, so it installs with the skill alone. They need Node 24 or later and nothing installed.

- **Before approval, read-only:** `test-shards.ts` models a split from the repo's own checkout without copying anything. From the repo's root, `node <skills-dir>/ci-runners/scripts/test-shards.ts <most> <file list> [<times.json>...]` prints the plan; it reads `git ls-files` and the files you pass, and writes nothing.
- **Once the user approves wiring it in:** copy the folder into the repo at `scripts/shards/`, less its `*.test.ts` files, as the [workflow templates' install layout](https://ci-doctor.ref0.dev/guide/templates/github/README.md#install-layout) says. The templates call each script there, and `test-lanes.ts` and `test-tasks.ts` take the repo's root as the folder two above their own. The repo then owns its copy and its values: updating this skill never touches them.
- **Their tests:** `node --test *.test.ts`, from this skill's `scripts/`.

## Files

| File | What it does | Where it runs |
| --- | --- | --- |
| [`test-groups.ts`](../scripts/test-groups.ts) | Which test files may be replayed from a task cache, and the groups they run in. CI puts one heavy-harness file in a group, or 8 other files, with 1 worker. Local runs put 4 files in a group, with 2 workers. Groups are formed from every test file in the checkout, so task names are stable. Each covered-only file (`COVERED_ONLY`, equal to the planner's `coveredOnly` keys) is a group alone, so a run that leaves it out can't run it in another file's group. | Imported by the others |
| [`test-groups.test.ts`](../scripts/test-groups.test.ts) | That a covered-only file never shares a group. `node --test` | Locally or CI |
| [`test-shards.ts`](../scripts/test-shards.ts) | The plan. The shard count is set so each shard holds `shardSeconds` per worker across `shardWorkers` workers (example values you measure for your runners), with at most the `<most>` the plan passes. It reserves roughly half the estimated work in fixed assignments, greedily onto the least-loaded shard. Each shard's first group, untimed groups and explicitly pinned groups stay fixed even when that passes the target. Queued batches are formed by adding whole groups until their summed estimated work (file times plus modelled startup, across lanes) reaches about `batchSeconds`: a target for summed work, not a promise of a batch's wall time. A one-shard run uses no queue. `--merge` combines the times of several runs. | CI plan job, and a merge-times job |
| [`test-shards.test.ts`](../scripts/test-shards.test.ts) | `node --test test-shards.test.ts` | Anywhere |
| [`test-claims.ts`](../scripts/test-claims.ts) | Claims one queue batch by reserving `<prefix>-<batch>` in the Actions cache: 200 means won, 409 means lost. It retries after 250 and 1000 ms, with a 10 s timeout. A claim that never gets an answer counts as `unsure` and runs anyway. In a test, 20 jobs raced for 540 keys and exactly one job won each key. | Each test shard |
| [`test-claims.test.ts`](../scripts/test-claims.test.ts) | `node --test test-claims.test.ts` | Anywhere |
| [`ci-cache.ts`](../scripts/ci-cache.ts) | Saves and restores small files (claims, flakes) in the Actions cache. A save is reserve, then upload, then finalize. A restore matches keys exactly and looks up 8 at a time. The CLI is `save <key> <file>` and `restore <dir> <key>...`. | Steps in CI jobs |
| [`ci-cache.test.ts`](../scripts/ci-cache.test.ts) | Runs against a cache service held in memory. `node --test ci-cache.test.ts` | Anywhere |
| [`test-tasks.ts`](../scripts/test-tasks.ts) | Turns each group into a Vite Task task: `taskName` is a hash of the group's files. It also sets the env vars that are keyed and those that aren't, and which input paths are left out (volatile caches, `dist/`, folder listings). | Imported by `vite.config.ts` when `TEST_TASKS` is set |
| [`test-lanes.ts`](../scripts/test-lanes.ts) | The runner. It starts `--lanes` lanes, each a `vp run` of one task at a time. The shard's own groups run first, then the queue's batches, claimed one at a time. It reads each task's outcome (local hit, remote hit, passed or failed) from what `vp run` printed. `--times` writes the files' times for the merge. `--no-cache` reads and writes no cache, local or remote. `--verify-hits <n>` reruns a daily-changing sample of `n` replayed tasks with no cache after a clean run, and fails if one fails or doesn't finish. | Each test shard, and locally |
| [`test-lanes.test.ts`](../scripts/test-lanes.test.ts) | `node --test test-lanes.test.ts`: outcome reading, the no-cache switch, the sample | Anywhere |
| [`container-pack.ts`](../scripts/container-pack.ts) | Packs container test files longest first into jobs of about `JOB_SECONDS`. A file with no estimate counts as `DEFAULT_SECONDS`. Both are example values. Also holds `runnerFor`, the runner-size rule, and `manualShards`, the shard count for a run by hand. | CI plan job |
| [`container-pack.test.ts`](../scripts/container-pack.test.ts) | `node --test container-pack.test.ts` | Anywhere |

## Wire it in

Set this up only once the user approves the plan ([ci-doctor, "Before approval"](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-doctor/SKILL.md#before-approval-read-only)).

### Start simple: a fixed split

Before task groups, lanes or claims, a fixed split by measured time often gets most of the gain:

1. **Inventory each suite** with the runner it uses: the exact list of test files it collects (Vitest's or Jest's list mode, `pytest --collect-only -q`).
2. **Assign deterministically.** Sort by each file's recorded time, slowest first, and put each on the least-loaded of `n` shards. Files with no time get a pessimistic estimate. Keep test families that share fixture state on one shard. Count each shard's install and collection in the model, not just its tests.
3. **Run the exact list** on each shard through the installed runner, as paths, never as a pattern or `--shard` index that the runner re-derives.
4. **Check the aggregate.** A final job compares the union of what the shards ran with the inventory, and fails on any file missing or run twice.
5. **Split a file that dominates** a shard before tuning the layout: no assignment can beat the longest indivisible file.
6. **Cap the matrix** at the organization's concurrent-job limit, less what other workflows need.

Work stealing (below) is a later, separately measured change: add it when the slowest shard still sits well past the median on runs of the same selection.

[`templates/github/workflows/ci.yml`](https://github.com/ref-0/ci-doctor/blob/v0.2.0/templates/github/workflows/ci.yml) wires all of this; the steps below are the parts, for a workflow of your own. The `ci-cache` action they use is [`templates/github/actions/ci-cache/`](https://github.com/ref-0/ci-doctor/tree/v0.2.0/templates/github/actions/ci-cache), copied to `.github/actions/ci-cache/`.

### 1. Tests as tasks

In `vite.config.ts`, load the tasks only when a runner asks for them, so an ordinary `vp` run never reads them:

```ts
const request = process.env.TEST_TASKS;
const tasks = request
  ? (await import('./scripts/shards/test-tasks.ts')).testTasks(request)
  : new Map();

export default defineConfig({ run: { tasks: Object.fromEntries(tasks) } });
```

In the test-only config each task loads (`test.config.ts`), make `include` follow `TEST_INCLUDE` when it's set, so a task's Vitest looks only for its own files.

### 2. The plan job

The template wires this whole; the snippets below are a cutout of it. Use one predicate for the ordinary tests everywhere: the workflow's `ORDINARY_TESTS`, the planner's `testFile` and `test-groups.ts`' `ORDINARY` must agree, or a file can be planned and never run. Feed the plan the selector's output, not every tracked test, when the run is a selection. File lists travel as JSON arrays end to end.

```yaml
- name: Plan the shards
  id: plan
  env:
    ORDINARY_TESTS: '\.test\.tsx?$' # what your runner discovers
  run: |
    git ls-files | grep -E "$ORDINARY_TESTS" | grep -vE '\.(sandbox|proof)\.test\.tsx?$' > "$RUNNER_TEMP/ordinary"
    files=$(wc -l < "$RUNNER_TEMP/ordinary")
    server=$(grep -c '^<server-dir>/' "$RUNNER_TEMP/ordinary" || true)
    # test-times.json: the default branch's stored times, from its sweeps and folds (see step 5).
    node scripts/shards/test-shards.ts 16 "$RUNNER_TEMP/ordinary" test-times.json > "$RUNNER_TEMP/plan.json"
    echo "plan_attempt=$GITHUB_RUN_ATTEMPT" >> "$GITHUB_OUTPUT"
    echo "shard_files=$(jq -c .shards "$RUNNER_TEMP/plan.json")" >> "$GITHUB_OUTPUT"
    echo "queue=$(jq -c .queue "$RUNNER_TEMP/plan.json")" >> "$GITHUB_OUTPUT"
    echo "shards=$(jq -c '.shards | [range(1; length + 1)]' "$RUNNER_TEMP/plan.json")" >> "$GITHUB_OUTPUT"
    echo "shard_count=$(jq '.shards | length' "$RUNNER_TEMP/plan.json")" >> "$GITHUB_OUTPUT"
    # The runner size (container-pack.ts's runnerFor): small runs on 2 vCPU with 2 lanes.
    if [ "$(jq -n --argjson f "$files" --argjson s "$server" '$s + ($f - $s) / 10 <= 6')" = true ]; then
      printf 'test_runner=blacksmith-2vcpu-ubuntu-2404\ntest_workers=2\n' >> "$GITHUB_OUTPUT"
    else
      printf 'test_runner=blacksmith-8vcpu-ubuntu-2404\ntest_workers=6\n' >> "$GITHUB_OUTPUT"
    fi
    git ls-files '*.sandbox.test.ts' | node scripts/shards/container-pack.ts --estimates <container-estimates.json> \
      | sed 's/^/sandbox_files=/' >> "$GITHUB_OUTPUT"
```

If a run by hand names paths, skip the plan and use Vitest's `--shard` with `manualShards` shards. Vitest matches a path as part of a file's path, so the plan can't know which files will run.

### 3. Each test shard

```yaml
tests:
  name: Tests ${{ matrix.shard }}/${{ needs.plan.outputs.shard_count }}
  needs: plan
  runs-on: ${{ needs.plan.outputs.test_runner }}
  strategy: { fail-fast: false, matrix: { shard: '${{ fromJSON(needs.plan.outputs.shards) }}' } }
  steps:
    - uses: actions/checkout@v6
    # ... install dependencies, and the remote task cache's env (the ci-doctor repo's scripts/local/task-cache.ts) ...
    # The cache is needed for claims, and also for flakes and times on a one-shard run.
    - id: cache
      uses: ./.github/actions/ci-cache
    - name: The batches claimed before # only on a rerun
      if: needs.plan.outputs.queue != '[]' && needs.plan.outputs.plan_attempt != github.run_attempt
      continue-on-error: true
      env:
        CI_CACHE_URL: ${{ steps.cache.outputs.url }}
        CI_CACHE_TOKEN: ${{ steps.cache.outputs.token }}
        SHARDS: ${{ needs.plan.outputs.shards }}
        PLAN_ATTEMPT: ${{ needs.plan.outputs.plan_attempt }}
      run: |
        mapfile -t keys < <(jq -r --arg run "$GITHUB_RUN_ID" --argjson plan "$PLAN_ATTEMPT" --argjson attempt "$GITHUB_RUN_ATTEMPT" \
          '.[] as $shard | range($plan; $attempt + 1) | "test-claims-\($run)-\($plan)-\($shard)-\(.).txt"' <<< "$SHARDS")
        node scripts/shards/ci-cache.ts restore "$RUNNER_TEMP/claimed" "${keys[@]}"
    - name: Tests
      env:
        CI_RECORD: '1'
        TEST_RETRY: '1'
        SHARD_FILES: ${{ join(fromJSON(needs.plan.outputs.shard_files)[format('{0}', matrix.shard)], ' ') }}
        TEST_QUEUE: ${{ needs.plan.outputs.queue }}
        TEST_CLAIMS_FILE: ${{ runner.temp }}/claims
        CI_CACHE_URL: ${{ steps.cache.outputs.url }}
        CI_CACHE_TOKEN: ${{ steps.cache.outputs.token }}
        PLAN_ATTEMPT: ${{ needs.plan.outputs.plan_attempt }}
        SHARD: ${{ matrix.shard }}
        LANES: ${{ needs.plan.outputs.test_workers }}
        SWEEP: ${{ inputs.sweep }}
        FULL: ${{ inputs.full }}
      run: |
        read -ra files <<< "$SHARD_FILES"
        batches='[]'
        if [ "$TEST_QUEUE" != '[]' ]; then
          if [ "$PLAN_ATTEMPT" = "$GITHUB_RUN_ATTEMPT" ]; then
            : > "$TEST_CLAIMS_FILE"
          else
            # A rerun runs again the batches this shard owned, and claims only what nobody claimed.
            cat "$RUNNER_TEMP/claimed/test-claims-$GITHUB_RUN_ID-$PLAN_ATTEMPT-$SHARD-"*.txt 2> /dev/null | sort -u > "$TEST_CLAIMS_FILE" || true
            batches=$(jq -Rsc 'split("\n") | map(select(length > 0) | split(" ")[0] | tonumber) | unique' "$TEST_CLAIMS_FILE")
            TEST_CLAIMED=$(cat "$RUNNER_TEMP"/claimed/*.txt 2> /dev/null | jq -Rsc 'split("\n") | map(select(length > 0) | split(" ")[0] | tonumber) | unique')
            export TEST_CLAIMED
          fi
          export TEST_CLAIMS="<project>-test-claim-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
        fi
        mapfile -t queued < <(jq -r --argjson b "$batches" '. as $q | $b[] | $q[.][]' <<< "$TEST_QUEUE")
        # A sweep checks a daily sample of replays; a full run uses no cache at all.
        cache=()
        [ "$SWEEP" = true ] && cache=(--verify-hits 3)
        [ "$FULL" = true ] && cache=(--no-cache)
        node scripts/shards/test-lanes.ts --lanes "$LANES" --times "$RUNNER_TEMP/times/results.json" \
          "${cache[@]}" -- "${files[@]}" "${queued[@]}"
    - name: Keep this shard's claims
      if: always() && needs.plan.outputs.queue != '[]'
      env:
        CI_CACHE_URL: ${{ steps.cache.outputs.url }}
        CI_CACHE_TOKEN: ${{ steps.cache.outputs.token }}
        KEY: test-claims-${{ github.run_id }}-${{ needs.plan.outputs.plan_attempt }}-${{ matrix.shard }}-${{ github.run_attempt }}.txt
      run: node scripts/shards/ci-cache.ts save "$KEY" "$RUNNER_TEMP/claims"
```

A final job restores every shard's claims file and fails the run if any queue batch has no owner, or any planned file was never run. Before you rely on it, try a one-shard run and a rerun of a failed shard, and check every planned file is accounted for in both.

### 4. Container test jobs

Pass `sandbox_files` to a matrix. Each job runs its `file` list one after another. Keep the estimates in a JSON file. Re-measure from a full run's records ([`scripts/records/`](https://ci-doctor.ref0.dev/guide/scripts/records/README.md) in the ci-doctor repo), and change an estimate only when it's off by more than 20%.

Estimate from each file's whole elapsed time, collection, imports, setup and hooks included, measured as wall clock around the command that runs the file. Neither a sum of the printed per-test durations nor the records' Vitest module duration includes all of that, so each is only a lower bound: a lower bound above an estimate proves the estimate low, but one below it proves nothing about the estimate being high. Never replace an estimate with one, and don't read a skipped or failed file as fast: neither says anything of a normal run. Apply this before the 20% rule. [Comparing before and after](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/speed-up-tests/references/measuring.md#comparing-before-and-after) says the same for a fix's timings.

Which container files a PR runs is the planner's job, not this script's: see [`templates/plan/README.md`](https://ci-doctor.ref0.dev/guide/templates/plan/README.md#container-test-reach).

### 5. Keeping the times current

Every run already balances its shards from the stored times; how fresh they are decides only how even the split is. That's a separate decision from how often the sweep runs, which decides how soon a break that PR selection skipped shows, and what a release waits for ([`ci-workflows`' tiers](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-workflows/references/tiers.md#sweep-cadence-and-shard-times-are-separate-decisions)). The sweep is the only run that times every file, so it's the natural full refresh, but no longer the only one:

- **A sweep, at whatever cadence the user picks, is the full refresh.** Save each shard's `--times` file. A small job then runs `node scripts/shards/test-shards.ts --merge <each results.json> test-times.json > new.json` and caches the result where the plan job reads it. Each file keeps its newest `keptSamples` times (3), and the plan reads their median, so one shard on a slow machine doesn't move a file.
- **Between sweeps, a fold times new files.** A pull request's or merge queue's run saves its shards' times too, and its result-side job hands them on as one small artifact named for the commit: the Actions cache is scoped by branch, so main can't read a PR run's entries, but any run can read its artifacts. On main, a job each merge already runs checks whether a fold is due: after `TIMES_FOLD_MERGES` commits or `TIMES_FOLD_HOURS` hours, whichever comes first. It then runs `test-shards.ts --merge --fold test-times.json --through <sha> <each artifact>` over every merge since the last fold's `through`. It adds only the files the stored times lack, which would otherwise run on a guess, and leaves every stored file for the next sweep. The [template](https://github.com/ref-0/ci-doctor/blob/v0.2.0/templates/github/workflows/ci.yml) wires both in `report`.
- **Two writers.** A fold that loses a race is redone by the next, since each folds everything after the `through` it read. A fold restores again just before it saves and skips the save if a newer one appeared. A sweep keeps the `through` it read, so a fold it overwrites is folded again. What's left is a second's window in which a sweep's refresh can be lost until the next sweep; every file still runs, only less evenly.
- **A file with no time** is estimated until a fold or a sweep times it: heavy-harness files at the 90th percentile of the recorded ones, other files at the median. Such files run in a shard's own share and never go into the queue.

Why only new files between sweeps, from the source repo's CI, 17 to 20 November 2026: 254 shards that replayed no task, from 12 server-test slots, one daily sweep and 50 pull request runs, 17,042 fresh times of 1,193 files.

- **One run's time is noisy.** Against its file's median, a sample fell between 0.70 and 1.58 times it at the 10th and 90th percentiles. Most of that is the machine: a shard's files ran at a median of 0.76 to 1.50 times their own medians at those percentiles, and 2.19 at the most. That's why the plan reads a median.
- **More samples didn't help past two or three.** Files were getting faster over those days (the median file ran at 0.82 of its earlier time), so an estimate from the newest 5 runs was further from the next runs' median (0.36 at the median) than one from 2 or 3 (0.25) or from 1 (0.31). On the cases all five counts could be judged on, none was clearly better: three is the fewest whose median drops one slow machine.
- **Staleness barely moved the split.** A fixed split by estimated times, judged by each run's own times, put its busiest shard 0.1% over the best split with fresh times and 0.9% over with times a day old. An equal count of files a shard was 14.6% over. Modelled at a week old, from that drift and the repo's rate of new test files (876 in 30 days, about a sixth of its files a week, run on the guess), it was 1.4% over at the median and 7.2% at the 90th percentile, and folding the new files brought the 90th percentile to 6.1%.
- **New files are the risk the model understates.** They arrive together, often split from one slow file: three such files guessed at about a tenth of their real time once landed on one shard and made it the slowest by far ([guide section 7](https://ci-doctor.ref0.dev/guide/docs/pages/07-shards-runners-and-billing.md#shards-from-measured-time-not-file-count)). That's what the fold is for. A file that only got slower or faster waits for the sweep, even a weekly one.
- **Pick the fold's values from the repo's merge rate.** The template's 10 commits or 24 hours folds about every 4 hours at the source repo's 56 commits a day, so a new file runs on its guess for a few hours. Its cost is seconds of a job each merge runs anyway: a save of about a second in each shard, which the claims' save already takes, and a restore, a merge and an upload in the PR run's `report`. On main it's a restore and one API call per merge, and a fold every 10 merges of, by our estimate, about 20 seconds. The source repo's comparable result job ran 11 to 20 seconds, so these stay inside its first billed minute.

The times are Vitest's module duration of files that ran and passed, with collection reported separately; `--times` leaves out failed, skipped and replayed files. That's the right input for ordinary shards, whose per-file process and group startup the shard model adds on its own (`test-shards.ts`' overheads). It isn't a file's wall time: container packing needs that, measured separately (section 4).

## Placeholders

| Placeholder | Where | What to put |
| --- | --- | --- |
| `<app-dir>`, `<server-dir>` | `test-groups.ts` `CACHED_AREAS`, `SERVER_DIR`, the plan step | Your app folders. `<server-dir>` is the one whose tests each start a heavy harness |
| `<project>` | the claims prefix | A short name, so claim keys don't collide with other cache users |
| `<container-estimates.json>` | the plan step | Your `{ "<name>": seconds }` file for `container-pack.ts` |

Also edit `NEVER_CACHED` (its entries are examples), `ORDINARY`, `LEFT_OUT`, `WORKSPACE_READERS`, `KEYED_ENV` and `UNTRACKED_ENV`. The env vars are generic: `TEST_TASKS`, `TEST_INCLUDE`, `TEST_CLAIMS`, `TEST_QUEUE`, `TEST_CLAIMS_FILE`, `TEST_CLAIMED`, `CI_CACHE_URL`, `CI_CACHE_TOKEN`. The runner labels are Blacksmith's. Use the label your tests run on today if you run elsewhere, and set the worker count and `shardSeconds` from that runner.
