---
name: speed-up-tests
description: "Makes slow tests faster without losing what they prove: finds the slowest files and takes out what each waits on. Use when a test, a test file or a suite is slow, in CI or locally, or tests time out. Not for a flaky test (fix-flaky-test); whether a test is worth keeping (test-audit)."
metadata:
  version: "0.4.0"
---

# speed-up-tests

A slow test is usually a test that waits: on a production period it inherits, a retry's backoff, a poll, a sleep that arranges a race, or a wall-clock window. A test that does real work at the size it proves is usually fine as it is. The job is to tell the two apart from CI's own records, take the wait out while every assertion still holds, and show it in CI. The waits worth most are shared: one in a helper, a fake or a production constant reaches dozens of files.

[The checks](references/checks.md) this skill follows are here in short: read them before you change a test or quote a number.

## Start here

- **The repo has `.agents/repo/speed-up-tests.md` and CI keeps per-file times:** read the facts file, then start at step 1. [Start here](references/setup.md#with-the-repos-facts-file) says what it holds.
- **No facts file:** read [with no facts file](references/setup.md#with-no-facts-file).
- **A test that's slow locally, or no CI records:** take [a local baseline](references/setup.md#a-test-thats-slow-locally-or-no-ci-records). Then start at step 2.

## 1. Find them from CI's records

When CI keeps per-file times, read [finding the slow files](references/measuring.md#finding-the-slow-files) before you rank them, and [the tools](references/measuring.md#the-tools) to run the records collector or `ci-time.ts`.

## 2. Sort each one by why it's slow

For each file, name the wait before you change anything: what it waits for, how long, and what it proves.

Give each file a verdict: slow for a wrong reason (which), real work, or unknown with what to measure. Look across the verdicts for shared causes before fixing any one file, and check the biggest claims against the code yourself.

Once you've named the wait, read [the kinds and their fixes](references/fixes.md) for the fix that kept the proof. A wait may sit behind another: trace every layer before you pick one.

## 3. Keep what each test proves

- **Never** add a retry, raise a timeout alone or skip a test to make it faster. A retry that passes is a reason to look closer, not a fix.
- **Time the event the test claims,** not something after it that can stall too.
- **Mutate the code, with the user's yes for the work, in a disposable checkout:** break what the test guards and see it fail for that reason, with retries off and the test run uncached, so no cache replays a pass. Restore the source, and keep the mutation out of commits and CI. A faster test that no longer fails is worse than useless.
- **Repeat the whole file locally with no retry,** several times in a row, since a fix in one test can break its neighbours.
- **Make the assertion stronger if you can.** Waiting for the event itself often proves an order the old sleep only hoped for.
- **A retry starts from fresh state:** names, holds and records the first attempt left.

When the test proves a deadline or a race, or a proof moves to a later tier, read its kind in [the kinds and their fixes](references/fixes.md).

## 4. Measure before and after, the same way

Read [measuring](references/measuring.md) before quoting a number.

## 5. Ship it and see it in CI

Before you open the pull request, read [shipping](references/shipping.md).

For many files at once, with briefs and engineers, read [running a campaign](references/campaign.md). Before building a shared runtime, a resident helper, a separate fast command or a test mode, read [what not to build](references/fixes.md#what-not-to-build).

## Fakes

Fake what the repo doesn't own and that limits, costs or varies; keep real what the test proves, as [fakes](references/fakes.md) says.

## Stack pages

The method holds on any stack. Where your stack matches, these say what was specific to it:

- if your stack runs on Cloudflare Workers (workerd, Durable Objects, Wrangler): [Workers](references/workers.md);
- if your stack uses Effect: [Effect](references/effect.md).

## Not here

- A test that fails sometimes, or passes only on a retry: [`fix-flaky-test`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/fix-flaky-test/SKILL.md). A flake is a wrong answer, not a slow one.
- Shards, planned and run by measured time: [`ci-runners`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-runners/references/shards.md). Tiers: [`ci-workflows`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-workflows/SKILL.md); caches, [`cache-ci`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/cache-ci/SKILL.md); selection, [`optimize-graphs`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/optimize-graphs/references/selection.md); runner size, queues and cost, [`ci-runners`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-runners/SKILL.md). How far an edit reaches through the workspace: `optimize-graphs`.
- Whether a test is worth keeping at all: [`test-audit`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/test-audit/SKILL.md); its authoring gate applies to any test you add.
- Taking a PR through CI: [`ci-merge-workflow`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-merge-workflow/SKILL.md); [`review-gate`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/review-gate/SKILL.md) for its tests reviewer.

## Outside this skill

Every link that leaves this folder is a full link, so it reads the same with this skill installed alone: the guide at [ci-doctor.ref0.dev/guide/](https://ci-doctor.ref0.dev/guide/), and the hub, the other skills and the tools in [the ci-doctor repo](https://github.com/ref-0/ci-doctor) at the tag `v<version>`, the release this skill names in `metadata.version`.
