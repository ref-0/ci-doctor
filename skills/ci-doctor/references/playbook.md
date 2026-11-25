<!--
What: the ci-doctor plan's rules and phases, what the repo carries for an agent to adapt, a common reading route, and what not to build.
Where: read by an agent running the ci-doctor plan, from the hub's SKILL.md.
Configure: nothing.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The playbook

Part of the [`ci-doctor`](../SKILL.md) hub: the plan's rules and phases, what this repo carries and what not to build. Read it at the start of every session that works the plan.

## Keeping `progress.md`

- **Keep it current.** Rewrite it at the end of each phase and before a session ends. Before approval it lives next to the plan, in the scratch location the user approved; if the plan stays in chat, give the user its contents to keep. After approval, it lives where the authorization record says.
- **If you can't write it,** as when a sandbox keeps `.agents/` or `.git` read-only: ask the user to make its folder writable, and until then keep the progress in your answer, in the template's fields, for the user to save. Not in a temporary folder, which the next session won't find.

## The phases

Work through them in order, **one at a time**: open a phase's file, finish it, then open the next. Stop at the end of Phase 3 for the user's approval. Sign-ins are in [logins](phases/logins.md); what this repo carries, and a common reading route, in [the playbook](#whats-here).

| Phase | File |
| --- | --- |
| 0 | [Know your harness and your helpers](phases/phase-0-know-your-harness-and-your-helpers.md) |
| 1 | [Map the repo](phases/phase-1-map-the-repo.md) |
| 2 | [Measure the baseline](phases/phase-2-measure-the-baseline.md) |
| 3 | [Set targets and write the plan](phases/phase-3-set-targets-and-write-the-plan.md) |
| 4 | [After approval, climb the hill](phases/phase-4-after-approval-climb-the-hill.md) |
| 5 | [Make it stay fast](phases/phase-5-make-it-stay-fast.md) |
| 6 | [Put the knowledge where agents will find it](phases/phase-6-put-the-knowledge-where-agents-will-find-it.md) |

## Rules that apply throughout

- **Never trade proof for speed.**
  - No added retries, no timeout raised on its own, no skipped or deleted tests to save time, and no smaller fixture that no longer proves its bound.
  - Every test you speed up must still fail when you break what it guards. After approval, show that with a deliberate mutation, as Phase 4 says.
  - If a change does give up some proof on purpose, name it as a tradeoff in the plan and get the user's yes, as guide section 7 does for the debug-profile Rust run.
- **Keep the repo's current gate semantics** until the user approves a change: its required checks, its retry and rerun behavior, its merge method and its triggers.
- **Measure before you propose, and label every number:** measured (where and when), modelled, replayed or guessed. Give cost changes as a **monthly projection** from measured frequency at the provider's list price. Follow the [`prove-it`](../../prove-it/SKILL.md) skill: write the decision and noise floor before measuring, and keep count, spread and limiter with every number.
- **The code is the source of truth.** If the user's docs disagree with their code, say so in the plan.
- **Ask before anything that adds recurring spend,** a new scheduled job, a bigger runner, or a change to what runs where. That's the user's call, even after the plan is approved.
- **Don't spend the user's CI to learn things you can read from history.** Prefer existing run logs and records.
- **Leave shared state alone:** other people's branches, caches, runners, processes, temp files and credentials. Never read secrets.
- **Don't build what [the playbook lists](#what-not-to-build)** unless measurement says otherwise.

## Outside the skills

Links that leave `skills/` lead to the rest of the ci-doctor repo: the guide in `docs/`, the reference implementations in `scripts/`, `templates/`, `tools/` and `cache/`, and the `README.md` and `CHANGELOG.md`. A plugin install usually has them beside the skills. Where it doesn't, as after `npx skills add` or a copy of the skill folders, read them at [ci-doctor.ref0.dev/guide/](https://ci-doctor.ref0.dev/guide/), at the same path they have in the repo (`docs/pages/06-reuse-work-by-its-real-inputs.md` is `https://ci-doctor.ref0.dev/guide/docs/pages/06-reuse-work-by-its-real-inputs.md`), or in [the repo](https://github.com/ref-0/ci-doctor) at the release tag `v<version>`, where the version is the hub's `metadata.version`.

Links to a sibling skill, `../<name>/SKILL.md`, need it installed beside this one; [Phase 0](phases/phase-0-know-your-harness-and-your-helpers.md#which-ci-doctor-skills-you-have) checks which are and how the user adds a missing one. Until then, read it at `https://github.com/ref-0/ci-doctor/blob/v<version>/skills/<name>/SKILL.md`. Reading a skill authorizes no command it names.

## What's here

Read [`docs/README.md`](../../../docs/README.md) first: it explains every technique and why. This repo also carries what you'll adapt: agent skills in [`skills/`](../../README.md), this hub among them, one-rule checks in [`references/checks/`](checks/README.md), reference scripts in [`scripts/`](../../../scripts/README.md), workspace tools in [`tools/workspace/`](../../../tools/workspace/README.md), CI workflow and action templates in [`templates/github/`](../../../templates/github/README.md), the selection planner in [`templates/plan/`](../../../templates/plan/README.md), knowledge templates in the [`agent-knowledge`](../../agent-knowledge/SKILL.md) skill's [`templates/`](../../agent-knowledge/templates/README.md), and a remote task cache for Vite+ in [`cache/remote/`](../../../cache/remote/README.md). Adapt them to the user's repo; never copy them in unchanged.

**Any CI works; the templates are GitHub Actions.** Every workflow template here is for GitHub Actions. On GitLab CI, Buildkite or CircleCI, the principles, the selection planner and the scripts still apply, but the workflows and runner labels don't: map each to your CI's equivalent, as the stack map below says.

**Our stack is an example.** The guide's details come from one TypeScript + Rust monorepo using Effect, Cloudflare Workers, Vite+ and Blacksmith. Decide what's relevant to *this* repo, and adapt or skip the rest. Stack-specific material is on its own pages, read only if the stack matches: [Rust](../../ci-workflows/references/rust.md), [Cloudflare Workers](../../speed-up-tests/references/workers.md), [Effect](../../speed-up-tests/references/effect.md) and [Blacksmith](../../blacksmith/SKILL.md). Never add a library, framework or provider just because we used it.

### A common route: GitHub-hosted, Turborepo, Python

For a pnpm TypeScript + Python monorepo on GitHub-hosted runners with Turborepo, read in this order:

1. The hub's [SKILL.md](../SKILL.md) and this page, then guide sections 1, 2, 3, 4, 5, 7, 10, 11, 12 and 13. Section 2 is for the runner recommendation the plan makes.
2. The [`cache-ci`](../../cache-ci/SKILL.md) skill for setup and caches, then guide section 6's [task-runner table](../../../docs/pages/06-reuse-work-by-its-real-inputs.md#task-runners-and-their-remote-caches) for Turborepo's cache and how to check it.
3. The [`speed-up-tests`](../../speed-up-tests/SKILL.md) skill and [`scripts/records/README.md`, Python tests](../../../scripts/records/README.md#python-tests) for pytest timings; [`ci-runners`](../../ci-runners/references/shards.md#start-simple-a-fixed-split)' shards, from a fixed split, and its [sizing](../../ci-runners/references/sizing.md) for the first shards.
4. The [`ci-workflows`](../../ci-workflows/SKILL.md) skill and [`templates/github/README.md`'s minimal starter](../../../templates/github/README.md#minimal-starter-github-hosted) for a workflow shape.
5. [`prove-it`](../../prove-it/SKILL.md) before quoting any number, and [`optimize-graphs`](../../optimize-graphs/SKILL.md) for how far a change reaches through the workspace. [`fix-flaky-test`](../../fix-flaky-test/SKILL.md) for section 11's flakes.

Skip unless the repo has them: Rust (pass reuse, binaries), Effect, the `blacksmith` skill and sticky disks (until the user picks Blacksmith), the Vite+ cache Worker in `cache/remote/`, and `tools/workspace/`'s Vite+ lint split.

## What not to build

Unless measurement says otherwise:

- a runtime shared between test files, or a watch-mode harness;
- a resident helper process that holds gigabytes;
- caching anything that replays slower than it runs;
- a separate "fast" command beside the normal one;
- a test mode in production code;
- a fake made slow to mimic a real rate limit;
- a production API widened to remove a test's wait;
- more workers per machine to save on runners;
- runners with a lower minute price, without measuring the same tests on them.

Guide section 18 lists ideas we measured and dropped, plus a few we rejected on principle. Don't repeat them without a reason this repo is different.
