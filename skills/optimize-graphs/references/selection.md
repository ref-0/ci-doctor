<!--
What: rules for changing which checks a change runs.
Where: read by an agent before changing the selector, lockfile routing or test selection.
Configure: your repo's selection cases go in `.agents/repo/ci.md`'s Selection and tiers.
Reference implementation from a production monorepo; adapt to your repo.
-->

# What a change selects

Part of the [`optimize-graphs`](../SKILL.md) skill: how to change which checks a change runs. A selector walks the graphs this skill measures, so it can only be as narrow as they are. Read it when changing what selects checks, lockfile routing or test selection. [Guide section 4](https://ci-doctor.ref0.dev/guide/docs/pages/04-run-only-what-a-change-can-reach.md) explains the selector.

## Start here

- **The repo has `.agents/repo/ci.md`:** its Selection and tiers says what each kind of change reaches, what a path the selector doesn't know runs, the sentinel cases that must select everything, the covered-only list and the jobs by ID. Read it first.
- **No facts file:** ask once whether the repo keeps these facts elsewhere. Otherwise find the selector in the workflows: `paths:` and `paths-ignore:` filters, a planning job and the script whose outputs later jobs' `if:` read, a path-filter action, a test runner's changed-files mode (`--changed`, `related`), or a task runner's affected mode (`turbo run --affected`, `nx affected`). Write down what each kind of change selects, what an unknown path falls back to, and which cases must select everything, and say which you read from code and which you assumed. At the end, offer to write ci.md's Selection and tiers from [the template](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/agent-knowledge/templates/repo-facts/ci.md#selection-and-tiers).

## Rules for a selector change

These hold instead of the package-refactor rules in the skill's Rules: a selector change edits CI, not the user's code.

- **Its own pull request,** separate from any package refactor, so a missed test traces to one change.
- **Keep the current selector** until the new one, replayed against real diffs and past regressions, picks every test the old one did that the change can reach. Name each test it drops on purpose, and why.
- **Keep the fallback wide.** An unknown path selects everything, or the fallback ci.md names, and the sentinel cases stay tested.
- **Check it against real output,** as the hub's [check a change to CI against real output](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/ci-check-a-workflow-change.md) says, and state its effect on a full and a small run and its cost a month. The rest of a workflow change is [`ci-workflows`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-workflows/SKILL.md)'.

## Changing selection

- Read the selected files in a run's log, not its checks: a run of all-green checks once ran nearly two hundred server files and neither of the two the change was for.
- Apply a left-out list after grouping files into tasks, not only to the shard lists. A group runs all its files, so two slow left-out oracles ran in every run that missed their group's cache.
- Read the [plan's selection reasons](https://github.com/ref-0/ci-doctor/blob/v0.4.0/templates/plan/README.md#selection-reasons) to audit a missed test or a selection that looks too broad.
- An edge no import shows, a generated bundle or a file read from disk, goes in as a named edge, as an SDK bundle the tests read from disk did. Prefer it to running everything for that path.
- Replay real pull requests' diffs through the old and new selector, and read every decision that changed: one change replayed about 150 and narrowed about one in fourteen.
- Run the selector from the checkout whose source it reads. A selector that finds the repo from its own path, not the shell's folder, reads the wrong tree when a copy runs elsewhere.
- Measure a built-in before building one. Vitest's `--changed` and `related` follow every import, through barrels and workspace packages, and no bundle: for one edit they picked nearly half the suite.
- Whether a cached pass may replay and whether a test is near a change are different questions. A group that reads a whole bundle misses its cache on any change to it; only selection narrows it.
- A barrel picks everything behind it. Before blaming source resolution, count the modules an entry point loads and the files a change selects, before and after.
- Selection and reuse are separate decisions. Adopting a standard task runner or cache doesn't justify replacing semantic selection with its package graph: replay the replacement against historical diffs and the explicit disk, generated-code, bundle and config edges, and keep the existing selector until it preserves the coverage. A manifest-only replacement once missed tests on most of the PRs it was replayed on.
- Track discovery too: a directory listing a test enumerates, a path it probes that's missing, a symlink it resolves. A new config or test file changes behaviour without changing any file the last run opened. Exclude only listings proved irrelevant, and test additions, deletions and missing-to-present as well as edits.
- Record how the selector treats a path it doesn't know, in ci.md's Selection and tiers: a planner that falls back to every job, or one that needs each new job or path registered. Test that fallback, and the sentinel cases ci.md lists, with each change.
- Treat the selector like production code: test it, and check a change to it against real output, as [check a change to CI against real output](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/ci-check-a-workflow-change.md) says.

## Replay past regressions

Replaying diffs checks that two selectors agree, not that either catches a real bug. So also replay past bugs that a test caught, as [OpenClaw's CI write-up](https://vincent.build/openclaw-ci-cost-reduction) describes. For each bug:

1. Find the diff that introduced it, and the test that caught it. If the fix added that test, add the test to the diff's base first.
2. Run the selector on that diff, from its base, and check that it picks the test.
3. Run the test on the broken tree and check that it fails for the expected reason.

Fix a miss with a named edge or a wider fallback, then replay that bug again.

## Audit the selector against the full gate

A replay checks a selector before it ships. An audit checks the one that's running, against what the full gate found since. Where a sweep or a queue runs everything the selector left out, do one each quarter, and after any failure there that a pull request's checks should have caught. [moq's audit of a month of merge groups](https://github.com/moq-dev/moq/blob/main/.github/ci-selection-audit.md) is one to copy.

1. **Fix the window, and freeze it:** its two dates, the events read and the query, so later runs can't move the denominator. Say what's left out and why, such as skipped runs.
2. **Classify every attempt by the rules of its own commit.** Diff each attempt's base against its head, and read the selector as it was at that head, not today's.
3. **Count how often each widening rule fired,** as a share of the classified attempts, and which path triggered it. A rule that forces everything on a tenth of changes is the next thing to narrow. One that never fired isn't costing anything.
4. **Read every failure of the full gate for a missed edge.** For each, ask whether the selector picked the failing check on the change that broke it. A miss becomes a named edge or a wider fallback, then a [replayed regression](#replay-past-regressions).
5. **Commit the audit with its evidence,** a file of each attempt's SHAs, run id, conclusion and trigger beside the write-up, so the next audit starts from it and a reader can check a count.

The audit's answer is one of three: keep a rule, narrow it, or add an edge. Record each with its count, in ci.md's Selection and tiers.
