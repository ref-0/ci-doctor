<!--
What: a check that a job's runner size follows its measured CPU, not a guess.
Where: read by an agent before changing a job's `runs-on`.
Configure: in `.agents/repo/ci.md`, the sample size, the CPU line (40% here) and your runner labels with their prices and units.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Size a runner by its CPU

**Moment:** designing · **Concern:** cost

## Check

This check owns the decision to resize a job.

- [ ] A job's median and p90 CPU, and its peak memory, are read from at least the sample ci.md names (three runs here) before its runner changes size.
- [ ] A job moves down a size only when its median CPU stays under ci.md's line (about 40% here), its p90 isn't near saturation, its memory has room on the smaller runner, and it isn't on the run's critical path.
- [ ] Low CPU on a critical-path job is explained before a resize. A tail behind one slow file, or a wait on a timer, doesn't mean the runner is too big.
- [ ] The p90 is read beside the median: a p90 near 90% means half the cores would run the busy minutes CPU-bound.
- [ ] The proposed runner is compatible with the job (architecture, image, tools), is priced per ci.md, and is checked on a real run before it's called done.
- [ ] Where the provider rounds each job up to a minute, the job's work, setup included, packs to just under a minute boundary.
- [ ] A job that waits on Docker or the network can take the smallest compatible runner (x64 in the source repo, for its images).

## How

- Read a job's CPU from the provider, or sample it in the job yourself (`/proc/stat` or `vmstat 5` in a background step), as [sizing](../ci-runners/references/sizing.md#size-and-architecture) says. If you run on Blacksmith, `blacksmith jobs stats <job-id> --format json` has it at `.vm_metrics.cpu.aggregates`; read jobs one by one, or with `node <skills-dir>/ci-workflows/scripts/ci-time.ts --bill blacksmith` ([CLI](../blacksmith/references/cli.md)).
- Read the provider's unit and rounding for each label from ci.md, as [billing](../ci-runners/references/billing.md#packing-against-minute-rounding) says. Where each job rounds up to a minute, a 61 s job bills as much as a 119 s one. Setup was a large slice of each job's first minute in the source repo until a warm install cut it to a small one ([caches](../../../cache-ci/references/caches.md)).
- Each job's `runs-on`, and the comment above it, say which runner it takes and why.

## Why

In the source repo (amounts are relative):

- In the first week, each job's runner followed its median CPU: a job per part of a slow file used about a tenth of its cores, so those parts went back into the shards; the test shards stayed on 8 vCPU at about two thirds CPU; container jobs at about a fifth of 4 vCPU moved to 2 vCPU, packed to just under three minutes each; and build, format, lint and types at about a third of 8 vCPU moved to 4 vCPU, never the run's longest job.
- A few days later the shards' median CPU was low but their p90 was over half. That was the tail of one slow file, not a runner too big: a smaller runner would have slowed their busy minutes and saved nothing on the tail ([keep slow files out of the shards](ci-keep-slow-files-out-of-the-shards.md)).
- The published CLI's check spent over half its time on toolchain setup, and fit one started minute on 2 vCPU.
- After the slow files left the shards, six workers a shard ran at about half CPU at the median and three quarters at p90. Nine workers a shard made them CPU-bound and slower ([what was tried](ci-read-what-was-tried.md)), so a shard's CPU around half doesn't mean it can take half again as many files.
- The slow files' job ran at about a tenth of 8 vCPU, waiting on timers. Nine at once on 4 vCPU took as long as six at once on 8 vCPU, for half the minutes.
- The next week the slow job's median CPU on 4 vCPU was under the 40% line, but its p90 neared 90%. On 2 vCPU it ran CPU-bound at the median and took about a third longer.

## Pointed at from

- [`ci-runners`](../ci-runners/references/sizing.md), choosing a runner.
