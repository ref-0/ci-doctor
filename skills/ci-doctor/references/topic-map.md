<!--
What: the hub's full topic map: each day-to-day task with the cases it covers, the topic or skill it goes to, and the skills outside the map.
Where: read by an agent doing day-to-day CI work outside the plan, from the hub's SKILL.md.
Configure: nothing.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The full topic map

Part of the [`ci-doctor`](../SKILL.md) hub: the topic map's rows with every case each covers, and the skills outside it. Read it when a task fits no row of the hub's topic map, or more than one.

Day-to-day work outside the plan. Open the linked entry before you act.

| Task | Topic |
| --- | --- |
| A PR's check failed or was cancelled: reading the run, telling a test failure from a flake or an infrastructure failure, whether the run counts | [triage](triage/TOPIC.md) |
| Change or debug a workflow: the job graph, tiers, the checks for a CI change, a slow run's job order | The [`ci-workflows`](../../ci-workflows/SKILL.md) skill |
| Setup that takes too long, adding a cache, a cache that never hits, cache keys | The [`cache-ci`](../../cache-ci/SKILL.md) skill |
| A flaky test: one that fails sometimes or passes only on a retry, its cause, its fix and the proof | The [`fix-flaky-test`](../../fix-flaky-test/SKILL.md) skill |
| The bill and Actions minutes, runner size and architecture, packing against billing rounding, splitting tests into shards by measured time and running them, the spend cap, pricing, jobs that wait for a runner, changing provider | The [`ci-runners`](../../ci-runners/SKILL.md) skill |
| Blacksmith only: its CLI, labels, sticky disks, cache, billing, a move to it | The [`blacksmith`](../../blacksmith/SKILL.md) skill |
| A slow test or suite, in CI or locally: finding them from CI's records, fixing the wait, fakes | The [`speed-up-tests`](../../speed-up-tests/SKILL.md) skill |
| A measurement, a before/after, a cost or a claim about CI: whether the evidence holds | The [`prove-it`](../../prove-it/SKILL.md) skill |
| How far an edit reaches, and which checks a change selects: the package graph, entry points and `exports`, layers inside a package, the task graph and the CI job graph | The [`optimize-graphs`](../../optimize-graphs/SKILL.md) skill |
| Where agents' instructions, skills and a repo's facts live, and keeping them true | The [`agent-knowledge`](../../agent-knowledge/SKILL.md) skill |

## Not here

The topic map's skills, and these, each its own skill:

- The review gate before a PR's CI run: [`review-gate`](../../review-gate/SKILL.md), if the repo adopted it; otherwise the repo's own review process.
- Readying, running by hand, merging and releasing a PR: [`ci-merge-workflow`](../../ci-merge-workflow/SKILL.md), if adopted.
- Whether a test is worth keeping: [`test-audit`](../../test-audit/SKILL.md). Model checks and property tests: [`proof-tiers`](../../proof-tiers/SKILL.md).
