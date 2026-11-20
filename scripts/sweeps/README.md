# Sweeps: main's full runs, their bisect, and what a release may ship

Pull requests run what a change can reach. A sweep on main runs everything on a schedule. When a sweep, or a server sweep (the integration-only scheduled run between daily sweeps, a "slice" in the code), fails, these scripts find the merge that broke it within a monthly budget. A release ships only what a passing sweep checked. Why: [guide section 5](../../docs/pages/05-tiers-what-runs-where.md). Records the bisect reads: [guide section 13](../../docs/pages/13-records-evidence-of-what-ran.md).

## Files

| File | What it does | Where it runs |
| --- | --- | --- |
| `sweep-bisect.ts` | **Rerun first.** A sweep's failed jobs rerun at the same commit; a pass there is a flake. A server sweep's failed files (at most 4) run by hand at its own commit instead. **Then bisect.** It takes the first failed check that can run alone (`checkOf`) and runs it by hand at the midpoint of the merges since the last pass, halving each time, at most 6 runs. It names the merge, its PR and author on the one `CI on main failed` issue. **Recorded verdicts.** A slice's comment keeps its record in a `<!-- ci-bisect {...} -->` marker; only the bot's markers count. Files a finished bisect saw fail by hand aren't bisected again until a run passes them. **Budget.** It counts the month's vCPU-minutes from GitHub, in-flight runs at their timeout. It starts no run that would pass the allowance. | [`templates/github/workflows/sweep-bisect.yml`](../../templates/github/workflows/sweep-bisect.yml), the controller: its `run-name` matches `controllerTitle`, and it runs one at a time |
| `sweep-bisect.test.ts` | Tests for the check choice, the verdicts, the halving, covered files and the bill. | Anywhere |
| `release-checked.ts` | Finds the passing sweep whose shipped files match the release's, byte for byte: each published package, the workspace packages it reaches, what else ships, and the lockfile, less tests. A release commit (versions raised, nothing else) is compared through its parent. A version changed any other way throws. Prints `checked=<url>` and `sweep=<sha>`. | Release workflow, release PR status |
| `release-checked.test.ts` | `checkedBy` and `isRelease` on a throwaway git repo. | Anywhere |
| `snapshot-pins.ts` | Refuses a run whose tracked manifests or lockfile name a `pkg.pr.new` snapshot, unless it's a run by hand naming exactly one file, in `heavy_file` or `test_paths`. Everything else needs released versions. | First step of CI's plan job |
| `snapshot-pins.test.ts` | Tests for the pins, the refusal, and the command on a throwaway repo. | Anywhere |
| `cron.ts`, in your repo only | Prints a cron's newest slot, so a merge after a missed cron starts that slot's sweep once, at any schedule. It's [`ci-workflows`' `scripts/cron.ts`](../../skills/ci-workflows/scripts/cron.ts), the cron reader `sweep-cadence.ts` prices schedules with; copy it here. | [`templates/github/workflows/sweep.yml`](../../templates/github/workflows/sweep.yml), both jobs |

## Wire it in

