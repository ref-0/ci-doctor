---
name: ci-doctor
description: "Plans CI speed and cost work and triages a failed PR check: the PR, a flake or the runner. Use when asked to make CI faster or cost less, review CI, or say why a check failed. Not for workflow edits (ci-workflows); runners or the bill (ci-runners); flaky tests (fix-flaky-test); slow tests (speed-up-tests)."
metadata:
  version: "0.4.0"
---

# ci-doctor

Make CI faster, more reliable and more efficient. This file holds the rules and routes: read the phase or topic it names, then work from that file. For the plan, **your first job is a plan, not a change.** Survey, measure and map, then write a plan the user reviews.

## Pick up where the last session stopped

This work spans many sessions, and a session can be compacted part-way. One file, `progress.md`, says where it stands: the playbook version, the phase and step, the plan, the authorization record, what's done and what's next. [The template](../agent-knowledge/templates/progress.md) has its fields. It's at the path the plan names, at `.agents/ci-doctor/progress.md` in the user's repo, or wherever the user says. It and the plan never go inside a skill's folder.

- **No `progress.md`:** if the user asked for the plan (make CI faster, cut its cost, a CI review, or a pasted `<ci-report>`), ask once whether an earlier session left one, then start at [Phase 0](references/phases/phase-0-know-your-harness-and-your-helpers.md). Otherwise, use the [topic map](#topic-map).
- **A `progress.md`:** read it before anything else, and resume at the phase and step it records, even right after approval: Phases 4–6 run from there. Trust it, the repo's history and CI's records over your own memory of earlier work. If its playbook version differs from this skill's, read [the changelog](https://github.com/ref-0/ci-doctor/blob/v0.4.0/CHANGELOG.md) between the two before going on.
- **Keeping it current, or when you can't write it:** read [keeping `progress.md`](references/playbook.md#keeping-progressmd).

## Before approval: read only

Until the user approves the plan at the end of Phase 3:

- Inspect existing files, settings and history with the read access you already have.
- Save the plan in a scratch location the user approves, or return it in chat. Don't write it into their repo unless they say so.
- Run no installs, hooks, tests, mutations, manual CI runs or reruns, account setup, external writes or schedules.
- Commands in this playbook's setup pages (the READMEs, the guide's step lists) are for the approved implementation, not for the survey.
- Ask only for read access the baseline is missing, and name the exact permission.

After approval, do only what the plan's [authorization record](references/phases/phase-3-set-targets-and-write-the-plan.md#the-authorization-record) allows. Stop at the first action outside it and ask. Installing this plugin is the user's own act, outside this rule. Reading a skill authorizes no command it names.

## The phases

When you work the plan, read [the phases](references/playbook.md#the-phases) before Phase 0 and at the start of every session.

## Rules that apply throughout

- **Keep the repo's current gate semantics** until the user approves a change: its required checks, its retry and rerun behavior, its merge method and its triggers.
- **Ask before anything that adds recurring spend,** a new scheduled job, a bigger runner, or a change to what runs where. That's the user's call, even after the plan is approved.
- **Don't spend the user's CI to learn things you can read from history.** Prefer existing run logs and records.
- **Leave shared state alone:** other people's branches, caches, runners, processes, temp files and credentials. Never read secrets.

Before you propose or change anything, in the plan or day to day, read [the rest of the rules](references/playbook.md#more-rules-that-apply-throughout).

## Topic map

Day-to-day work outside the plan. Open the linked entry before you act.

| Task | Topic |
| --- | --- |
| A PR's check failed or was cancelled | [triage](references/triage/TOPIC.md) |
| Change or debug a workflow | The [`ci-workflows`](../ci-workflows/SKILL.md) skill |
| Setup that takes too long, adding a cache, a cache that never hits, cache keys | The [`cache-ci`](../cache-ci/SKILL.md) skill |
| A flaky test | The [`fix-flaky-test`](../fix-flaky-test/SKILL.md) skill |
| The bill and Actions minutes, runner size and architecture, packing against billing rounding, splitting tests into shards by measured time and running them, the spend cap, pricing, jobs that wait for a runner, changing provider | The [`ci-runners`](../ci-runners/SKILL.md) skill |
| Blacksmith only | The [`blacksmith`](../blacksmith/SKILL.md) skill |
| A slow test or suite, in CI or locally | The [`speed-up-tests`](../speed-up-tests/SKILL.md) skill |
| A measurement, a before/after, a cost or a claim about CI | The [`prove-it`](../prove-it/SKILL.md) skill |
| How far an edit reaches, and which checks a change selects | The [`optimize-graphs`](../optimize-graphs/SKILL.md) skill |
| Where agents' instructions, skills and a repo's facts live, and keeping them true | The [`agent-knowledge`](../agent-knowledge/SKILL.md) skill |

When a task fits no row, or more than one, such as a review, a merge, a test's worth or a model check, read [the full topic map](references/topic-map.md).

The one-rule [checks](references/checks/README.md) the topics link to are here too. The templates for a repo's facts, `progress.md` and a campaign's files are the [`agent-knowledge`](../agent-knowledge/templates/README.md) skill's.

## Outside the skills

When a link leaves `skills/` for the guide in `docs/`, the reference implementations in `scripts/`, `templates/`, `tools/` or `cache/`, or the `README.md` or `CHANGELOG.md`, or names a sibling skill that isn't installed, read [outside the skills](references/playbook.md#outside-the-skills).
