<!--
What: how to move a test to a later tier, how to choose the sweep's cadence, and how to add a scheduled run.
Where: read by an agent before moving a test off pull requests, choosing or changing how often the sweep runs, or adding a scheduled run.
Configure: your tiers and covered-only list go in `.agents/repo/ci.md`; the scheduled spend within <monthly-cap>.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Which tier runs a test

Part of the [`ci-workflows`](../SKILL.md) skill. Read it before moving a test off pull requests, choosing how often the sweep runs, adding a scheduled run, or asking whether a test should wait for the sweep or a release. [guide section 5](https://ci-doctor.ref0.dev/guide/docs/pages/05-tiers-what-runs-where.md) explains the tiers.

## The tiers

Read each from its source, as `.agents/repo/ci.md`'s Selection and tiers names them: what a pull request selects, what scheduled runs check, and what a release waits for. Where a release publishes only what a passing sweep checked, a test the sweep runs already gates every release, and a tier of its own for releases adds nothing.

## Checking pull requests only in the merge queue

A repo can run nothing on a pull request and build each one in its merge queue instead. One open-source repo does: its pull requests run no checks, a maintainer picks what enters the queue, and each group builds once on a self-hosted runner in under three minutes. It's a tier choice like any other, and it fits only when all of these hold:

- **The queue's build is fast,** a few minutes, since it's now the first result an author sees. A slow one turns every fault into a dropped entry and a second wait.
- **Someone chooses what enters,** a maintainer or a review that scales with the change's risk, as [`review-gate`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/review-gate/references/risk-tiers.md) describes. With no PR run, nothing else stops a broken change from taking a queue slot.
- **Authors can run the same selection locally,** from one impact map CI and the local command share, so a fault is found before the queue, not in it.
- **A full gate runs somewhere,** such as a nightly run, and the selector is audited against it, as [`optimize-graphs`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/optimize-graphs/references/selection.md) says.
- **A dropped entry is put back,** by a person or a job that re-enqueues what a flake or a neighbour's fault removed.

Where one is missing, keep a PR run. State in the pull request what an author loses: a result before review, and a check on a PR nobody queues. The scorer reads such a repo's `merge_group` runs as its pushes and reports a merge-queue wait.

## Moving a test to a later tier

1. **Map what already holds it back,** such as a selection that runs a test only when it's near the change, or a cache that replays a package's tests when nothing they read changed. A test that runs on few pull requests saves little by moving and, for a Git oracle, would skip exactly the runs that change its code.
2. **Count what each tier catches.** Read the failed runs: which tier found each real fault, and what finding it later would have cost. Say how many days of records the count rests on; an absence of failures over two days proves nothing.
3. **Split the light tests out first.** A file mixes a few heavy proofs with quick ones. Move only the heavy ones, into files of their own, and leave the rest where they ran. Time each case first: a 25 s file of 70 cases held none over 1.2 s, so nothing in it was worth moving.
4. **Run it on the pull requests that touch what it proves.** Add it to the repo's covered-only list, as ci.md names it, with the paths whose change could alter the proof's result: its code, the contracts and migrations it reads, the test helpers it imports, and the test itself. Check them against the modules its run loads; don't copy them from the file it left. Hand-made lists missed Git commit, pack-writing and pack-reading code, and a queue's search and removal modules, each shown by a one-line change there that selected no proof. Don't take the whole module graph either: a test that loads most of a server would then run on more pull requests than before it moved. Name the paths you left out on purpose, and why, in the pull request.
5. **Check every selector.** Where CI and a local run select through different modes, as ci.md says, each has to apply the covered-only list. A covered path missing from one ran no proof there until a test failed without it.
6. **Check a run that selects everything.** Where the plan drops a covered-only file from it, the move takes it out of full pull request runs too. Say so when that widens what the change does.
7. **State the cost and the delay** in the pull request: the test-seconds a run saves, the minutes a month, and how long a fault it would catch can now sit on main.
8. **Keep a deep proof honest in its new tier.** A model or property test keeps its cheap PR run and its breaks, as [`proof-tiers`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/proof-tiers/SKILL.md) says.

## Replaying recorded sessions

To test a path that depends on an outside tool that is slow, paid or nondeterministic, such as an agent harness calling a model, replay what it sent instead of running it. [guide section 5](https://ci-doctor.ref0.dev/guide/docs/pages/05-tiers-what-runs-where.md#replaying-recorded-sessions) has the why.

1. **Choose the boundary** where your code first reads the tool's output: its hook payloads, the commands it runs. Record there, and replay through every layer of yours behind it: client, local service, CLI and server.
2. **Sanitize by contract.** A schema says, per field, what a recording may keep; everything else becomes synthetic text, and names a person chose become stable placeholders within the recording. A fixture check that fails any recording keeping more runs locally and on each PR.
3. **Replay deterministically,** with no live tool and no model, on the PRs whose paths reach it (step 4 above) and in the sweep.
4. **Test the capture workflow** with a scripted model, so recording again doesn't wait on paid calls.
5. **Keep a live compatibility proof** against the real tool on a slower tier, and record again when the tool changes.

## Choosing the sweep's cadence

How often the default branch's full sweep runs is recurring spend against how long a break can hide, so the user chooses it, from this repo's numbers. Never copy a schedule from a template or another repo.

1. **Measure, read-only.** Run [`sweep-cadence.ts`](../scripts/sweep-cadence.ts) from the repo's checkout, naming the sweep's runs and its test jobs as ci.md does: `node <skills-dir>/ci-workflows/scripts/sweep-cadence.ts --sweep-title '<the sweep's run title start>' --test-job '<the test jobs' name start>'`, or `--sweep-event push` where every push to the default branch runs everything. It reads, from `gh`:
   - the merges a day, counted as first-parent commits, the commits a bisect walks, so a rebase-merged PR counts once per commit;
   - a full sweep's job-minutes, from passing runs that ran a test job;
   - what a slot with nothing new costs, from passing runs that ran none;
   - a PR run's job-minutes against a sweep's;
   - the releases;
   - the slots' time of day, from the sweep workflow's `SWEEP_CRON` or cron, or `--slot HH:MM` (UTC). It says which it used.

   It prices five crons at that time of day: every 6 hours, every 12 hours, daily, every 2 days and weekly. Add `--option '<cron>'` for another. Give it at least 14 days, twice the longest gap you'll price, over the calendar's whole cycle: a schedule it can't observe twice is marked unavailable. It reads the sweep's runs newest first until 10 full ones. With none, it prices nothing, and says whether the window held none or GitHub's limit of 1,000 listed runs stopped it first.
2. **Show the user every schedule** with its monthly job-minutes (priced at list price where ci.md has prices), and the merges a missed break can hide behind it at the 90th percentile and at most, with the bisect steps, about log2 of that many. A slot with nothing new runs only its plan, so a short schedule costs little on a quiet repo. A bursty repo's busy days hide the most: if its "most" is much more than its p90, a shorter schedule caps it.
3. **Say what bounds it.** Where the sweep gates the release, a release waits for the next passing sweep, so a schedule longer than the release's delays it. The more PR selection skips, the more only the sweep checks, and the more a long schedule hides.
4. **Let the user choose,** then record the cron, its date and its numbers in ci.md's Sweep cadence, and set it as the sweep's cron and `SWEEP_CRON`, as the [sweep template](https://github.com/ref-0/ci-doctor/blob/v0.4.0/templates/github/workflows/sweep.yml)'s header says. Its fallback for a missed cron finds the newest slot with `cron.ts`, this skill's cron reader, so any schedule works there unchanged. ci-doctor doesn't trigger a sweep by merge count, on purpose: a cron's cost and what it can hide are what's measured and chosen. Measure again when merges a day or a sweep's cost move by half, or the release cadence changes.

## Sweep cadence and shard times are separate decisions

How often the sweep runs decides how soon a break that PR selection skipped shows up, and what a release waits for where the sweep gates it. That's the user's cost and risk choice: daily, every few hours or weekly. It doesn't decide how even the shards are. Every run balances from the stored file times, which the sweep refreshes, and how old they are barely matters. In the source repo's CI, 17 to 20 November 2026, a split by fresh times put its busiest shard at 1.001 times the best split's. With times a week old it was 1.014 at the median and 1.072 at the 90th percentile (modelled from measured drift, new files on their estimate), against 1.146 for an equal count of files. So a sweep at any cadence, weekly included, keeps the times fresh enough; a new file runs on a cautious estimate until the next one. Choose the cadence without counting shard times in, as [`ci-runners`' shards](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-runners/references/shards.md#5-keeping-the-times-current) say.

## Adding a scheduled run

- **Agree its cost with whoever owns the budget first,** and size it within that, in billed minutes a month at list price against `<monthly-cap>`, as [`ci-runners`' billing](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-runners/references/billing.md) says.
- **Select from the newest passing ancestor,** run nothing when that is the head or no change reaches what it checks, and run everything when no ancestor passed.
- **Give it a run name of its own.** Where only the daily sweep may close main's failure issue, a narrower run's name mustn't start like the sweep's. A narrower run names the merges since its base when it fails.
- **Don't trust the cron.** GitHub starts scheduled runs late or skips them. A merge after a slot starts the run when nothing has since, choosing the newest slot and taking turns, so a late cron can't start it twice.
- **Check its first run at the time it should start,** then read the result: a started run isn't a passing one. List what the new tier lacks next to the sweep, such as a bisect, the health check's counts or saved shard times, as issues.

## Tests against real containers

Tests that run the repo's code against real containers are the slowest, and their imports may not say what they check. Where the repo has them, ci.md's Real-container files table says which file checks which boundary, the hidden inputs (bundles, disks, images) that select it, and the command to run it by hand: read it when a sweep fails one, or to choose which to run by hand before a risky change merges. Update it when you add such a file or move what one covers.
