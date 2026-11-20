<!--
What: a check that a change to CI is priced and modelled from measured runs before it's built, and measured again after.
Where: read by an agent designing a change to CI's jobs, shards, runners or selection.
Configure: the repo's `.agents/repo/ci-time.json` (repo, workflow, shard prefixes, runner labels, each label's <price-per-minute>).
Reference implementation from a production monorepo; adapt to your repo.
-->

# Measure CI before changing it

**Moment:** designing, then after it lands · **Concern:** cost

## Check

- [ ] Spend is priced by job and by event over a complete window, with every attempt, at each label's list price, as [billing](../ci-runners/references/billing.md#auditing-spend) says. Exact (from a bill), estimated (from labels) and unpriced parts are reported apart.
- [ ] Latency is measured over first attempts, with the clock named, as [CI history data](../../../speed-up-tests/references/ci-history-data.md#name-the-clock) says.
- [ ] The limiter is named from the job graph and step timestamps: queueing, setup, a wait on another job or the work. For a test shard, the file that sets the shard's time.
- [ ] The change is modelled from those numbers, in billed vCPU-minutes and wall time, before it's built.
- [ ] Its own PR's run, and the first runs after it lands, are measured the same way and compared with the model.
- [ ] Any table of estimated file times the plan packs jobs by holds fresh elapsed times from runs since the last change to those files, over a checked inventory; files with none are listed, with a labelled, conservative estimate.
- [ ] Every number is labelled observed, replayed or modelled, and the PR names the normal run that will observe what's still modelled.

## How

- For a first look, run [`ci-time.ts`](../ci-workflows/scripts/ci-time.ts) from the repo's checkout: a spot check of the newest runs' latest attempts, by job and by event, with each run's checks span, time to the gate and the job that ended last, then the newest large run's shard logs. Its help says what each number leaves out. With `--bill blacksmith`, on Blacksmith, it takes billed minutes and each shard's CPU from Blacksmith ([CLI](../blacksmith/references/cli.md)).
- For the baseline itself, collect a closed window with every page and attempt, as [CI history data](../../../speed-up-tests/references/ci-history-data.md#a-collection-that-pages-everything) shows.
- By hand, `gh api repos/<org>/<repo>/actions/runs/<run-id>/jobs` gives each job's `started_at`, `completed_at`, steps and runner `labels`. With Vitest's default reporter, a shard's files by time are the `✓ [<project>] <file> (<n> tests) <ms>ms` lines in `gh api --allow-escape-sequences repos/<org>/<repo>/actions/jobs/<job-id>/logs`; a log line doesn't say whether the file ran or a cache replayed it.
- Price each label at its list price and unit, as [budget CI at list price](budget-ci-at-list-price.md) says. Quote a money total only when every label is priced.
- To model a shard layout, take each file's fresh elapsed time from runs that executed it, check the selection against every eligible file at that commit, and fill the shards' workers longest file first. List files with no fresh time and give each a labelled, conservative estimate. Count each shard's setup and, where the provider rounds per job, its whole started minutes. A run with many shards isn't proof it selected every file, and one ready run rarely measures both a full and a small run.
- Print each file's time in every job: a verbose reporter that prints only tests' times can't check a file's estimate.
- Audit spend over equal, complete windows, as [billing](../ci-runners/references/billing.md#auditing-spend) says, and collect history as [CI history data](../../../speed-up-tests/references/ci-history-data.md) says.

## Why

In the source repo (amounts are relative to the same repo's earlier runs):

- In the first week, measuring each job's CPU and minutes cut a full run's billed vCPU-minutes by more than half.
- Five days later those numbers were wrong. Over the last 100 runs that did work, the test shards billed about two thirds of the spend, the container-test jobs about a fifth, and build, format, lint and types under a tenth. A test shard finished last in most passing runs. `main`'s runs billed far more than a PR's, mostly container jobs, since most of its merges ran every container file. The shards ran at low median CPU behind one slow file, where the skill still described busy shards, as [keep slow files out of the shards](ci-keep-slow-files-out-of-the-shards.md) says.
- The model ruled out a change before anyone built it. Splitting the shards by time instead of by count left them about where they were, since one file took longer alone than a shard's share. Capping every file's time instead modelled about a quarter fewer vCPU-minutes a full run ([what was tried](ci-read-what-was-tried.md)).
- From those numbers, `main`'s checks moved from every merge to a scheduled sweep, and the slowest files ran only when a change reached them.
- A weekly audit found daily spend had roughly halved from the week before, with the test shards most of it.
- That week, dozens of test failures passed when the same commit ran again, and reruns cost a few percent of the month. The selection rules held: no docs-only PR ran tests, and each test-only PR ran one or two files. But PRs that changed only the release workflow ran every test.
- The next week's audit found spend up about a third, most of it in new jobs. A macOS build in every release from `main`, plus runs by hand before macOS moved to releases only, was the largest new cost, at several times a Linux minute. At that rate the month would reach its cap early. The container step's verbose reporter printed no file times, so several files ran well over their estimates unseen; adding the default reporter fixed it.
- That week, about one PR run in nine ran every ordinary test file, most because they changed a path no package owned, such as scripts and skills' tooling. Every docs-only and test-only head sampled ran narrow. Two sweeps caught real breaks that the PRs' nearness runs had left out.
- Three sweeps failed on GitHub's artifact storage quota. Moving binary handoffs out of artifacts relieved that first outage. A later outage still failed passing shards while they saved control records, so claims, flakes and timings moved to the cache too. Trusted pass provenance and other retained artifacts remain separate quota dependencies.

## Pointed at from

- [`ci-workflows`](../ci-workflows/TOPIC.md#measuring-a-run), measuring and slow runs.
- [`speed-up-tests`](../../../speed-up-tests/references/measuring.md).
- [Budget CI at list price](budget-ci-at-list-price.md).
