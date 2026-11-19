# Reuse: skip an expensive component's checks when its inputs didn't change

A compiled component, a Rust crate in the repo this comes from, is slow to build, test and lint. Its checks run when a change moves its content key. A pull request skips them when main already passed them at the same key. A merge passes on its pull request's proof, so main doesn't run them again. Why, and the numbers: [guide section 6](../../docs/pages/06-reuse-work-by-its-real-inputs.md). Where these runs sit among the tiers: [guide section 5](../../docs/pages/05-tiers-what-runs-where.md).

## Files

| File | What it does | Where it runs |
| --- | --- | --- |
| `pass-key.ts` | The **pass key** hashes git object ids of every input: the component's folder (not root Markdown), files it reads outside it, and what its toolchain reads above it. It also hashes the text of the workflow jobs that build, test and check it, plus the workflow's `env` and `defaults`. Each platform manifest's `version` is blanked, so a release merge keeps the pass. The **binary key** (`--with-versions`) keeps the versions: the binaries' cache uses it, since each binary names its release. A missing job throws, so a rename can't drop what it runs from the key. | CI's plan job |
| `pass-key.test.ts` | What moves the key, what holds it, the versionless rules, and `sourceAt` on a throwaway repo. | Anywhere |
| `merge-pass.ts` | On a push to main, looks for the merged pull request's proven pass. It takes the PR's last `pull_request` run on its final head, from a branch in this repo. It requires the listed jobs and steps to have succeeded (skipped doesn't count). It reads the tested merge commit from the plan record, fetches it, and checks its **second parent** is the PR's head. Then the tested commit's key must equal the merge's. Prints that run's id, or nothing and why. | CI's plan job, on main |
| `merge-pass.test.ts` | Tests for the PR lookup, the last run, the job and step check, the plan record, and the parents. | Anywhere |
| `outside-reads.ts` | Lists the files a Rust component names outside its folder: quoted relative paths in `include_str!`, `include_bytes!` and `#[path]`, and those after `CARGO_MANIFEST_DIR`. Fails on any outside the component and `outsidePrefixes`. Can't see a path built at run time. | A test in your repo |
| `outside-reads.test.ts` | Tests for the patterns, the allowed folders, and that an allowed folder is a key input. | Anywhere |

## Wire it in

Set this up only once the user approves the plan ([PROMPT, "Before approval"](../../skills/ci-doctor/SKILL.md#before-approval-read-only)). [`templates/github/workflows/ci.yml`](../../templates/github/workflows/ci.yml) ships pass reuse **off** (`RUST_PASS_REUSE: 'false'`), and has no merge promotion, only a TODO in its `report` job. Keep reuse off until you've configured `pass-key.ts` and seen a changed manifest (a Cargo feature, say), a changed outside fixture and a changed workflow command each move the key. Use the computed `key` and `binary` at every lookup and save, never a handwritten list.

The plan job computes the key and looks for a pass. The component's jobs then run only when it finds none. A job after the result records a pass on main. If a merge has neither a current main pass nor a promotable pull request pass, its run simply runs the component's checks.

```yaml
# In the plan job, after checkout (deep enough to reach the tested merge commit)
- name: The component's key, and main's pass
  id: pass
  env:
    GH_TOKEN: ${{ github.token }}   # actions: read, pull-requests: read
  run: |
    key=$(node scripts/reuse/pass-key.ts || true)
    echo "key=$key" >> "$GITHUB_OUTPUT"
    echo "binary=$(node scripts/reuse/pass-key.ts --with-versions || true)" >> "$GITHUB_OUTPUT"

    # The run of main's that recorded a pass for key $1 within $2 hours, 30 when unsaid: an
    # artifact named for the key. Only a successful run of ci.yml on main in this repo counts, a
    # sweep or a run by hand that passed the checks, or a merge on its pull request's proof. A pull
    # request's run could upload an artifact of any name, but GitHub names the run and branch each
    # came from, so check both that and the run's conclusion. A pull request trusts one 30 hours,
    # since the daily sweep that renews it can start late. None found, or the lookup failing, and
    # the checks run.
    main_pass() {
      local since run
      [ -n "$1" ] || return 1
      since=$(date -u -d "${2:-30} hours ago" +%Y-%m-%dT%H:%M:%SZ)
      for run in $(gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=rust-pass-$1&per_page=30" \
        --jq ".artifacts[] | select((.expired | not) and .created_at > \"$since\") |
          select(.workflow_run.head_branch == \"main\" and .workflow_run.head_repository_id == .workflow_run.repository_id) |
          .workflow_run.id" 2> /dev/null || true); do
        case "$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run" --jq '.path + " " + .head_branch + " " + .event + " " + (.conclusion // "")' 2> /dev/null || true)" in
          ".github/workflows/ci.yml main workflow_dispatch success" | ".github/workflows/ci.yml main push success")
            echo "$run"
            return 0
            ;;
        esac
      done
      return 1
    }

    # A PR trusts a pass up to 30 h old. A sweep or a merge renews one older than 20 h, so it asks
    # for a younger one, and runs the checks when there's none.
    case "$GITHUB_EVENT_NAME" in pull_request) age=30 ;; *) age=20 ;; esac
    if main_pass "$key" "$age" > /dev/null; then
      echo "passed=true" >> "$GITHUB_OUTPUT"
    elif [ "$GITHUB_EVENT_NAME" = push ] && [ -n "$key" ]; then
      # A merge: its pull request's last run may have proven the same key.
      echo "merge_pass=$(node scripts/reuse/merge-pass.ts "$GITHUB_SHA" || true)" >> "$GITHUB_OUTPUT"
    fi
```

A sweep and a merge renew a pass older than 20 hours (the `age` above), so the next day's sweep always does.

```yaml
# In the result job, which needs every job. Main's pass: from a run on main of main's own commit,
# when the component's checks passed, or on a merge, when merge-pass.ts found the pull request's
# proof. Never from a pull request's run. Kept 2 days, past those 30 hours.
- name: Main's pass for the component
  id: record-pass
  if: >-
    always() && github.ref == 'refs/heads/main' && github.event_name != 'pull_request'
    && needs.plan.outputs.sha == github.sha && needs.plan.outputs.key != ''
    && (needs.component-tests.result == 'success' && needs.rust.result == 'success'
      || github.event_name == 'push' && needs.plan.outputs.merge_pass != '')
  env:
    KEY: ${{ needs.plan.outputs.key }}
    SHA: ${{ needs.plan.outputs.sha }}
    TESTED: ${{ github.event_name == 'push' && needs.plan.outputs.merge_pass || '' }}
  run: |
    jq -n --arg key "$KEY" --arg sha "$SHA" --arg run "$GITHUB_RUN_ID" --arg tested "${TESTED:-$GITHUB_RUN_ID}" \
      '{key: $key, sha: $sha, run: ($run | tonumber), tested: ($tested | tonumber)}' | tee "$RUNNER_TEMP/pass.json"
- uses: actions/upload-artifact@v4
  if: always() && steps.record-pass.outcome == 'success'
  with:
    name: rust-pass-${{ needs.plan.outputs.key }}
    path: ${{ runner.temp }}/pass.json
    if-no-files-found: error
    retention-days: 2
    overwrite: true
```

It is an artifact, not a cache entry, because GitHub names the run and branch each artifact came from. A pull request's run could save a cache entry under any key in its own scope. The lookup trusts an artifact only with both: its provenance (repository, workflow path, branch, event) and its run's success.

Map the step's outputs (`key`, `binary`, `passed`, `merge_pass`) and the tested `sha` to the plan job's outputs. Then gate the component's jobs on `needs.plan.outputs.passed != 'true' && needs.plan.outputs.merge_pass == ''`. Key the binaries' cache by `binary`, not `key`.

Set `CONFIG` in `pass-key.ts` to your component's folder, outside reads, toolchain files, job ids, and versioned manifests. Set `passingJobs` and `planJob` in `merge-pass.ts` to the job names as a run's page shows them. Add three tests in your repo:

- one that keys your real `HEAD`, so a renamed job fails here first;
- one that every name in `passingJobs` is a job your workflows make (`pullRequestJobs` in [`../budgets/ci-jobs.ts`](../budgets/ci-jobs.ts)). A rename would leave every merge recording nothing;
- one that every read outside the component is inside the key. Audit the component's disk reads and compile-time includes first. For Rust, run `outsideReads` over your real tree and expect nothing, with `outsidePrefixes` as the allowed folders, then check each allowed folder's files pass `isInput`. Declare reads computed at run time in `outsidePrefixes` or `outsideFiles` by hand: no text check finds them. Keep this test apart from the one that edits already-declared inputs: that one proves a declared read moves the key, this one that no undeclared read exists. A later fixture or include outside the declared folders otherwise leaves a passing key unchanged.

The plan record that `merge-pass.ts` reads is the `plan` line [`../flakes/records.ts`](../flakes/records.ts) describes. Its `sha` is the merge commit the pull request's run tested.

## Trust

`merge-pass.ts` trusts the pull request's own workflow to report its jobs and the commit it tested, as a merge trusts that run's result. Fork pull requests are refused: their runs don't count. Record this trade-off in your threat notes.

## Placeholders

| Placeholder | Where | What to put |
| --- | --- | --- |
| `<org>`, `<repo>` | `merge-pass.ts` fallback, the note above | Your GitHub owner and repo |
| `<component>` | `config` in `pass-key.ts` | Your component's folder name and its job ids |
| `<Component>` | `passingJobs` in `merge-pass.ts` | Its jobs' names as a run's page shows them |
