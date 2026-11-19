<!--
What: a check that no test file is long enough to set a CI shard's floor.
Where: read by an agent when a run is slow, or after adding or growing a test file.
Configure: the shard cap, its statistic and exemptions in `.agents/repo/ci.md` (90 s, newest runs' median, here), your test helpers' folder (<app-dir>/src/testing/), and ci-time.ts's config.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Keep slow test files out of the shards

**Moment:** building, then after it lands · **Concern:** tests and CI

## Check

This check owns the split. It covers the files eligible for the ordinary shards; a file the repo runs in a later tier or a job of its own, as ci.md lists its exemptions, is out of scope.

- [ ] No file eligible for the ordinary shards is over the shard cap ci.md names, by its statistic, from fresh elapsed times of runs that executed it.
- [ ] A file that is over it is split along its `describe`s, or its waits are shortened.
- [ ] No test waits out a timer in the code it runs, such as a hold, a silence, a deploy's reach or a step's sleep. The harness shortens it, or the test moves the recorded time back instead.
- [ ] Files with no fresh time are listed, not assumed fast. A shard can't end before its longest file does.

## How

- Rank files from the records collector's fresh times, as [measuring](../speed-up-tests/references/measuring.md#reading-cis-records) says. [`ci-time.ts`](../ci-workflows/scripts/ci-time.ts)'s `--shards <run-id>` gives one run's file lines for a first look; they may be replays, and the run may not have selected every eligible file.
- Read a slow file's tests by time in its shard's log, where each test's line follows the file's own with its milliseconds. A test that takes about as long as a timer in the code it runs is waiting on that timer.
- Split a file along its `describe`s, with the helpers they share in a testing folder such as `<app-dir>/src/testing/`.
- Move a recorded time back instead of waiting: a helper that moves a run's "retired at" time back past the 15 minutes a deploy takes to reach every instance turns a 15-minute wait into none.

## Why

In the source repo (amounts are relative):

- In the first week, one check-runs test file took several minutes alone and set a shard's floor. Splitting it into six files, the longest well under the limit, let a run use three shards.
- A few days later, newer files set the floor again. In one run, six files held about two fifths of the run's test time. The slowest held its shard far past the other two: its tests ran one after another, while five of the shard's six workers sat idle behind it and the shards' median CPU stayed low.
- Much of that time was spent waiting on real timers: a permit test waiting out the period a silent holder keeps its permit, browser tests waiting out a link's hold, and image-deploy checks that slept on purpose so a deploy landed while they ran.
- Before slow files were selected by nearness, each PR that reached the server ran every slow file, about three merges in four. Replayed on them, the slow list would still have run at least one for most merges.
- That week, letting the test worker control timestamps and short timers cut the permit file to about a seventh of its time. Backdating stored holds split the browser file into three short ones, and splits took the other slow files to a handful each, all under the limit.
- Twice more over the next two weeks, a few shard files had grown past the limit. Splits brought them back under, with retry delays in the workflows under test cut from a second to a millisecond. One split leaned on a harness clock ten times faster for its deadlines, which was taken out after it flaked. Giving a container step's retries a millisecond backoff instead of the SDK's own took another file well under.
- In the fourth week, the files in the slow list were split into files under the limit, moved into the shards, and the list and its job were deleted. Shards are sized at about two minutes of tests each from the sweep's times, so a file over 90 s is most of a shard. Each split adds a harness start, so split only what's over the limit.

## Pointed at from

- [`ci-workflows`](../ci-workflows/references/performance.md), when a run is slow.
- [`speed-up-tests`](../speed-up-tests/references/fixes.md#a-long-file), on a long file.
- [Measure CI before changing it](ci-measure-before-changing-it.md).
