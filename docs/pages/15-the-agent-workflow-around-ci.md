[Guide](../README.md)

# 15. The agent workflow around CI

**Applies when:** Agents open, mark ready, and merge the repo's PRs. **Skip when:** Humans run the PR workflow—keep the repo's existing trigger and merge policy until the user approves a change.

- **Keep PRs in draft until done.** Under our merge policy, engineer agents open draft PRs while a manager agent marks them ready and merges, so each PR aims for a single CI run. On another repo, preserve its existing trigger and merge policy (base branch, required checks, merge method, approvals, stale-review dismissal, merge queue) until the user approves a change, and always test the current required ref (including the merge-queue commit if applicable).
  - Asking engineers for "after" timings once caused two agents to dispatch ~15 draft runs. Read after-timings from the ready run instead.
  - Dispatching tests manually on a draft doubles CI spend because marking the PR ready reruns them.
- **Read the run's logs before merging.** Confirm the plan selected the right files, those files actually ran, and their timings make sense. Post a concise `Verification:` comment noting head SHA, tested base, jobs and totals, and review status.
- **Watch CI via events, not polling loops.** Three-second polling loops drained our shared 5,000/hour GitHub API quota for everyone.
- **Guard against the ready-after-push race:** running `gh pr ready` immediately after `git push` can start CI on the *previous* head. Compare the run's SHA against the remote head before trusting it.
- **Remember that failed-job reruns keep the old merge ref.** Push a new commit to pick up a fix from `main`.
- **Type-check test-only edits too.** CI runs type-aware lint across every file.
- **Review discipline:**
  - Any PR modifying tests, helpers, or test config gets a **test-focused reviewer** (a second model), except tiny low-risk changes (≤ 20 changed test lines), because speed work can silently weaken proof.
  - Large production changes (≥ 300 net production lines for us—`largeChange` in [`review-record.ts`](../../skills/review-gate/scripts/review-record.ts)) get a code-quality review. The [`review-gate`](../../skills/review-gate/SKILL.md) skill defines the CI gate; [how we run a review](#how-we-run-a-review) is below.
  - Cap review rounds.
  - If a run failed *only* for a missing review record, a small workflow reruns **just the aggregate result job** once a valid record lands—never the whole pipeline.
- **Watch `main` after merging.** `main` once stayed red for hours while every agent watched only its own PR. A green merge isn't a deploy either—verify the deploy.

## How we run a review

**Applies when:** A repo adopts the review gate without an existing review process for what the gate requires. **Skip when:** The repo already defines who reviews and how, or doesn't gate CI on a review.

The review gate verifies that a well-formed review record exists. Below is the review process we ran behind that record. Your repo's own process can replace it: `review.md` specifies who reviews, with which reviewer types, and at what effort.

**What requires a review.** Changes touching areas where a miss creates a security hole, loses data, or is hard to reverse: sign-in, tokens, secrets, and permissions; audit or provenance writers; contracts at repo boundaries; stored state and migrations; bounded-model rules, breaks, and bounds; and spike results that decide what gets built. The review list names these paths.

**Before starting:** Name the review session after the PR and short starting commit (e.g., `<pr>-<head-sha>`) so it can never mistake an earlier session's output for its own. Check for colliding PRs with `gh pr list --repo <org>/<repo> --search "<file>"` on each touched file—watching for overlapping lines, renamed headings, or reflowed tables—then narrow the diff, stack on the other PR, or record which merges first.

**Plan the reviewers.** Read the diff and assign a matching reviewer type to each area the change touches: red team for tokens, system design for leases, storage for migrations, program design for contracts, fuzzing for parsers, bounded verification for model rules, stress test for inputs, and experiment + skeptic for spike results (using the evidence bar in [`verify-evidence`](../../skills/ci-doctor/references/verify-evidence/TOPIC.md)). If one type covers multiple distinct areas, assign one reviewer per area. We used 1 to 8 reviewers per round.

**Cap at three rounds.** Keep the PR in draft and maintain a ledger listing planned reviewers, skipped types (with reasons), and every finding—written *before* the first reviewer starts so a restart can resume cleanly:
- **Round 1:** Run every planned reviewer concurrently, each on its assigned scope.
- **Round 2:** Re-run only reviewers whose findings were answered by fixes that changed behavior, added a step, or touched code near a finding—scoped strictly to those fixes. Small local fixes (wording or a simple guard) are verified by the author. Tests and code-quality reviewers skip round 2 because tests verify their fixes.
- **Round 3:** Re-run only reviewers that reported a P0 or P1 in round 2, scoped to those fixes. Stop after round 3.

**Verify every finding.** Reproduce it with a failing test, command, or code trace—agreement isn't evidence, and any finding without a real consumer and reproduction is dismissed. Put unrelated pre-existing issues in a follow-up issue. Assign severity P0–P3 and one disposition:
- **Fixed:** fixed on the PR branch with a regression test that fails before and passes after. Every in-scope P0 and P1 must be fixed in the PR.
- **Filed:** real, but out of scope or below P1—tracked in a linked issue.
- **Kept:** intentionally retained per a brief or decision, citing the reason and decision-maker.
- **Dismissed:** wrong, unreproducible, or unreachable, with a one-sentence evidence note.
- **Question:** requires a human decision—keep working on everything else and ask at the end.

A finding reopens only with new evidence that its dismissal was wrong or its fix failed. Multiple reviewers reporting the same defect merge into one row.

## Running a slow-test campaign with parallel agents

**Applies when:** The slow-file inventory is large enough to divide across agents, and your harness can run parallel agents in separate worktrees. **Skip when:** Your harness doesn't support parallel agents, or one agent can handle the list.

1. **Collect records** since the last run and rank every file past 10 s, every shard-ending file, every wide spread, and every flake. Combine that list with open items from the ledger.
2. **Triage slowest first.** A cheaper second model reads code in **batches by area** and returns a `file:line` report for each file: what it waits for, how long, what it proves, the proposed fix, and the proof to preserve. Spot-check the biggest claims yourself.
3. **Group findings by shared root cause** into briefs. Each brief is a file specifying one finish line, CI before-timings, proof requirements, the local test command, and review requirements. Shared rules live in one README that every brief links to.
4. **Assign one engineer per brief,** each in its own git worktree. Cap concurrency by account limits and machine load (on one day load climbed well past the core count, so we paused new starts). Check for overlapping PRs (`gh pr list --search <file>`) before launching work.
5. **Manager marks ready and merges** once CI is green, review is resolved, and logs confirm the target files actually ran. Rerun a flaky failure once; a second failure becomes an issue.
6. **Fold lessons back** into the skills (section 17).
7. **Publish the report and refresh the ledger.** Keep the ledger concise (~120 lines) tracking what is open, owned, queued, and decided—including every "leave as real work" verdict so it isn't re-triaged unless its duration changes. Put detailed data in dated reports.
   - **Reconcile every item:** map each original actionable finding to fixed, owned elsewhere, still open, reclassified with evidence, or deliberately deferred, with an owner or next action on every unresolved item. Keep modelled savings of merged work, observed post-merge savings, and "not yet observed" separate, reporting counts and sample eligibility for both windows. Never dispatch extra broad CI solely to populate the report.
   - **Track under an epic:** each campaign opens an epic issue linking every touched issue and PR as a sub-issue. Close the epic only when all sub-issues are closed, the original completion criterion holds, *and* the next run's records at comparable hours confirm the saving.
