---
name: agent-knowledge
description: "Decides where agents' instructions live and keeps them short and true: AGENTS.md, CLAUDE.md, skills and facts files. Use when writing or fixing AGENTS.md or CLAUDE.md, when agent docs are stale, bloated or contradict each other, or a lesson needs a home. Not for the CI plan itself (ci-doctor)."
metadata:
  version: "0.4.0"
---

# agent-knowledge

Agents read what a repo gives them: the instruction file their harness loads, the skills it finds, and the files those point at. This skill decides where each piece of that knowledge goes, writes it in that shape, and keeps it from going stale. [Guide section 17](https://github.com/ref-0/ci-doctor/blob/v0.4.0/docs/pages/17-keeping-agent-knowledge-from-going-stale.md) has why, and what it cost when we didn't; this skill is what to do.

Use it when asked to write or tidy `AGENTS.md`, `CLAUDE.md`, Cursor rules or a skills folder; when agents follow advice the code no longer matches, or two docs disagree; when a lesson needs a home; and when the ci-doctor plan's Phase 6 puts its findings where agents will find them.

## Rules

- **Code wins.** When a doc and the code disagree, the code is right: fix the doc in the same change. Put that rule in the top-level file. Agents read live values from code and config, never from prose.
- **One home per fact.** Every other place links to it. Two copies drift apart.
- **The method in skills, the values in facts files.** A skill says how; the repo's `.agents/repo/*.md` say with what: its commands, settings, thresholds, holds and fakes.
- **Fit the user's layout,** not ours. If they have `AGENTS.md`, `CLAUDE.md`, Cursor rules, a skills folder or a wiki, use it, and put the map in the file the active harness actually loads.
- **Cut, don't move.** A budget is there to force deleting what no longer earns its place, not to push it into another file.

## 1. Map what's there

Read, before you write:

- which instruction file each harness the team uses loads at the start, and where it looks for skills ([harnesses](https://github.com/ref-0/ci-doctor/blob/v0.4.0/docs/harnesses.md) covers each);
- the skills, their descriptions, and which two could claim one task;
- the docs agents are pointed at, and any facts files, registers and memories;
- where the code already holds a value that prose repeats.

## 2. Put each piece where it belongs

| Piece | Home | Shape |
|---|---|---|
| The map: layout, commands, a few rules, the machine policy | The top-level instruction file | Short, and size-budgeted |
| A method: how to do a kind of work | A skill | `SKILL.md` with what every use needs; `references/` by topic; `scripts/` for the mechanics |
| One rule that must hold at one moment | A check | One small page: moment, yes/no questions, commands, the incident behind it |
| A repo's values | `.agents/repo/*.md` | Facts files the skills point at, from [the templates](templates/README.md) |
| What was tried and dropped | One register | A row per idea: when, its numbers, its evidence, what would have to change |
| Detail for one stack | Its own reference page | Linked with "if your stack uses X" |

[Where it lives](references/where-it-lives.md) has each in full: what a skill's description must say, how stack pages and checks are linked, and how shared skills meet per-repo facts.

## 3. Write the top-level file

Keep it a map: the repo's layout, the commands with their arguments adapted whole, the machine policy (which checks run locally and which are left to CI), and the code-wins rule. Start from the [`AGENTS.md` snippet](templates/AGENTS-snippet.md) and keep only what fits. Name each skill by the moment it applies, not by what it contains.

## 4. Write the repo's facts

Copy each template the adopted skills read into `.agents/repo/`, fill its placeholders, and delete the source repo's commented examples once yours are in. [The templates](templates/README.md) lists each, where it goes and what reads it. Then check every link and anchor in them resolves, as the templates' README says.

## 5. Keep it fresh

- **Date every lesson, with its PR or issue,** so a later agent can check the code it describes still exists. Dates go on the lesson, not as "Changed on…" history lines in the file: history belongs in git.
- **One register of what was tried.** Every measured-and-dropped idea gets a row in the same change that drops it. A later run proposes one again only with new numbers.
- **Generalize, don't append.** A new lesson replaces the rule it refines. A rule any repo could use goes into the shared skill, with repo paths removed; a repo fact into its facts file; wrong advice is fixed or deleted; a rule a lint, check or script now enforces is removed; a run that learned nothing general changes nothing.
- **Memories graduate or die.** An agent memory that a skill now covers is deleted.
- **Sweep for drift** every two weeks, read-only, then fix in one change. [Keeping it fresh](references/keeping-it-fresh.md#the-drift-sweep) has the slices and the finding format.
- **Hold a size budget in CI:** descriptions at most 320 characters, your own `SKILL.md` at most 10 KB, the root `AGENTS.md` at most 12 KB. [Keeping it fresh](references/keeping-it-fresh.md#the-budget) says how to run the checker.
- **Pin what comes from upstream,** and diff it on a schedule instead of overwriting local edits, as [keeping it fresh](references/keeping-it-fresh.md#upstream-skills) says.

Propose the sweep, the budget and any schedule as their own steps: each is a change to the user's repo or CI and needs its own yes.

## Not here

- What CI's skills, the slow-test topic and the evidence check should hold, for the ci-doctor plan: the `ci-doctor` hub's Phase 6, which uses this skill for the layout.
- The register's CI template, with its columns and example rows: the hub's check [read what was tried](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/ci-read-what-was-tried.md).

## Outside this skill

This skill owns where knowledge lives and how it stays fresh, not what it says: a skill's technical content belongs to that skill.

Every link out of this folder is a full URL into the [ci-doctor repo](https://github.com/ref-0/ci-doctor/tree/v0.4.0) at the tag `v<version>`, where the version is this file's `metadata.version`. To run the docs budget or the link checker from a skills-only install, clone ci-doctor once, outside the user's repo, at that release:

```sh
git clone --depth 1 --branch v0.4.0 https://github.com/ref-0/ci-doctor.git <ci-doctor>
```

Once a release carries this skill, use the tag `v<version>` instead, where the version is this file's `metadata.version`.
