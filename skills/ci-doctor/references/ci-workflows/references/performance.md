<!--
What: long test files, and how to find where a slow run's time went.
Where: read by an agent when splitting a long file or diagnosing a slow run.
Configure: your repo's own sizes and their measurements go in `.agents/repo/ci.md`.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Slow runs

Part of the [`ci-workflows`](../TOPIC.md) topic: long test files and how to find where a slow run's time went. Read it when splitting a long file or diagnosing a slow run. Runner sizes, packing and shard counts against a runner's size are in [`ci-runners`](../../../../ci-runners/SKILL.md). [guide section 7](../../../../../docs/pages/07-shards-runners-and-billing.md) has the design.

Read current runners, file concurrency, retries, shard limits and job dependencies in the workflows and scripts ci.md names. Do not copy those settings here.

## A long test file

A shard can't end before its longest file, where the runner doesn't split a file (Vitest doesn't, nor does Jest; check yours). So keep each file that runs in the ordinary shards under the repo's per-file cap, as ci.md names it with its statistic and exemptions (about 90 s in the source repo): split one that grows past it by what its tests are about, into files named for its source file, or shorten its waits. Files that once ran in a slow job of their own, each well past that, were split into about three times as many files under it, and run in the shards since.

A file's tests run one after another, on one worker, so a file of a few slow tests sets the floor as much as one of many. Split the slowest checks into files of their own.

## When a run is slow

1. Read the run's job graph and each job's steps with `gh run view <run-id> --repo <org>/<repo> --json jobs`: queueing, setup, a wait on another job or the work itself. The job that ended last isn't always the limiter. For a sharded run, `scripts/ci-time.ts --shards <run-id>` from this skill's folder lists each shard's slowest file lines (with `--bill blacksmith`, each shard's CPU, if you run on Blacksmith).
2. A shard waits on its slowest file. Split that file or shorten its waits, as [keep slow test files out of the shards](../../checks/ci-keep-slow-files-out-of-the-shards.md) says. When no file sets a shard's floor, lower the tests each shard takes only after measuring, since each shard pays its setup again, as [shards and runner size](../../../../ci-runners/references/sizing.md#shards-against-a-runners-size) says.
3. For jobs packed by estimated seconds, update the estimates only from fresh elapsed times of files that ran, from a run whose selection you checked against the full inventory, as ci.md says where they live. List the files with no fresh time and give each a labelled, conservative estimate. A sum of printed case durations is only a lower bound, as [measuring](../../../../speed-up-tests/references/measuring.md#comparing-before-and-after) says.
