# Fast, trustworthy CI that costs less

This is a field report from a TypeScript and Rust monorepo:

- pnpm workspaces, Vitest and Cloudflare Workers, with a Rust background service;
- CI on GitHub Actions running on [Blacksmith](https://blacksmith.sh) runners;
- most of the code written by AI coding agents running in parallel on one shared machine.

Over about six weeks we reshaped CI around one idea: **pay for a check only where it can change a decision, and never make a test faster by making it prove less.** We kept to that apart from one tradeoff we made on purpose and recorded: dropping a debug-profile Rust run ([section 7](pages/07-shards-runners-and-billing.md#shorten-the-critical-path-before-buying-cores)).

**Our stack is an example, not a requirement.** Effect, Cloudflare Workers, Vite+, the Rust service and our Git-oracle tests are what *we* had. The techniques generalize, and the details may not fit your stack. An agent applying this decides what's relevant.

It's long on purpose. Each section says what we do, how it works, and why. **About the numbers:** counts, percentages and configured thresholds are real. Our CI timings are given as relative changes ("about half", "a quarter faster"), with one exception: the labelled example median and p90 in section 19. Local measurements from a development machine are labelled *local*; they aren't CI numbers. Treat all of them as **examples of effect** in one workload, not benchmarks or targets for yours: most come from history and replays, not controlled comparisons. Anything we tried and dropped is at the end, so you don't repeat it.

> **Want your agent to apply this?** Point it at the [`ci-doctor`](../skills/ci-doctor/SKILL.md) skill. It maps each technique to your repo, measures your CI, and writes a **plan for you to review** before it changes anything.

## Contents

1. [Principles](pages/01-principles.md)
2. [Runners, Blacksmith, and the cost of getting fast](pages/02-runners-blacksmith-and-the-cost-of-getting-fast.md)
3. [Workflow anatomy](pages/03-workflow-anatomy.md)
4. [Run only what a change can reach](pages/04-run-only-what-a-change-can-reach.md)
5. [Tiers: what runs where](pages/05-tiers-what-runs-where.md)
6. [Reuse work by its real inputs](pages/06-reuse-work-by-its-real-inputs.md)
7. [Shards, runners and billing](pages/07-shards-runners-and-billing.md)
8. [A faster test harness](pages/08-a-faster-test-harness.md)
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
21. [Optimize all of your graphs](pages/21-optimize-all-of-your-graphs.md)

Also: [harnesses](harnesses.md), for parallel agents and schedules in each harness, and [the agent's phases](../skills/ci-doctor/references/phases/), which the [`ci-doctor`](../skills/ci-doctor/SKILL.md) skill starts.
