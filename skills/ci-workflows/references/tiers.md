<!--
What: how to move a test to a later tier, and how to add a scheduled run.
Where: read by an agent before moving a test off pull requests or adding a scheduled run.
Configure: your tiers and covered-only list go in `.agents/repo/ci.md`; the scheduled spend within <monthly-cap>.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Which tier runs a test

Part of the [`ci-workflows`](../SKILL.md) skill. Read it before moving a test off pull requests, adding a scheduled run, or asking whether a test should wait for the sweep or a release. [guide section 5](https://ci-doctor.ref0.dev/guide/docs/pages/05-tiers-what-runs-where.md) explains the tiers.

## The tiers

Read each from its source, as `.agents/repo/ci.md`'s Selection and tiers names them: what a pull request selects, what scheduled runs check, and what a release waits for. Where a release publishes only what a passing sweep checked, a test the sweep runs already gates every release, and a tier of its own for releases adds nothing.

## Moving a test to a later tier

1. **Map what already holds it back,** such as a selection that runs a test only when it's near the change, or a cache that replays a package's tests when nothing they read changed. A test that runs on few pull requests saves little by moving and, for a Git oracle, would skip exactly the runs that change its code.
2. **Count what each tier catches.** Read the failed runs: which tier found each real fault, and what finding it later would have cost. Say how many days of records the count rests on; an absence of failures over two days proves nothing.
3. **Split the light tests out first.** A file mixes a few heavy proofs with quick ones. Move only the heavy ones, into files of their own, and leave the rest where they ran.
4. **Run it on the pull requests that touch what it proves.** Add it to the repo's covered-only list, as ci.md names it, with the paths of the boundary it proves: its code, the contracts and migrations it reads, the test helpers it imports, and the test itself. Name the paths you left out on purpose, and why, in the pull request.
5. **Check every selector.** Where CI and a local run select through different modes, as ci.md says, each has to apply the covered-only list. A covered path missing from one ran no proof there until a test failed without it.
6. **Check a run that selects everything.** Where the plan drops a covered-only file from it, the move takes it out of full pull request runs too. Say so when that widens what the change does.
7. **State the cost and the delay** in the pull request: the test-seconds a run saves, the minutes a month, and how long a fault it would catch can now sit on main.
8. **Keep a deep proof honest in its new tier.** A model or property test keeps its cheap PR run and its breaks, as [`proof-tiers`](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/proof-tiers/SKILL.md) says.

## Replaying recorded sessions

To test a path that depends on an outside tool that is slow, paid or nondeterministic, such as an agent harness calling a model, replay what it sent instead of running it. [guide section 5](https://ci-doctor.ref0.dev/guide/docs/pages/05-tiers-what-runs-where.md#replaying-recorded-sessions) has the why.

1. **Choose the boundary** where your code first reads the tool's output: its hook payloads, the commands it runs. Record there, and replay through every layer of yours behind it: client, local service, CLI and server.
2. **Sanitize by contract.** A schema says, per field, what a recording may keep; everything else becomes synthetic text, and names a person chose become stable placeholders within the recording. A fixture check that fails any recording keeping more runs locally and on each PR.
3. **Replay deterministically,** with no live tool and no model, on the PRs whose paths reach it (step 4 above) and in the sweep.
4. **Test the capture workflow** with a scripted model, so recording again doesn't wait on paid calls.
5. **Keep a live compatibility proof** against the real tool on a slower tier, and record again when the tool changes.

## Sweep cadence and shard times are separate decisions

How often the sweep runs decides how soon a break that PR selection skipped shows up, and what a release waits for where the sweep gates it. That's the user's cost and risk choice: daily, every few hours or weekly. It doesn't decide how even the shards are. Every run balances from the stored file times, which the sweep refreshes, and how old they are barely matters. In the source repo's CI, 17 to 20 November 2026, a split by fresh times put its busiest shard at 1.001 times the best split's. With times a week old it was 1.014 at the median and 1.072 at the 90th percentile (modelled from measured drift, new files on their estimate), against 1.146 for an equal count of files. So a sweep at any cadence, weekly included, keeps the times fresh enough; a new file runs on a cautious estimate until the next one. Choose the cadence without counting shard times in, as [`ci-runners`' shards](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-runners/references/shards.md#5-keeping-the-times-current) say.

## Adding a scheduled run

- **Agree its cost with whoever owns the budget first,** and size it within that, in billed minutes a month at list price against `<monthly-cap>`, as [`ci-runners`' billing](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-runners/references/billing.md) says.
- **Select from the newest passing ancestor,** run nothing when that is the head or no change reaches what it checks, and run everything when no ancestor passed.
- **Give it a run name of its own.** Where only the daily sweep may close main's failure issue, a narrower run's name mustn't start like the sweep's. A narrower run names the merges since its base when it fails.
- **Don't trust the cron.** GitHub starts scheduled runs late or skips them. A merge after a slot starts the run when nothing has since, choosing the newest slot and taking turns, so a late cron can't start it twice.
- **Check its first run at the time it should start,** then read the result: a started run isn't a passing one. List what the new tier lacks next to the sweep, such as a bisect, the health check's counts or saved shard times, as issues.
