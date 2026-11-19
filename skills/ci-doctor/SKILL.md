---
name: ci-doctor
description: "CI speed, cost and flakes on any provider: why a PR's check failed, slow CI runs or queues, changing workflows and jobs, runners and the bill, slow or flaky tests (local too), checking CI evidence or a before/after claim, and starting or continuing the ci-doctor plan."
---

# ci-doctor

Make CI faster, cheaper and more trustworthy. This file holds the rules and routes: read the phase or topic it names, then work from that file. For the plan, **your first job is a plan, not a change.** Survey, measure and map, then write a plan the user reviews.

## Pick up where the last session stopped

This work spans many sessions, and a session can be compacted part-way. One file, `progress.md`, says where it stands: the playbook version, the phase and step, the plan, the authorization record, what's done and what's next. [The template](references/agent-knowledge/progress.md) has its fields. It's at the path the plan names, at `.agents/ci-doctor/progress.md` in the user's repo, or wherever the user says. It and the plan never go inside a skill's folder.

- **No `progress.md`:** if the user asked for the plan (make CI faster, cut its cost, a CI review, or a pasted `<ci-report>`), ask once whether an earlier session left one, then start at [Phase 0](references/phases/phase-0-know-your-harness-and-your-helpers.md). Otherwise, use the [topic map](#topic-map).
- **A `progress.md`:** read it before anything else, and resume at the phase and step it records, even right after approval: Phases 4–6 run from there. Trust it, the repo's history and CI's records over your own memory of earlier work. If its playbook version differs from this skill's, read [the changelog](../../CHANGELOG.md) between the two before going on.
- **Keep it current.** Rewrite it at the end of each phase and before a session ends. Before approval it lives next to the plan, in the scratch location the user approved; if the plan stays in chat, give the user its contents to keep. After approval, it lives where the authorization record says.
- **If you can't write it,** as when a sandbox keeps `.agents/` or `.git` read-only: ask the user to make its folder writable, or keep the progress in your answer, in the template's fields, for the user to save.

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
- **Measure before you propose, and label every number:** measured (where and when), modelled, replayed or guessed. Give cost changes as a **monthly projection** from measured frequency at the provider's list price. Follow [`verify-evidence`](references/verify-evidence/TOPIC.md): write the decision and noise floor before measuring, and keep count, spread and limiter with every number.
- **The code is the source of truth.** If the user's docs disagree with their code, say so in the plan.
- **Ask before anything that adds recurring spend,** a new scheduled job, a bigger runner, or a change to what runs where. That's the user's call, even after the plan is approved.
- **Don't spend the user's CI to learn things you can read from history.** Prefer existing run logs and records.
- **Leave shared state alone:** other people's branches, caches, runners, processes, temp files and credentials. Never read secrets.
- **Don't build what [the playbook lists](references/playbook.md#what-not-to-build)** unless measurement says otherwise.

## Topic map

Day-to-day work outside the plan. Read the topic's `TOPIC.md` before you act.

| Task | Topic |
| --- | --- |
| A PR's check failed or was cancelled: reading the run, telling a test failure from a flake or an infrastructure failure, whether the run counts | [triage](references/triage/TOPIC.md) |
| Change or debug a workflow: the job graph, setup, selection, tiers, caches, the checks for a CI change, a slow run's job order or setup | [ci-workflows](references/ci-workflows/TOPIC.md) |
| The bill and Actions minutes, runner size and architecture, packing against billing rounding, shards against runner size, the spend cap, pricing, queues, changing provider | [ci-runners](references/ci-runners/TOPIC.md) |
| Blacksmith only: its CLI, labels, sticky disks, cache, billing, a move to it | [blacksmith](references/blacksmith/TOPIC.md) |
| Slow or flaky tests, in CI or locally: finding them from CI's records, fixing the wait, fakes, flakes | [speed-up-tests](references/speed-up-tests/TOPIC.md) |
| A measurement, a before/after, a cost or a claim about CI | [verify-evidence](references/verify-evidence/TOPIC.md) |

The one-rule [checks](references/checks/README.md) the topics link to, and the [agent-knowledge templates](references/agent-knowledge/README.md) for a repo's facts, are here too.

## Not here

- Reviewing a PR before its CI run: `review-gate`, if the repo adopted it; otherwise the repo's own review process.
- Readying, running by hand, merging and releasing a PR: `ci-merge-workflow`, if adopted.
- Whether a test is worth keeping: `test-audit`. Model checks and property tests: `proof-tiers`.

## Outside the skills

Links that leave `skills/` lead to the rest of the ci-doctor repo: the guide in `docs/`, the reference implementations in `scripts/`, `templates/`, `tools/` and `cache/`, and the `README.md` and `CHANGELOG.md`. A plugin install usually has them beside the skills. Where it doesn't, as after `npx skills add` or a copy of the skill folders, read them at [ci.ref0.dev](https://ci.ref0.dev), or in [the repo](https://github.com/ref-0/ci-doctor) at the release tag this plugin's version names.