Set these up only once the user approves the plan ([ci-doctor, "Before approval"](../../skills/ci-doctor/SKILL.md#before-approval-read-only)). A bisect spends CI by hand, so its allowance is its own approval.

[`templates/github/workflows/ci.yml`](../../templates/github/workflows/ci.yml) already does steps 1, 2 and the snapshot guard, with the job names and `workflow_dispatch` inputs `checks` names (`ref`, `test_paths`, `pack_only`, `bisect`). For a workflow of your own:

### 1. Name your runs

The bisect finds runs by name. In your CI workflow's `run-name`:

- a sweep starts with `CI on main, ` (e.g. `CI on main, daily`);
- a server sweep is `Server tests on main`, or whatever you set `sliceTitle` to (`undefined` if you have none);
- a run by hand is `CI by hand on <sha>…`, ending with `, for a bisect` when the `bisect` input is set.

```yaml
run-name: >-
  ${{ inputs.sweep && 'CI on main, daily' ||
  inputs.server_sweep && format('Server tests on {0}', github.ref_name) ||
  github.event_name == 'workflow_dispatch' && format('CI by hand on {0}{1}{2}',
    inputs.ref || github.ref_name,
    inputs.test_paths && format(', tests under {0}', inputs.test_paths) || '',
    inputs.bisect && ', for a bisect' || '') || '' }}
```

### 2. Start the bisect from the result job

```yaml
- name: Bisect a failed sweep or server sweep
  if: failure() && (inputs.sweep || inputs.server_sweep) && github.ref == 'refs/heads/main' && github.run_attempt == 1
  env:
    GH_TOKEN: ${{ github.token }}   # actions: write
  run: gh workflow run sweep-bisect.yml --repo "$GITHUB_REPOSITORY" --ref main -f run="$GITHUB_RUN_ID"
```

In `ci.yml` this lives in the `report` job, so the required result keeps read rights only. That job also opens `CI on main failed` on a red sweep, and a passing sweep closes it.

### 3. Set the allowance

`bisectBudget.monthlyVcpuMinutes` is 0, so nothing runs by hand until you set it. Measure one run by hand's cost for `nextRunVcpuMinutes`. Set `jobMinutes` to its jobs' timeout and `controllerMinutes` to the controller's. Then fill in `checks` with your job names and `workflow_dispatch` inputs. The `heavy` and `heavyFile` checks are an example for a heavy-file job: if you don't add that job and its `heavy_file` input, delete them before you set an allowance.

Before you set a nonzero allowance, check the interface end to end: every input `checks` and `bisectInput` emit is one your CI workflow declares (GitHub refuses a dispatch with an undeclared input), every job regex matches a job name exactly, a run by hand with `bisect` set ends its name with `byHandTag`, and the controller's run-name is `controllerTitle(run)` for every run it starts, so the month's accounting counts each probe and controller.

### 4. Releases and snapshots

- Run `node scripts/sweeps/release-checked.ts "$SHA"` before tagging or publishing, and write its output to `$GITHUB_OUTPUT`. Set `config.released`, `alsoShipped` (e.g. a compiled crate's folder), `sweeps.start` and `sweeps.requiredJobs`: the job names a release counts on the sweep for. With any set, the gate needs a successful run of each among the passing sweep's runs at that commit. Add each job's name there before its check leaves PRs. The rest of the release (fresh platform builds, npm-only installs of each tarball, platform packages before their parent, retries that publish only missing versions, a fast-forward to the checked commit) is in the [release integration checklist](../../templates/github/README.md#release-integration-checklist).
- Make `node scripts/sweeps/snapshot-pins.ts` the plan job's first step after checkout, before any planning or cache setup, with `EVENT`, `HEAVY_FILE` and `TEST_PATHS` from the run, as `ci.yml` does. It rejects unpublished snapshot pins in PRs, merges, sweeps and releases. It lets a pin through only on a `workflow_dispatch` naming exactly one file, in `HEAVY_FILE` or `TEST_PATHS` but not both. It can't see whether the branch is a draft's: that's workflow policy, kept by whoever dispatches. Keep its exception in step with the manual inputs your workflow declares.
- A sweep's success says only that the jobs it has passed. Before the release gate trusts one, prove a complete sweep ran every check you deferred from PRs (the [setup order](../../templates/github/README.md#setup-order), step 4).

## Placeholders

| Placeholder | Where | What to put |
| --- | --- | --- |
| `<org>`, `<repo>` | `release-checked.ts` | Your GitHub owner and repo |
| `<quick-test-file>` | `checks.quickTests` in `sweep-bisect.ts` | One fast test file, run beside a failed static job |
| `<bisect-vcpu-minute-allowance>` | `bisectBudget.monthlyVcpuMinutes` | What a month of bisects may spend, in vCPU-minutes (0 = off) |
| `<cli>`, `<sdk>` | `config.released` in `release-checked.ts` | Your published packages' folders |
| `test_paths`, `heavy_file`, `pack_only`, `bisect` | `checks` in `sweep-bisect.ts`, `snapshot-pins.ts` | Your CI workflow's `workflow_dispatch` inputs. The template `ci.yml` declares all but `heavy_file`, which comes with a heavy-file job you add |
