<!--
What: what the ci-doctor repo carries for an agent to adapt, a common reading route, and what not to build.
Where: read by an agent running the ci-doctor plan, from the hub's SKILL.md.
Configure: nothing.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The playbook

Part of the [`ci-doctor`](../SKILL.md) hub, which holds the rules and the phases.

## What's here

Read [`docs/README.md`](../../../docs/README.md) first: it explains every technique and why. This repo also carries what you'll adapt: agent skills in [`skills/`](../../README.md), this hub among them, one-rule checks in [`references/checks/`](checks/README.md), reference scripts in [`scripts/`](../../../scripts/README.md), workspace tools in [`tools/workspace/`](../../../tools/workspace/README.md), CI workflow and action templates in [`templates/github/`](../../../templates/github/README.md), the selection planner in [`templates/plan/`](../../../templates/plan/README.md), knowledge templates in the [`agent-knowledge`](../../agent-knowledge/SKILL.md) skill's [`templates/`](../../agent-knowledge/templates/README.md), and a remote task cache for Vite+ in [`cache/remote/`](../../../cache/remote/README.md). Adapt them to the user's repo; never copy them in unchanged.

**Any CI works; the templates are GitHub Actions.** Every workflow template here is for GitHub Actions. On GitLab CI, Buildkite or CircleCI, the principles, the selection planner and the scripts still apply, but the workflows and runner labels don't: map each to your CI's equivalent, as the stack map below says.

**Our stack is an example.** The guide's details come from one TypeScript + Rust monorepo using Effect, Cloudflare Workers, Vite+ and Blacksmith. Decide what's relevant to *this* repo, and adapt or skip the rest. Stack-specific material is on its own pages, read only if the stack matches: [Rust](ci-workflows/references/rust.md), [Cloudflare Workers](speed-up-tests/references/workers.md), [Effect](speed-up-tests/references/effect.md) and [Blacksmith](blacksmith/TOPIC.md). Never add a library, framework or provider just because we used it.

### A common route: GitHub-hosted, Turborepo, Python

For a pnpm TypeScript + Python monorepo on GitHub-hosted runners with Turborepo, read in this order:

1. The hub's [SKILL.md](../SKILL.md) and this page, then guide sections 1, 2, 3, 4, 5, 7, 10, 11, 12 and 13. Section 2 is for the runner recommendation the plan makes.
2. Guide section 6's [task-runner table](../../../docs/pages/06-reuse-work-by-its-real-inputs.md#task-runners-and-their-remote-caches) for Turborepo's cache and how to check it.
3. [`scripts/records/README.md`, Python tests](../../../scripts/records/README.md#python-tests) for pytest timings, and [`scripts/shards/README.md`, a fixed split](../../../scripts/shards/README.md#start-simple-a-fixed-split) for the first shards.
4. [`templates/github/README.md`'s minimal starter](../../../templates/github/README.md#minimal-starter-github-hosted) for a workflow shape.

Skip unless the repo has them: Rust (pass reuse, binaries), Effect, Blacksmith's topic and sticky disks (until the user picks Blacksmith), the Vite+ cache Worker in `cache/remote/`, and `tools/workspace/`'s Vite+ lint split.

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
