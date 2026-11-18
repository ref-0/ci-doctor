# PROMPT.md: start here, coding agent

You are a coding agent. The user wants their CI faster, cheaper and more trustworthy. **Your first job is a plan, not a change.** Survey, measure and map, then write a plan the user reviews.

## Pick up where the last session stopped

This work spans many sessions, and a session can be compacted part-way. One file, `progress.md`, says where it stands: the playbook version, the phase, the plan, the authorization record, what's done and what's next. [The template](templates/agent-knowledge/progress.md) has its fields.

- **At the start,** look for it: at the path the plan names, at `.agents/ci-doctor/progress.md` in the user's repo, or wherever the user says. If you find none, ask once whether an earlier session left one.
- **When you find one,** read it before anything else. Trust it, the repo's history and CI's records over your own memory of earlier work. If its playbook version differs from this checkout, read [the changelog](CHANGELOG.md) between the two before going on.
- **Keep it current.** Rewrite it at the end of each phase and before a session ends. Before approval it lives next to the plan, in the scratch location the user approved; if the plan stays in chat, give the user its contents to keep. After approval, it lives where the authorization record says.

## Before approval: read only

Until the user approves the plan at the end of Phase 3:

- Inspect existing files, settings and history with the read access you already have.
- Save the plan in a scratch location the user approves, or return it in chat. Don't write it into their repo unless they say so.
- Run no installs, hooks, tests, mutations, manual CI runs or reruns, account setup, external writes or schedules.
- Commands in this playbook's setup pages (the READMEs, the guide's step lists) are for the approved implementation, not for the survey.
- Ask only for read access the baseline is missing, and name the exact permission.

After approval, do only what the plan's [authorization record](docs/prompts/phase-3-set-targets-and-write-the-plan.md#the-authorization-record) allows. Stop at the first action outside it and ask.

## What's here

Read [`docs/README.md`](docs/README.md) first: it explains every technique and why. This repo also carries what you'll adapt: agent skills in [`skills/`](skills/README.md), checks in [`checks/`](checks/README.md), reference scripts in [`scripts/`](scripts/README.md), workspace tools in [`tools/workspace/`](tools/workspace/README.md), CI workflow and action templates in [`templates/github/`](templates/github/README.md), the selection planner in [`templates/plan/`](templates/plan/README.md), knowledge templates in [`templates/agent-knowledge/`](templates/agent-knowledge/README.md), and a remote task cache for Vite+ in [`cache/remote/`](cache/remote/README.md). Adapt them to the user's repo; never copy them in unchanged.

**Any CI works; the templates are GitHub Actions.** Every workflow template here is for GitHub Actions. On GitLab CI, Buildkite or CircleCI, the principles, the selection planner and the scripts still apply, but the workflows and runner labels don't: map each to your CI's equivalent, as the stack map below says.

**Our stack is an example.** The guide's details come from one TypeScript + Rust monorepo using Effect, Cloudflare Workers, Vite+ and Blacksmith. Decide what's relevant to *this* repo, and adapt or skip the rest. Stack-specific material is on its own pages, read only if the stack matches: [Rust](skills/ci-workflows/references/rust.md), [Cloudflare Workers](skills/speed-up-tests/references/workers.md), [Effect](skills/speed-up-tests/references/effect.md) and [Blacksmith](skills/blacksmith/SKILL.md). Never add a library, framework or provider just because we used it.

### A common route: GitHub-hosted, Turborepo, Python

For a pnpm TypeScript + Python monorepo on GitHub-hosted runners with Turborepo, read in this order:

1. This file, then guide sections 1, 2, 3, 4, 5, 7, 10, 11, 12 and 13. Section 2 is for the runner recommendation the plan makes.
2. Guide section 6's [task-runner table](docs/pages/06-reuse-work-by-its-real-inputs.md#task-runners-and-their-remote-caches) for Turborepo's cache and how to check it.
3. [`scripts/records/README.md`, Python tests](scripts/records/README.md#python-tests) for pytest timings, and [`scripts/shards/README.md`, a fixed split](scripts/shards/README.md#start-simple-a-fixed-split) for the first shards.
4. [`templates/github/README.md`'s minimal starter](templates/github/README.md#minimal-starter-github-hosted) for a workflow shape.

Skip unless the repo has them: Rust (pass reuse, binaries), Effect, Blacksmith's skill and sticky disks (until the user picks Blacksmith), the Vite+ cache Worker in `cache/remote/`, and `tools/workspace/`'s Vite+ lint split.

## Rules that apply throughout

- **Never trade proof for speed.**
  - No added retries, no timeout raised on its own, no skipped or deleted tests to save time, and no smaller fixture that no longer proves its bound.
  - Every test you speed up must still fail when you break what it guards. After approval, show that with a deliberate mutation, as Phase 4 says.
  - If a change does give up some proof on purpose, name it as a tradeoff in the plan and get the user's yes, as guide section 7 does for the debug-profile Rust run.
- **Keep the repo's current gate semantics** until the user approves a change: its required checks, its retry and rerun behavior, its merge method and its triggers.
- **Measure before you propose, and label every number:** measured (where and when), modelled, replayed or guessed. Give cost changes as a **monthly projection** from measured frequency at the provider's list price. Follow [`verify-evidence`](skills/verify-evidence/SKILL.md): write the decision and noise floor before measuring, and keep count, spread and limiter with every number.
- **The code is the source of truth.** If the user's docs disagree with their code, say so in the plan.
- **Ask before anything that adds recurring spend,** a new scheduled job, a bigger runner, or a change to what runs where. That's the user's call, even after the plan is approved.
- **Don't spend the user's CI to learn things you can read from history.** Prefer existing run logs and records.
- **Leave shared state alone:** other people's branches, caches, runners, processes, temp files and credentials. Never read secrets.

## The phases

Work through them in order, **one at a time**: open a phase's file, finish it, then open the next. Each file links to the one before and after it. Stop at the end of Phase 3 for the user's approval.

0. [Phase 0: know your harness and your helpers](docs/prompts/phase-0-know-your-harness-and-your-helpers.md)
1. [Phase 1: map the repo](docs/prompts/phase-1-map-the-repo.md)
2. [Phase 2: measure the baseline](docs/prompts/phase-2-measure-the-baseline.md)
3. [Phase 3: set targets and write the plan](docs/prompts/phase-3-set-targets-and-write-the-plan.md)
4. [Phase 4: after approval, climb the hill](docs/prompts/phase-4-after-approval-climb-the-hill.md)
5. [Phase 5: make it stay fast](docs/prompts/phase-5-make-it-stay-fast.md)
6. [Phase 6: put the knowledge where agents will find it](docs/prompts/phase-6-put-the-knowledge-where-agents-will-find-it.md)

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
- cheaper-per-minute runners without measuring the same tests on them.

Guide section 18 lists ideas we measured and dropped, plus a few we rejected on principle. Don't repeat them without a reason this repo is different.
