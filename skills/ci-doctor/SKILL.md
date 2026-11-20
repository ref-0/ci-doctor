---
name: ci-doctor
description: "Plans CI speed and cost work and triages a failed PR check: the PR, a flake or the runner. Use when asked to make CI faster or cost less, review CI, or say why a check failed. Not for workflow edits (ci-workflows); runners or the bill (ci-runners); flaky tests (fix-flaky-test); slow tests (speed-up-tests)."
metadata:
  version: "0.2.0"
---

# ci-doctor

Make CI faster, more trustworthy and cost less. This file holds the rules and routes: read the phase or topic it names, then work from that file. For the plan, **your first job is a plan, not a change.** Survey, measure and map, then write a plan the user reviews.

## Pick up where the last session stopped

This work spans many sessions, and a session can be compacted part-way. One file, `progress.md`, says where it stands: the playbook version, the phase and step, the plan, the authorization record, what's done and what's next. [The template](../agent-knowledge/templates/progress.md) has its fields. It's at the path the plan names, at `.agents/ci-doctor/progress.md` in the user's repo, or wherever the user says. It and the plan never go inside a skill's folder.

- **No `progress.md`:** if the user asked for the plan (make CI faster, cut its cost, a CI review, or a pasted `<ci-report>`), ask once whether an earlier session left one, then start at [Phase 0](references/phases/phase-0-know-your-harness-and-your-helpers.md). Otherwise, use the [topic map](#topic-map).
- **A `progress.md`:** read it before anything else, and resume at the phase and step it records, even right after approval: Phases 4–6 run from there. Trust it, the repo's history and CI's records over your own memory of earlier work. If its playbook version differs from this skill's, read [the changelog](../../CHANGELOG.md) between the two before going on.
- **Keep it current.** Rewrite it at the end of each phase and before a session ends. Before approval it lives next to the plan, in the scratch location the user approved; if the plan stays in chat, give the user its contents to keep. After approval, it lives where the authorization record says.
- **If you can't write it,** as when a sandbox keeps `.agents/` or `.git` read-only: ask the user to make its folder writable, and until then keep the progress in your answer, in the template's fields, for the user to save. Not in a temporary folder, which the next session won't find.

## Before approval: read only

Until the user approves the plan at the end of Phase 3:

- Inspect existing files, settings and history with the read access you already have.
- Save the plan in a scratch location the user approves, or return it in chat. Don't write it into their repo unless they say so.
- Run no installs, hooks, tests, mutations, manual CI runs or reruns, account setup, external writes or schedules.
- Commands in this playbook's setup pages (the READMEs, the guide's step lists) are for the approved implementation, not for the survey.
- Ask only for read access the baseline is missing, and name the exact permission.

After approval, do only what the plan's [authorization record](references/phases/phase-3-set-targets-and-write-the-plan.md#the-authorization-record) allows. Stop at the first action outside it and ask. Installing this plugin is the user's own act, outside this rule.

## The phases

Work through them in order, **one at a time**: open a phase's file, finish it, then open the next. Stop at the end of Phase 3 for the user's approval. Sign-ins are in [logins](references/phases/logins.md); what this repo carries, and a common reading route, in [the playbook](references/playbook.md).

| Phase | File |
| --- | --- |
| 0 | [Know your harness and your helpers](references/phases/phase-0-know-your-harness-and-your-helpers.md) |
| 1 | [Map the repo](references/phases/phase-1-map-the-repo.md) |
| 2 | [Measure the baseline](references/phases/phase-2-measure-the-baseline.md) |
| 3 | [Set targets and write the plan](references/phases/phase-3-set-targets-and-write-the-plan.md) |
| 4 | [After approval, climb the hill](references/phases/phase-4-after-approval-climb-the-hill.md) |
| 5 | [Make it stay fast](references/phases/phase-5-make-it-stay-fast.md) |
| 6 | [Put the knowledge where agents will find it](references/phases/phase-6-put-the-knowledge-where-agents-will-find-it.md) |

## Rules that apply throughout

- **Never trade proof for speed.**
  - No added retries, no timeout raised on its own, no skipped or deleted tests to save time, and no smaller fixture that no longer proves its bound.
  - Every test you speed up must still fail when you break what it guards. After approval, show that with a deliberate mutation, as Phase 4 says.
  - If a change does give up some proof on purpose, name it as a tradeoff in the plan and get the user's yes, as guide section 7 does for the debug-profile Rust run.
