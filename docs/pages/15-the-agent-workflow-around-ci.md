[Guide](../README.md)

# 15. The agent workflow around CI

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
  - Large production changes (for us, at least 300 net production lines, `largeChange` in [`review-record.ts`](../../skills/code-review/scripts/review-record.ts)) need a code-quality review. [`skills/code-review/`](../../skills/code-review/SKILL.md) holds the review procedure.
  - Rounds are capped.
  - If only the review record was missing, a small workflow reruns **just the aggregate result job** once a valid record lands. It doesn't rerun everything else.
- **Follow main after merging.** Main once stayed red for hours while agents watched only their own PRs. A green merge isn't a deploy, either: check the deploy.

## Running a slow-test campaign with parallel agents

1. **Collect records** since the last run, rank every file past 10 s, every file that ends a shard, every wide spread and every flake. That's the item list, plus open items from the ledger.
2. **Review every item, slowest first.** A cheaper second model reads code in **batches by area** and returns a `file:line` reading per file: what it waits for, how long, what it proves, the fix, and the proof to keep. Check the biggest claims yourself.
3. **Merge findings by shared cause** into briefs. Each brief is a file with one finish line, CI's before-times, the proof to keep, the local command and the review requirement. Shared rules live in one README every brief links to.
4. **One engineer per brief,** each in its own worktree. Cap concurrency per account and by machine load: on one day load climbed well past the core count and no more were started. Check for overlapping PRs (`gh pr list --search <file>`) before starting.
5. **The manager marks ready and merges** on green, with resolved review and logs showing the files ran. A flaky failure reruns once; a second failure becomes an issue.
6. **Write lessons back** into the skills (section 17).
7. **Report and rewrite the ledger.** The ledger is a short (~120-line) file of what's open, owned, queued and decided, including every "leave as real work" verdict so it isn't re-reviewed unless its times change. Detail goes in dated reports.
   - **Reconcile coverage.** The report maps every original actionable item to fixed, owned elsewhere, still open, reclassified with evidence, or deliberately deferred, and gives each unresolved item an owner or next action. It keeps modelled savings of merged work, observed post-merge savings and "not yet observed" apart, with counts and sample eligibility for both periods. Don't dispatch extra broad CI just to fill the report.
   - **Epics:** each run opens an epic issue. Every issue and PR it touches becomes a sub-issue, and the epic closes when all sub-issues are closed, the original completion test holds, *and* the next run's records at like hours show the saving.
