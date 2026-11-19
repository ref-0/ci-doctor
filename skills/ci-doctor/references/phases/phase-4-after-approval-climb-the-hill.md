[Start: ci-doctor](../../SKILL.md) · Previous: [Phase 3](phase-3-set-targets-and-write-the-plan.md) · Next: [Phase 5](phase-5-make-it-stay-fast.md)

# Phase 4: after approval, climb the hill

**Keep `progress.md` current** after each item, where the authorization record says it lives. If you can't write there, as under a sandbox that keeps `.agents/` read-only, ask the user for write access to that folder, and until then put the progress in your answer, in [the template's](../agent-knowledge/progress.md) fields. Never in a temporary folder, which the next session won't find.

**First, the approved setup.** Do the setup the plan lists, in order, within the authorization record. The user signs in; you check with status commands. Where the plan needs them, the user grants or confirms:

- `gh` rights to set repo secrets (on stdin, as with `gh secret set`, never on a command line), to write Actions on watched repos, and to write issues and dispatch workflows on an alerts repo;
- the provider and cache accounts the plan selected ([the logins table](logins.md#logins-and-rights) lists each check).

Then work in rounds until the target is reached or the levers run out:

1. **Find what sets the median now:** the slowest shard, the file ending it, setup, a serialized job, or a selection that ran too much.
2. **Pick the biggest lever** in the approved plan for that constraint.
3. **Make one change** per pull request, one cause per PR.
   - For a change to CI, follow [check a change to CI against real output](../checks/ci-check-a-workflow-change.md): its modelled effect on a full and a small run, its cost a month, and which of those numbers the PR's own run observes.
   - For test speedups, the PR body has the CI times before (from history) and after (from the PR's normal CI run), the mutation that still fails, and a local repeat of the whole file with retries off.
   - **Mutations:** only in a disposable checkout, with remote cache writes off and test execution uncached. Check the test fails for the intended reason, restore the source, and confirm the clean whole file passes with retries off. Use the repo's real runner command, and keep both sides of a deadline where it has them. Keep the mutation out of commits and CI.
4. **Use the repo's existing PR and merge path.** Record the base branch, the required check identity, the allowed merge method and the human approvals before touching a PR. Test the current required ref, including the merge-queue SHA when the repo uses one. If the repo runs drafts, keep doing so unless the plan approved a draft-skip change.
5. **Read the run's logs before merging:** the changed files were selected, actually ran, and their times match. A green check can hide a file that never ran.
6. **Re-measure on real runs,** at like hours, on enough runs to beat the noise. Use the noise you measured on this repo; ours swung about ±40% on single comparisons, as an example. Compare a file with its own history and its shard. One after-run can't show a p90: label early results provisional, and read matched later runs, with a control cohort where you can. If you sample CPU, start and stop the sampler inside the measured step and keep its summary.
7. **Keep or revert against the change's approved objective.** Compare median and p90 latency, billed cost, coverage and reliability with the acceptance criteria agreed in Phase 3. A cost cut may justify an approved rise in wall time; a correctness or storage fix may leave latency unchanged. If the sample is too small, mark the result unconfirmed and read later normal runs. Revert on demonstrated harm or a failed objective, not only because the median stayed level. Record the measured tradeoff either way.
8. **Record the outcome** in the repo's "what was tried" register, the one `.agents/repo/ci.md` names: kept or dropped, with numbers, evidence and date ([the check](../checks/ci-read-what-was-tried.md)).
9. **Report to the user** each round in a few lines: median and p90 now against target, what merged, what's next, and anything needing their yes. Give each number with its count and spread, and say whether it's observed or modelled.

**A change only main can exercise** (a new cron, a sweep-only proof, a cache, a `workflow_dispatch` workflow that must exist on the default branch first):

- Before merge, check its syntax and event logic locally, and name the exact job and the behavior left untested.
- For an existing dispatchable workflow, put the dispatch command, its ref, inputs, needed permission and run budget in front of the user for approval.
- For a new or truly main-only job, stage it so it can't affect gates, releases or issue state until its first eligible run is reviewed. Record a deadline, an owner, and the rollback if that run never starts. A dispatch request itself has no verdict.

**Failures in a ready run:** report a test-level retry, a failed-job rerun and an infrastructure failure as different things. Rerun only within the authorization record. A second failure becomes an issue if the plan authorizes filing.

**With parallel agents:**

- One agent per brief, each in its own worktree and branch.
- Check for overlapping open PRs before starting each one.
- The authorization record says who marks PRs ready and who merges; one coordinating agent usually does both and resolves overlaps.
- Throttle when the machine is loaded.
