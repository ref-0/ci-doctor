[Guide](../README.md)

# 17. Keeping agent knowledge from going stale

People often ask two things: *"Does all of this go into `AGENTS.md`?"* and *"How do you stop skills from accumulating stale advice?"* The short answers are **no**, and **like this**:

## Where knowledge lives

**Applies when:** Agents work in the repo and the plan's findings need to live in their instructions. **Skip when:** No agents work in the repo.

- **`AGENTS.md` is a short map:** repo layout, core commands, and a few invariant rules—including *"When docs and code disagree, the code is right. Fix the doc in the same change."* Its size is budgeted in CI.
- **Skills** (agent instruction folders) hold the method:
  - `SKILL.md` contains only what every invocation needs;
  - **`references/` by topic** holds deeper detail loaded on demand (for instance, the hub's speed-up-tests topic splits into `fixes.md`, `measuring.md`, `flakes.md`, `fakes.md`, and `campaign.md`);
  - `scripts/` holds deterministic mechanics;
  - each skill's `description` states both when to trigger it and which sibling owns adjacent work so triggers never overlap. In this repo's [`skills/`](../../skills/README.md): `ci-doctor` owns CI work (covering workflows, runners, Blacksmith, slow tests and flakes, evidence, and planning as topics, since agents treat all of those as CI); `test-audit` evaluates whether a test is worth keeping; `review-gate` handles the review gate before a PR's single run; `ci-merge-workflow` handles the run and merge; and `proof-tiers` covers models and property tests;
  - **stack-specific detail lives on its own reference page**, linked with *"if your stack uses X"* so general guidance stays clean without it (Rust in `ci-workflows`; Workers and Effect in `speed-up-tests`).
- **Checks** isolate one rule per short document—stating when it applies, yes/no questions, commands that answer them, and the **incident and numbers that motivated it**. Skills link to checks instead of duplicating them. Examples:
  - wait for the effect;
  - keep slow files out of the shards;
  - measure CI before changing it;
  - read what was tried;
  - check what CI ran;
  - size a runner by its CPU;
  - budget CI at list price.
- **Separate shared skills from per-repo facts.** Our shared skills live in one repo and are linked into every checkout's `.agents/skills/`. That is how we share them, not how every harness discovers them: each harness reads its own skills folder and startup file (`AGENTS.md`, `CLAUDE.md`, etc.), so configure your harness per its docs and put the top-level map in the file it loads. Each repo keeps its local facts in `.agents/repo/*.md`—commands, CI tiers, settings, holds, and fakes. The skill provides the procedure; the repo provides the values that change. Agent docs have no release cycle: an edit reaches every linked worktree immediately.

## What keeps it fresh

**Applies when:** The repo maintains lessons or a tried-and-dropped register that agents read. **Skip when:** No agents work in the repo.

- **Tag every lesson with its date and PR** so an agent can verify whether the referenced code still exists.
- **Code wins.** Enforced in `AGENTS.md`: agents read live values from code and config, never from prose.
- **Put mechanics in tested scripts.** Collecting, ranking, grouping, budgets, and flake filing are code with tests, leaving docs to capture judgement rather than fragile step-by-step instructions.
- **Maintain a "What was tried" register.** One register lists every measured-and-dropped idea with when it was tried, the numbers observed, the evidence (PR/run, or why none exists), and what would have to change to revisit it. Ours is section 18; place yours in `.agents/repo/ci.md`'s *Tried and dropped* section so [`ci-read-what-was-tried`](../../skills/ci-doctor/references/checks/ci-read-what-was-tried.md) can read it. A later run may propose a dropped idea again only with new numbers—and some *did* return once conditions changed, which is why each row records when to retry.
- **Run a docs drift sweep every 2 weeks.** Three read-only reviewer agents each audit a slice—top-level docs, process skills, and code skills—flagging duplicated rules phrased differently, claims that no longer match code, and conflicting skills. Each finding uses the format `path:line | dup/conflict/stale | evidence | change`. A human reviews findings before edits land; duplicates keep a single owner while the other copy becomes a link.
- **Enforce a size budget in CI:** skill descriptions ≤ 320 characters; for owned instruction files, `SKILL.md` ≤ 10 KB and root `AGENTS.md` ≤ 12 KB, rejecting dated changelog lines (`Changed on…`) since history belongs in git. Recognized vendored skill bodies are exempt from body-size and history checks, though every description—upstream copies included—stays within 320 characters. Other agent/rules files and the glossary have limits defined in [`scripts/docs/`](../../scripts/docs/)'s checker. A hard budget forces *cutting* bloat instead of merely *moving* it.
- **Generalize—don't append.** The standing campaign's final step asks every engineer for lessons:
  - rules useful to any repo go into the shared skill (keeping the example, stripping repo-specific paths);
  - repo-specific facts go into the repo's facts file;
  - wrong or stale advice is corrected or deleted;
  - any rule now enforced by a lint, check, or script is **removed** from prose;
  - a run that uncovered nothing general makes no doc changes.
- **Memories graduate or expire.** In the weekly review, agent memories now captured in a skill are deleted.
- **Pin upstream skills.** Third-party skills use a lockfile. A weekly job updates them in a throwaway checkout, reapplies documented local edits, diffs only locked folders and the lockfile, and opens or comments on one issue—never saving updates or auto-merging. Locally edited skills diff against their recorded upstream baseline rather than being overwritten. [`tools/upstream-sync/`](../../tools/upstream-sync/README.md) provides the opt-in workflow and reapply helper.
