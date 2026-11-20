[Guide](../README.md)

# 15. The agent workflow around CI

**Applies when:** Agents open, ready and merge the repo's PRs. **Skip when:** People run the PR workflow; keep the repo's trigger and merge policy until the user approves a change.

- **Draft until done.** This is our merge policy: engineers open drafts, and a manager agent marks them ready and merges, so each PR aims at one CI run. On another repo, keep its trigger and merge policy (base branch, required checks, allowed merge method, approvals, reviews dismissed on push, merge queue) until the user approves a change, and test the current required ref, including the merge queue's commit where there is one.
  - Asking engineers for "after" timings once made two of them dispatch ~15 draft runs. Take after-times from the ready run instead.
  - Running a draft's tests by hand doubles its cost, because the ready run repeats them.
- **Before merging, read the run's logs:** the plan chose the changed files, they ran, and their times match. Then post a short `Verification:` comment: head SHA, tested base, jobs and totals, review status.
- **Watch CI through events, not polling loops.** Three-second watchers drained the shared 5,000/hour API quota for everyone.
- **Ready-after-push race:** `gh pr ready` straight after a push can start CI on the *old* head. Compare the remote head before trusting the run.
- **Failed-job reruns keep the old merge ref.** To pick up main's fix, push.
- **Type-check test-only changes too.** CI runs type-aware lint on every file.
- **Review:**
  - Changed tests, helpers or test config need a **test-focused reviewer** (a second model), apart from tiny low-risk changes (≤ 20 changed test lines). Speed work can silently weaken proof.
  - Large production changes (for us, at least 300 net production lines, `largeChange` in [`review-record.ts`](../../skills/review-gate/scripts/review-record.ts)) need a code-quality review. The [`review-gate`](../../skills/review-gate/SKILL.md) skill holds the gate CI checks; [how we run a review](#how-we-run-a-review) is below.
  - Rounds are capped.
  - If only the review record was missing, a small workflow reruns **just the aggregate result job** once a valid record lands. It doesn't rerun everything else.
- **Follow main after merging.** Main once stayed red for hours while agents watched only their own PRs. A green merge isn't a deploy, either: check the deploy.

## How we run a review

**Applies when:** A repo adopts the review gate and has no review process of its own for what the gate requires. **Skip when:** The repo's own review already decides who reviews and how, or it doesn't gate CI on a review.

The review gate checks that a record exists and is well formed. This is the review behind the record, as we ran it. Your repo's own review can replace it: review.md names who reviews, with which types, at what effort.

**What gets a review.** A system where a miss is a security hole, loses data or is hard to undo: sign-in, tokens, secrets and permissions; anything that writes the record of who did what; contracts at the repo's boundaries; stored state and migrations; a bounded model's rules, breaks and bounds; a spike's results when they decide what gets built. The review list names these paths.

**Before starting,** name the session for the PR and the short commit it starts at, such as `<pr>-<head-sha>`, so it never reads an earlier session's output as its own. Check for collisions: `gh pr list --repo <org>/<repo> --search "<file>"` for each file, looking for the same lines, a heading this PR renames, or a table it reflows for one row. Narrow the change, stack on the other PR, or say which merges first.

**Plan the reviewers.** Read the diff, and give each area the change reaches a reviewer of the type that fits it: red team for a token, system design for a lease, storage for a migration, program design for a contract, fuzzing for a parser, bounded verification for a model's rules, stress test for inputs, experiment and skeptic for a spike's results, with the bar in the [`prove-it`](../../skills/prove-it/SKILL.md) skill. A type that reaches several areas gets one reviewer per area. We used 1 to 8 reviewers a round.

**Rounds, at most three.** Keep the PR a draft, and keep a ledger of the reviewers, the types not run and why, and every finding, written before the first reviewer starts, so a restart can resume from it.
- Round 1 runs every planned reviewer at once, each on its scope.
- Round 2 runs again only the reviewers whose findings a fix answered, on those fixes alone, when a fix changed behaviour, added a step or touched code near a finding. Small local fixes, a word or a guard, the author checks. Tests and code quality reviewers get no round 2: tests check their fixes.
- Round 3 runs only the reviewers that found a P0 or P1 in round 2, on those fixes alone. Nothing after it.

**Check each finding.** Reproduce it with a failing test, a command or a code trace: agreement is not evidence, and without a real consumer and a reproduction it's dismissed. Untouched work goes in a follow-up issue. Rate it P0 to P3, then:
- **Fixed** on the PR's branch, with a regression that fails before and passes after. Every in-scope P0 and P1 is fixed in the PR.
- **Filed:** real but out of scope or below P1, as an issue linked from the PR.
- **Kept:** retained on purpose by a brief or a decision, naming the reason and who decided.
- **Dismissed:** wrong, unreproducible or unreachable, with a sentence of evidence.
- **Question:** needs a person's decision; keep working and ask at the end.

A finding reopens only with evidence its dismissal was wrong or its fix failed. Two reviewers reporting one defect get one row.

## Running a slow-test campaign with parallel agents

**Applies when:** The slow-file inventory is long enough to split among agents, and the harness runs them in parallel, each in its own worktree. **Skip when:** The harness can't run parallel agents, or one agent can work the inventory.

1. **Collect records** since the last run, rank every file past 10 s, every file that ends a shard, every wide spread and every flake. That's the item list, plus open items from the ledger.
2. **Review every item, slowest first.** A cheaper second model reads code in **batches by area** and returns a `file:line` reading per file: what it waits for, how long, what it proves, the fix, and the proof to keep. Check the biggest claims yourself.
3. **Merge findings by shared cause** into briefs. Each brief is a file with one finish line, CI's before-times, the proof to keep, the local command and the review requirement. Shared rules live in one README every brief links to.
4. **One engineer per brief,** each in its own worktree. Cap concurrency per account and by machine load: on one day load climbed well past the core count and no more were started. Check for overlapping PRs (`gh pr list --search <file>`) before starting.
5. **The manager marks ready and merges** on green, with resolved review and logs showing the files ran. A flaky failure reruns once; a second failure becomes an issue.
6. **Write lessons back** into the skills (section 17).
7. **Report and rewrite the ledger.** The ledger is a short (~120-line) file of what's open, owned, queued and decided, including every "leave as real work" verdict so it isn't re-reviewed unless its times change. Detail goes in dated reports.
   - **Reconcile coverage.** The report maps every original actionable item to fixed, owned elsewhere, still open, reclassified with evidence, or deliberately deferred, and gives each unresolved item an owner or next action. It keeps modelled savings of merged work, observed post-merge savings and "not yet observed" apart, with counts and sample eligibility for both periods. Don't dispatch extra broad CI just to fill the report.
   - **Epics:** each run opens an epic issue. Every issue and PR it touches becomes a sub-issue, and the epic closes when all sub-issues are closed, the original completion test holds, *and* the next run's records at like hours show the saving.
