---
name: speed-up-tests
description: "Makes slow tests faster without losing what they prove: finds the slowest files and takes out what each waits on. Use when a test, a test file or a suite is slow, in CI or locally, or tests time out. Not for a flaky test (fix-flaky-test); whether a test is worth keeping (test-audit)."
metadata:
  version: "0.4.0"
---

# speed-up-tests

A slow test is usually a test that waits: on a production period it inherits, a retry's backoff, a poll, a sleep that arranges a race, or a wall-clock window. A test that does real work at the size it proves is usually fine as it is. The job is to tell the two apart from CI's own records, take the wait out while every assertion still holds, and show it in CI. The waits worth most are shared: one in a helper, a fake or a production constant reaches dozens of files.

The method behind this skill is [guide section 10](https://ci-doctor.ref0.dev/guide/docs/pages/10-slow-tests-the-method.md), and the harness around the tests [section 8](https://ci-doctor.ref0.dev/guide/docs/pages/08-a-faster-test-harness.md). [The checks](references/checks.md) it follows are here in short: read them before you change a test or quote a number.

## Start here

- **The repo has `.agents/repo/speed-up-tests.md` and CI keeps per-file times:** read the facts file, then start at step 1. [Start here](references/setup.md#with-the-repos-facts-file) says what it holds.
- **No facts file:** ask once whether the repo keeps these facts elsewhere, and otherwise work from what you find and offer to write it at the end, as [start here](references/setup.md#with-no-facts-file) says.
- **A test that's slow locally, or no CI records:** take an uncached local baseline of exactly the named test or suite, five runs with retries off, and split its time, as [a local baseline](references/setup.md#a-test-thats-slow-locally-or-no-ci-records) says. Then start at step 2.

## 1. Find them from CI's records

Collect CI's records of each test file's time, then rank them, with the commands in the repo's `speed-up-tests.md`. A file is slow past the triage cutoff its Thresholds name (10 s in CI in the source repo). Many files just past it can hold more test time than the few far past it, so review every file past it, not the top of the list.

Rank by the median of each file's newest passing runs, over the window its Thresholds name (the newest five in the source repo), the widest spreads, each test that failed or passed only on a retry, and total test-seconds, as [measuring](references/measuring.md#reading-cis-records) says: count only what ran, say what the sample is, and split a failure by commit before calling it a flake. `ci-time.ts` ([`ci-workflows`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-workflows/SKILL.md#measuring-a-run)) prints where a run's time went by job and shard. For API history, read [CI history data](references/ci-history-data.md).

Start from the issues CI files for flakes and failures on `main`, and what other threads already own: `gh pr list --search "<file name>"`.

## 2. Sort each one by why it's slow

For each file, name the wait before you change anything: what it waits for, how long, and what it proves. With many files, batch them by area and give each batch to one reader, as [reviewing every slow file](references/campaign.md#reviewing-every-slow-file) says.

Give each file a verdict: slow for a wrong reason (which), real work, or unknown with what to measure. Look across the verdicts for shared causes before fixing any one file, and check the biggest claims against the code yourself.

[The kinds and their fixes](references/fixes.md) give the fix that worked for each: a production period or retry the test inherits; a sleep that arranges a race; a poll; a pace or floor in production code; a rate limit; a slow fake; a wall-clock window; a fake clock; a long file; an expensive prerequisite; a fixture builder's own CPU; deep setup built one step at a time; a proof that waits for a terminal to go still; and real work, which stays or moves to a later tier. A wait may sit behind another: trace every layer before you pick one.

## 3. Keep what each test proves

- **Never** add a retry, raise a timeout alone or skip a test to make it faster. A retry that passes is a reason to look closer, not a fix.
- **Keep both sides of a deadline:** nothing cut before it, and a cut within a bound after it.
- **Prove a hold orders the race:** delay the other side on purpose; the test passes with the hold and fails without it.
- **Time the event the test claims,** not something after it that can stall too.
- **Mutate the code, with the user's yes for the work, in a disposable checkout:** break what the test guards and see it fail for that reason, with retries off and the test run uncached, so no cache replays a pass. Restore the source, and keep the mutation out of commits and CI. A faster test that no longer fails is worse than useless.
- **Repeat the whole file locally with no retry,** several times in a row, since a fix in one test can break its neighbours.
- **Make the assertion stronger if you can.** Waiting for the event itself often proves an order the old sleep only hoped for.
- **A retry starts from fresh state:** names, holds and records the first attempt left.
- **Moving a proof to a slower tier must keep it honest:** its breaks still run, as [`proof-tiers`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/proof-tiers/SKILL.md) says for models and property tests.

## 4. Measure before and after, the same way

Read [measuring](references/measuring.md) before quoting a number: the same command, field and machine on both sides; interleaved runs at like load; a model or replay labelled as one; and test-seconds, wall time and billed minutes kept apart.

## 5. Ship it and see it in CI

- One shared cause or area per pull request, with the times before and after in its body. Take CI's before from its records and its after from the pull request's own run once it's ready, never from a run by hand. A draft quotes local times.
- Before you merge, read the run's logs: the plan chose the changed files, they ran, and their times match. Green checks can hide a file that never ran.
- A setting added in several parallel pull requests can conflict in a generated file: take main's copy and regenerate it on each rebase.
- After a merge, fix any docs that name a file the change split or renamed.
- Anything only main runs, such as a cron or a sweep's deeper property, gets a check at the time of its first run, which you then read.

For many files at once, with briefs and engineers, read [running a campaign](references/campaign.md). Before building a shared runtime, a resident helper, a separate fast command or a test mode, read [what not to build](references/fixes.md#what-not-to-build).

## Fakes

Fake what the repo doesn't own and that limits, costs or varies; keep real what the test proves, as [fakes](references/fakes.md) says.

## Stack pages

The method holds on any stack. Where your stack matches, these say what was specific to it:

- if your stack runs on Cloudflare Workers (workerd, Durable Objects, Wrangler): [Workers](references/workers.md);
- if your stack uses Effect: [Effect](references/effect.md).

## The tools

The records collector is [`scripts/records/`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/scripts/records/README.md) in the ci-doctor repo, and `ci-time.ts` is in the `ci-workflows` skill, at `<skills-dir>/ci-workflows/scripts/ci-time.ts` in a plugin install. Both run on Node 24 with nothing installed. A skills-only install of this folder carries neither: clone ci-doctor once, outside the user's repo, at the release this skill names in `metadata.version`, and run them from there:

```sh
git clone --depth 1 --branch v0.4.0 https://github.com/ref-0/ci-doctor.git <ci-doctor>
node <ci-doctor>/skills/ci-workflows/scripts/ci-time.ts --help
```

## Not here

- A test that fails sometimes, or passes only on a retry: [`fix-flaky-test`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/fix-flaky-test/SKILL.md). A flake is a wrong answer, not a slow one.
- Shards, planned and run by measured time: [`ci-runners`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-runners/references/shards.md). Tiers: [`ci-workflows`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-workflows/SKILL.md); caches, [`cache-ci`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/cache-ci/SKILL.md); selection, [`optimize-graphs`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/optimize-graphs/references/selection.md); runner size, queues and cost, [`ci-runners`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-runners/SKILL.md). How far an edit reaches through the workspace: `optimize-graphs`.
- Whether a test is worth keeping at all: [`test-audit`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/test-audit/SKILL.md); its authoring gate applies to any test you add.
- Taking a PR through CI: [`ci-merge-workflow`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-merge-workflow/SKILL.md); [`review-gate`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/review-gate/SKILL.md) for its tests reviewer.

## Outside this skill

Every link that leaves this folder is a full link, so it reads the same with this skill installed alone: the guide at [ci-doctor.ref0.dev/guide/](https://ci-doctor.ref0.dev/guide/), and the hub, the other skills and the tools in [the ci-doctor repo](https://github.com/ref-0/ci-doctor) at the tag `v<version>`, the release this skill names in `metadata.version`.
