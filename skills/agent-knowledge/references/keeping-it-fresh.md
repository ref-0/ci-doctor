<!--
What: how to keep agent knowledge true over time: dated lessons, writing lessons back, the drift sweep, the size budget and pinned upstream skills.
Where: read by a coding agent after a run of work that learned something, and when it proposes the sweep, the budget or the upstream check.
Configure: the budget checker's config block, the sweep's schedule and slices.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Keeping it fresh

Part of the [`agent-knowledge`](../SKILL.md) skill. Knowledge goes stale in three ways: the code moves under it, a second copy says it differently, or it grows until nobody reads it. Each section below holds off one of them.

## Lessons

- **Date each one, and name its PR or issue,** so a later agent can check whether the code it describes still exists.
- **Write lessons back at the end of a run.** Ask each engineer, or yourself, for what was learned, then sort it:
  - a rule any repo could use goes into the shared skill, with its example kept and repo paths removed;
  - a repo fact goes into the repo's facts file;
  - wrong or stale advice is fixed or deleted;
  - a rule a lint, check or script now enforces is removed;
  - a run that learned nothing general changes nothing.
- **A new lesson replaces the rule it refines.** Search for a near-match first and generalize it, rather than add a second rule beside it.

## The drift sweep

Every two weeks, read-only:

1. Split the agent docs into slices, such as top-level docs, process skills and code skills, and give each to one reviewer agent.
2. Each flags rules stated twice in different words, claims the code no longer matches, and skills that contradict each other, one line a finding: `path:line | duplicate, conflict or stale | evidence | change`.
3. A person checks the findings before anything changes.
4. One change fixes them. A duplicate keeps one owner, and the other copy becomes a link. A stale claim is fixed from the code, or deleted.

A sweep is a new scheduled job: propose it with its cost, and get its own yes.

## The budget

A size budget enforced in CI forces cutting rather than moving. The source repo's limits: skill descriptions at most 320 characters, upstream copies' too; its own `SKILL.md` at most 10 KB; the root `AGENTS.md` at most 12 KB; other agent and rules files at most 8 KB; and dated history lines ("Changed on…") rejected, since history belongs in git. Recognized vendored skills are held only to the description budget.

ci-doctor's [`scripts/docs/`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/scripts/docs/README.md) has the checker, `docs-budget.ts`, and a link checker, `check-links.ts`, with what each fails on and how to wire them in. Set the budgets from what your docs hold after you compact them, with headroom, and point `layout.skillPath` at where your skills live. Run the link checker after moving or renaming any file.

## Upstream skills

A skill copied from another repo goes stale there too.

- **Pin it.** A skills lockfile records each installed upstream skill. A copy you've edited stays out of the lock, so an update can't overwrite it, and records its source commit instead.
- **Diff on a schedule, apply by hand.** A weekly job updates the locked skills in a throwaway checkout, reapplies your documented edits, diffs only the locked folders and the lock, and opens or comments on one issue. It never saves the update or merges. A hand-edited copy is compared with its recorded upstream baseline.

ci-doctor's [`tools/upstream-sync/`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/tools/upstream-sync/README.md) has the opt-in workflow and the helper that reapplies local edits.
