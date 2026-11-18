[Guide](../README.md)

# 17. Keeping agent knowledge from going stale

People ask "does all that go into `AGENTS.md`?" and "how do you stop a skill accumulating stale advice?". No, and like this:

## Where knowledge lives

- **`AGENTS.md` is a short map:** repo layout, the commands, and a few rules. Ours includes *"When docs and code disagree, the code is right. Fix the doc in the same change."* It's size-budgeted in CI.
- **Skills** (agent instruction folders) hold the method.
  - `SKILL.md` has only what every use needs.
  - **`references/` by topic** holds the detail, read when needed. For example, the speed-up-tests skill has `fixes.md`, `measuring.md`, `flakes.md`, `fakes.md` and `campaign.md`.
  - `scripts/` holds the mechanics.
  - The `description` says when to use it and which sibling skill owns the neighbouring work, so no two skills claim one trigger. This repo's [`skills/`](../../skills/README.md): `ci-workflows` for workflows, selection, tiers and caches; `ci-runners` for runner size and cost; `blacksmith` for Blacksmith's CLI, disks and bill; `speed-up-tests` for waits, flakes and CI's records; `test-audit` for whether a test is worth keeping; `code-review` for the review before a PR's one run; `ci-merge-workflow` for the run and the merge; `verify-evidence` for judging a number; `proof-tiers` for models and property tests.
  - **Stack-specific detail gets its own reference page,** linked with "if your stack uses X", so the general text reads correctly without it: Rust in `ci-workflows`, Workers and Effect in `speed-up-tests`.
- **Checks** are one rule per small document. Each has the moment it applies, yes/no questions, the commands that answer them, and the **incident and numbers that motivated it**. Skills link checks rather than copying them. Examples:
  - wait for the effect;
  - keep slow files out of the shards;
  - measure CI before changing it;
  - read what was tried;
  - check what CI ran;
  - size a runner by its CPU;
  - budget CI at list price.
- **Shared skills, per-repo facts.** Our skills live in one shared repo, linked into every checkout's `.agents/skills/`. That's how we share them, not how a harness finds them: each harness reads its own folder and instruction file (`AGENTS.md`, `CLAUDE.md` and so on), so point the harness you use at the skills as its docs say, and put the top-level map in the file it actually loads. Each repo keeps its own facts in `.agents/repo/*.md`: its commands, CI tiers, settings, holds and fakes. The skill gives the procedure; the repo gives the values that change. Agent docs have no release cycle: an edit reaches every linked worktree immediately.

## What keeps it fresh

- **Every lesson carries its date and PR,** so an agent can check whether the code it describes still exists.
- **Code wins.** The rule above lives in `AGENTS.md`, and agents read live values from code and config, never from prose.
- **Scripts do the mechanical work.** Collecting, ranking, grouping, budgets and flake filing are code with tests, so the docs describe judgement, not steps that drift.
- **"What was tried."** One register lists every measured-and-dropped idea with when it was tried, its numbers, its evidence (the PR or run, or why there's none) and what would have to change to retry it. Ours is section 18. Name yours in `.agents/repo/ci.md`'s Tried and dropped section; the [`ci-read-what-was-tried`](../../checks/ci-read-what-was-tried.md) check reads it from there. A later run may propose one again only with new numbers. Some dropped ideas did come back once conditions changed, which is why each row says when.
- **Docs drift sweep, every 2 weeks.** Three read-only reviewer agents each take one slice: top-level docs, process skills, code skills. They flag rules stated twice in different words, claims the code no longer matches, and skills that contradict each other. Each finding is a `path:line | dup/conflict/stale | evidence | change` line. A person checks findings before anything changes. Duplicates keep one owner, and the other copy becomes a link.
- **A size budget enforced in CI:** skill descriptions ≤ 320 chars; for the instruction files we own, `SKILL.md` ≤ 10 KB, root `AGENTS.md` ≤ 12 KB, and dated history lines ("Changed on…") rejected, since history belongs in git. Recognized vendored skill bodies are exempt from the body-size and history checks; every description, upstream copies included, stays within 320 characters. Other agent and rules files and the glossary have their own limits, which [`scripts/docs/`](../../scripts/docs/)'s checker defines. The budget forces *cutting* rather than *moving* text.
- **Generalize, don't append.** The standing campaign's last step asks each engineer for lessons:
  - A rule any repo could use goes into the shared skill, with the example kept but repo paths removed.
  - A repo fact goes into the repo's facts file.
  - Wrong or stale advice is fixed or deleted.
  - A rule that a lint, check or script now enforces is **removed**.
  - A run that learned nothing general changes nothing.
- **Memories graduate or die.** Agent memories that a skill now covers are deleted in the weekly review.
- **Upstream skills are pinned.** Third-party skills have a lockfile. A weekly job updates them in a throwaway checkout, reapplies the documented local edits, diffs only the locked folders and the lockfile, and opens or comments on one issue. It never saves the update or auto-merges. A skill you've edited locally is compared with its recorded upstream baseline instead of being overwritten. [`tools/upstream-sync/`](../../tools/upstream-sync/README.md) has the opt-in workflow and the helper that reapplies local edits.