- **Keep the repo's current gate semantics** until the user approves a change: its required checks, its retry and rerun behavior, its merge method and its triggers.
- **Measure before you propose, and label every number:** measured (where and when), modelled, replayed or guessed. Give cost changes as a **monthly projection** from measured frequency at the provider's list price. Follow the [`prove-it`](../prove-it/SKILL.md) skill: write the decision and noise floor before measuring, and keep count, spread and limiter with every number.
- **The code is the source of truth.** If the user's docs disagree with their code, say so in the plan.
- **Ask before anything that adds recurring spend,** a new scheduled job, a bigger runner, or a change to what runs where. That's the user's call, even after the plan is approved.
- **Don't spend the user's CI to learn things you can read from history.** Prefer existing run logs and records.
- **Leave shared state alone:** other people's branches, caches, runners, processes, temp files and credentials. Never read secrets.
- **Don't build what [the playbook lists](references/playbook.md#what-not-to-build)** unless measurement says otherwise.

## Topic map

Day-to-day work outside the plan. Open the linked entry before you act.

| Task | Topic |
| --- | --- |
| A PR's check failed or was cancelled: reading the run, telling a test failure from a flake or an infrastructure failure, whether the run counts | [triage](references/triage/TOPIC.md) |
| Change or debug a workflow: the job graph, tiers, the checks for a CI change, a slow run's job order | The [`ci-workflows`](../ci-workflows/SKILL.md) skill |
| Setup that takes too long, adding a cache, a cache that never hits, cache keys | The [`cache-ci`](../cache-ci/SKILL.md) skill |
| A flaky test: one that fails sometimes or passes only on a retry, its cause, its fix and the proof | The [`fix-flaky-test`](../fix-flaky-test/SKILL.md) skill |
| The bill and Actions minutes, runner size and architecture, packing against billing rounding, splitting tests into shards by measured time and running them, the spend cap, pricing, jobs that wait for a runner, changing provider | The [`ci-runners`](../ci-runners/SKILL.md) skill |
| Blacksmith only: its CLI, labels, sticky disks, cache, billing, a move to it | The [`blacksmith`](../blacksmith/SKILL.md) skill |
| A slow test or suite, in CI or locally: finding them from CI's records, fixing the wait, fakes | The [`speed-up-tests`](../speed-up-tests/SKILL.md) skill |
| A measurement, a before/after, a cost or a claim about CI: whether the evidence holds | The [`prove-it`](../prove-it/SKILL.md) skill |
| How far an edit reaches, and which checks a change selects: the package graph, entry points and `exports`, layers inside a package, the task graph and the CI job graph | The [`optimize-graphs`](../optimize-graphs/SKILL.md) skill |
| Where agents' instructions, skills and a repo's facts live, and keeping them true | The [`agent-knowledge`](../agent-knowledge/SKILL.md) skill |

The one-rule [checks](references/checks/README.md) the topics link to are here too. The templates for a repo's facts, `progress.md` and a campaign's files are the [`agent-knowledge`](../agent-knowledge/templates/README.md) skill's.

## Not here

The topic map's skills, and these, each its own skill:

- The review gate before a PR's CI run: [`review-gate`](../review-gate/SKILL.md), if the repo adopted it; otherwise the repo's own review process.
- Readying, running by hand, merging and releasing a PR: [`ci-merge-workflow`](../ci-merge-workflow/SKILL.md), if adopted.
- Whether a test is worth keeping: [`test-audit`](../test-audit/SKILL.md). Model checks and property tests: [`proof-tiers`](../proof-tiers/SKILL.md).

## Outside the skills

Links that leave `skills/` lead to the rest of the ci-doctor repo: the guide in `docs/`, the reference implementations in `scripts/`, `templates/`, `tools/` and `cache/`, and the `README.md` and `CHANGELOG.md`. A plugin install usually has them beside the skills. Where it doesn't, as after `npx skills add` or a copy of the skill folders, read them at [ci-doctor.ref0.dev/guide/](https://ci-doctor.ref0.dev/guide/), at the same path they have in the repo (`docs/pages/06-reuse-work-by-its-real-inputs.md` is `https://ci-doctor.ref0.dev/guide/docs/pages/06-reuse-work-by-its-real-inputs.md`), or in [the repo](https://github.com/ref-0/ci-doctor) at the release tag `v<version>`, where the version is this file's `metadata.version`.

Links to a sibling skill, `../<name>/SKILL.md`, need it installed beside this one; [Phase 0](references/phases/phase-0-know-your-harness-and-your-helpers.md#which-ci-doctor-skills-you-have) checks which are and how the user adds a missing one. Until then, read it at `https://github.com/ref-0/ci-doctor/blob/v<version>/skills/<name>/SKILL.md`. Reading a skill authorizes no command it names.
