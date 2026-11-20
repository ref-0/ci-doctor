# Fast, cheap, trustworthy CI with AI agents: a field guide

This is a field report from a TypeScript and Rust monorepo:

- pnpm workspaces, Vitest, and Cloudflare Workers, alongside a Rust background service;
- CI on GitHub Actions running on [Blacksmith](https://blacksmith.sh) runners;
- most of the code written by AI coding agents running in parallel on one shared machine.

Over about six weeks, we reshaped CI around a single rule: **pay for a check only where it can change a decision, and never make a test faster by making it prove less.** We held to that rule throughout, with one deliberate, recorded tradeoff: dropping a debug-profile Rust run ([section 7](pages/07-shards-runners-and-billing.md#shorten-the-critical-path-before-buying-cores)).

**Our stack is an example, not a requirement.** Effect, Cloudflare Workers, Vite+, the Rust service, and our Git-oracle tests happen to be what *we* had. The techniques generalize, even though the details may not fit your stack; an agent applying this guide decides what's relevant.

This guide is long on purpose. Each section explains what we do, how it works, and why.

**About the numbers:** Counts, percentages, and configured thresholds are real. CI timings are reported as relative changes ("about half", "a quarter faster"), with one exception: the labelled example median and p90 in section 19. Measurements taken on a development machine are labelled *local* and are not CI numbers. Treat all numbers as **examples of effect** in one workload, not benchmarks or targets for yours—most come from run history and replays rather than controlled experiments. Everything we tried and dropped is collected at the end so you don't repeat it.

> **Want your agent to apply this?** Point it at the [`ci-doctor`](../skills/ci-doctor/SKILL.md) skill. It maps each technique to your repo, measures your CI, and writes a **plan for you to review** before changing anything.

## Contents

1. [Principles](pages/01-principles.md)
2. [Runners, Blacksmith, and the cost of getting fast](pages/02-runners-blacksmith-and-the-cost-of-getting-fast.md)
3. [Workflow anatomy](pages/03-workflow-anatomy.md)
4. [Run only what a change can reach](pages/04-run-only-what-a-change-can-reach.md)
5. [Tiers: what runs where](pages/05-tiers-what-runs-where.md)
6. [Reuse work by its real inputs](pages/06-reuse-work-by-its-real-inputs.md)
7. [Shards, runners and billing](pages/07-shards-runners-and-billing.md)
8. [A cheaper test harness](pages/08-a-cheaper-test-harness.md)
9. [Workspace tooling](pages/09-workspace-tooling.md)
10. [Slow tests: the method](pages/10-slow-tests-the-method.md)
11. [Flakes](pages/11-flakes.md)
12. [Budgets, health and spend](pages/12-budgets-health-and-spend.md)
13. [Records: evidence of what ran](pages/13-records-evidence-of-what-ran.md)
14. [Local speed, and many agents on one machine](pages/14-local-speed-and-many-agents-on-one-machine.md)
15. [The agent workflow around CI](pages/15-the-agent-workflow-around-ci.md)
16. [Standing automations](pages/16-standing-automations.md)
17. [Keeping agent knowledge from going stale](pages/17-keeping-agent-knowledge-from-going-stale.md)
18. [Tried and dropped](pages/18-tried-and-dropped.md)
19. [How we got here](pages/19-how-we-got-here.md)
20. [Thresholds cheat sheet](pages/20-thresholds-cheat-sheet.md)

Also see [harnesses](harnesses.md) for running parallel agents and schedules in each harness, and [the agent's phases](../skills/ci-doctor/references/phases/), which the [`ci-doctor`](../skills/ci-doctor/SKILL.md) skill orchestrates.
