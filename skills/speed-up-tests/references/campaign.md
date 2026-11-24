<!--
What: how to review and speed up many slow files at once, with read-only readers and engineers in parallel.
Where: read by the agent that coordinates a slow-test campaign.
Configure: the ledger, report and brief templates in the agent-knowledge skill's templates/.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Running a campaign

Part of the [`speed-up-tests`](../SKILL.md) skill. Read it when you review or speed up many files at once, with engineers in parallel. Its examples are from a production monorepo's campaigns. [guide section 10](https://ci-doctor.ref0.dev/guide/docs/pages/10-slow-tests-the-method.md) and [section 15](https://ci-doctor.ref0.dev/guide/docs/pages/15-the-agent-workflow-around-ci.md) say how it fits the rest.

Before planning a campaign, read the repo's tried-and-dropped register, as [read what was tried](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/ci-read-what-was-tried.md) says: don't plan what was dropped unless its limiting condition has changed.

Templates: [ledger](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/agent-knowledge/templates/ledger.md), [report](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/agent-knowledge/templates/report.md), [brief](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/agent-knowledge/templates/brief.md) and [the shared rules every brief carries](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/agent-knowledge/templates/briefs-README.md).

## Reviewing every slow file

1. **List them all,** every file past the triage cutoff `speed-up-tests.md`'s Thresholds name, with hints of its waits, in batches by area, with the repo's script for it, as its `.agents/repo/speed-up-tests.md` says.
2. **One reader a batch,** on a second model, read only, all with one brief: every file read, every claim at `path:line`, a verdict from a fixed list, a saving only from waits the code shows and marked as an estimate, then the shared causes, the tier notes and the batch's best fixes.
3. **Merge the batches by cause, not by file.** The largest findings were shared: a production pace in a reader, a job's wake floor, helpers' slow polls, a fake's always-on delay, sleeps in shared helpers.
4. **Check the largest claims yourself** against the code before they go in a plan or a report.
5. **Queue what's left in order** in one ledger, and plan the fixes as a few pull requests, each covering one shared cause or area, not one per file.

## Running the fixes

- **One list, one brief each.** Keep the ranked list and its evidence in one file. Give each engineer a brief with one finish line: the files, CI's times for them, the proof to keep and the shared rules. Say that proofs and timings run locally, that the PR's ready run is the CI evidence, with the repo's flake policy from `.agents/repo/ci.md`, and that any other run by hand needs your yes. What they find outside it goes to a new issue, not their pull request.
- **Split the work by kind.** Reading code to estimate waits and sweeping logs go to a reading model that costs less. Engineers measure and build. A review checks code a change reaches in production.
- **The parent marks ready and merges.** An engineer opens a draft and reports its head. A brief that asks otherwise is a mistake to fix.
- **Check for overlap before starting and before pushing:** `gh pr list --search "<file>"`. Two PRs that touch one file in different places merge cleanly; read the hunks before you stop one.
- **Parallel PRs interact past their text.** A rebase onto another's change reruns its selector tests, and one PR's new rule may need the other's code path, as covered-only paths did in local selection.
- **A wide rewrite keeps its script** in the PR body, so a conflicting PR reruns it instead of resolving by hand.
- **A review is against a head.** After a rebase, say what changed since the reviewed one.
- **A finished turn isn't a finished task.** An engineer waiting on a timing run ends turns while it works. One that's idle with review findings open needs a nudge.
- **Watch shared resources.** A full `/tmp` makes every later test fail for a reason that isn't theirs, and a resident process can push the machine out of memory. Clear only what is yours, old and held by no process. Stop a process only by its PID.
- **A standing run** keeps it going: a schedule that collects records, reviews every file past the threshold, fixes and merges in scope, and reports, with a ledger of what's open, owned, queued and decided, so a verdict of real work isn't reviewed again until its time leaves the re-review band `speed-up-tests.md`'s Thresholds name (±40% at like hours in the source repo), against the baseline the ledger stores for it. Spend, scope and production changes go in its report as proposals.
- **After the last merge,** collect the records again and compare, then reconcile before calling it done:
  - **Every original finding gets a disposition:** fixed, owned elsewhere, still open, reclassified with evidence, deferred on purpose, or unclassified. Give each unresolved one an owner or a next action. Check the reviewed count against the sum of the verdicts, and keep an "unclassified" row rather than changing the denominator.
  - **Separate what the work did from what moved anyway.** Compare files the campaign didn't touch over the same window, and the common files on both sides; flag files with few observations and new or split files.
  - **Modelled, observed, not yet observed.** A merged fix's saving is modelled until normal post-merge runs show it. Don't dispatch extra broad CI just to fill the report.
  - **Keep the epic open** until its original finish line and child issues are met. A lower total and merged briefs don't establish that.
  - Add what was dropped, and why, to the repo's tried-and-dropped register ([read what was tried](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/ci-read-what-was-tried.md)).
