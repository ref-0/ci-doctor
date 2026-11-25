<!--
What: how to keep agent knowledge true over time: dated lessons, writing lessons back, the drift sweep, the size budget, thinning a skill and pinned upstream skills.
Where: read by a coding agent after a run of work that learned something, when a `SKILL.md` nears its budget, and when it proposes the sweep, the budget or the upstream check.
Configure: the budget checker's config block, the sweep's schedule and slices.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Keeping it fresh

Part of the [`agent-knowledge`](../SKILL.md) skill. Knowledge goes stale in three ways: the code moves under it, a second copy says it differently, or it grows until nobody reads it. Each section below holds off one of them. Read it when a run learned something, when a `SKILL.md` nears its budget, or when you propose the sweep, the budget or the upstream check.

## The rules

- **Date every lesson, with its PR or issue,** so a later agent can check the code it describes still exists. Dates go on the lesson, not as "Changed on…" history lines in the file: history belongs in git.
- **One register of what was tried.** Every measured-and-dropped idea gets a row in the same change that drops it. A later run proposes one again only with new numbers.
- **Generalize, don't append.** A new lesson replaces the rule it refines. A rule any repo could use goes into the shared skill, with repo paths removed; a repo fact into its facts file; wrong advice is fixed or deleted; a rule a lint, check or script now enforces is removed; a run that learned nothing general changes nothing.
- **Memories graduate or die.** An agent memory that a skill now covers is deleted.
- **Sweep for drift** every two weeks, read-only, then fix in one change. [The drift sweep](#the-drift-sweep) has the slices and the finding format.
- **Hold a size budget in CI:** descriptions at most 320 characters, your own `SKILL.md` at most 6 KB with a warning past 5 KB, the root `AGENTS.md` at most 12 KB. [The budget](#the-budget) says how to run the checker, and [thinning a skill](#thinning-a-skill) what to do when one nears its line.
- **Pin what comes from upstream,** and diff it on a schedule instead of overwriting local edits, as [upstream skills](#upstream-skills) says.

Propose the sweep, the budget and any schedule as their own steps: each is a change to the user's repo or CI and needs its own yes.

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

A size budget enforced in CI forces deleting what no longer earns its place, and moving one step's or one case's detail out of `SKILL.md` into `references/`, word for word. It never asks for rewording to fit. The source repo's limits: skill descriptions at most 320 characters, upstream copies' too; its own `SKILL.md` at most 6 KB, with a warning past 5 KB that passes; the root `AGENTS.md` at most 12 KB; other agent and rules files at most 8 KB; and dated history lines ("Changed on…") rejected, since history belongs in git. Recognized vendored skills are held only to the description budget.

ci-doctor's [`scripts/docs/`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/scripts/docs/README.md) has the checker, `docs-budget.ts`, and a link checker, `check-links.ts`, with what each fails on and how to wire them in. Set the budgets from what your docs hold after you compact them, with headroom, and point `layout.skillPath` at where your skills live. Run the link checker after moving or renaming any file.

Both messages, the warning and the failure, name the `SKILL.md`'s largest `##` sections, suggest a reference to move the largest to, and give the pointer line to leave. Read every warning: a skill past 5 KB still passes, and the next rule added to it moves a section out first.

### Running the checkers

To run the docs budget or the link checker from a skills-only install, clone ci-doctor once, outside the user's repo, at that release:

```sh
git clone --depth 1 --branch v0.4.0 https://github.com/ref-0/ci-doctor.git <ci-doctor>
```

Once a release carries this skill, use the tag `v<version>` instead, where the version is the skill's `metadata.version`.

## Thinning a skill

A skill is thin, direct instructions for one kind of task. Its `SKILL.md` holds what every run needs; everything else waits in `references/` until a step needs it. Aim for 2 to 4 KB.

- **Never reword to fit.** A cut article, a sentence packed with three rules or a list jammed into a clause costs every reader to save a few bytes. When a skill nears the line, move a whole section or case to `references/`, word for word.
- **Adding a rule to a skill past 5 KB:** move a section out in the same change first.

### Find what moves

Ask of each section: does every run of the skill need this? These usually don't:

- A step's full procedure, when the step is one of several paths, such as the body of a PR, the finding states of a review or the report fields of a check.
- A case's rules, such as a spike, a stack, a release or one platform.
- Templates, formats and worked examples.
- Incidents, issue numbers and measurements given as the reason for a rule.
- Counts or inventories copied from code at a commit.
- Rules repeated from a sibling skill or from the repo's shared rules file.

What stays: the order of the steps, each step's rules that always apply, and the pointer lines. A default labelled as the source repo's, such as "about 90 s in the source repo", is a starting value, not history, and stays beside its rule.

### Move it

1. Move the section or bullets word for word to the reference for that topic, or a new one. Never shorten, merge or reword a rule on the way.
2. Fix the links in the moved text for its new folder: a link relative to the skill, `../x`, becomes `../../x` from `references/`.
3. Leave one pointer line in `SKILL.md` that names the condition: `When <condition>, read [<topic>](references/<file>.md).`
4. A new reference starts with `# <Title>`, then a line saying which skill it's part of and when to read it. Point to every reference from `SKILL.md`: a reference nobody points to is never read.
5. For a rule repeated from another skill, read the owner first. Replace the copy with a link only when the owner says the same. When the owner says less, keep the text, and tell whoever owns that skill. Where a skill must work installed alone, link the owner by a full URL, not a relative path.
6. For a story behind a rule, keep the rule in `SKILL.md` and move the story beside its step's reference or to `references/examples.md`.

### Check the move

- Every rule that left `SKILL.md` is in a reference or its owner, and every reference has a pointer.
- Every heading another file links to is still there, with its pointer line under it. Before you remove one, search the repo, its docs and anything else that links its skills for `<skill>/SKILL.md#<anchor>`.
- The diff moves text. A changed word in moved text is a change of rule, and needs its own reason.
- Run the docs budget and the link checker, and read every warning.

## Upstream skills

A skill copied from another repo goes stale there too.

- **Pin it.** A skills lockfile records each installed upstream skill. A copy you've edited stays out of the lock, so an update can't overwrite it, and records its source commit instead.
- **Diff on a schedule, apply by hand.** A weekly job updates the locked skills in a throwaway checkout, reapplies your documented edits, diffs only the locked folders and the lock, and opens or comments on one issue. It never saves the update or merges. A hand-edited copy is compared with its recorded upstream baseline.

ci-doctor's [`tools/upstream-sync/`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/tools/upstream-sync/README.md) has the opt-in workflow and the helper that reapplies local edits.
