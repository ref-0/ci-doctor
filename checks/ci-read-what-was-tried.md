<!--
What: a template for the list of CI changes already tried and dropped, and the check to read it before proposing one.
Where: the register lives in one place your repo chooses, named in `.agents/repo/ci.md`'s Tried and dropped; read by an agent before it designs a CI change or a test campaign.
Configure: replace the example rows with your own; keep one row per idea, dated, with its outcome and retry condition.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Read what was tried before changing CI

**Moment:** before design · **Concern:** tests and CI

## Check

- [ ] The idea isn't in the repo's register, the one `.agents/repo/ci.md`'s Tried and dropped names, or the proposal says what has changed since it was dropped: the limiting condition in its row no longer holds, with new measurements to show it.
- [ ] A proposal that repeats one is modelled from real runs before anyone builds it, as [measure CI before changing it](ci-measure-before-changing-it.md) says.
- [ ] An idea tried and dropped gets a row in that register in the same PR that drops it, with its date, the measured result, its outcome, the reason, what would have to change before trying it again, and its evidence: the PR or run, or, for a rejection with no run, the reason it was judged without one.

## How

Open the register ci.md names and search it for the runner, setting or tool the idea touches. The worked example below is a sample of another repo's, not yours. When a row matches, read what limited it and its retry condition, and say in the proposal what is different now: a new runner type, a newer tool, a changed test mix. Measure again; don't argue from the old numbers alone. A rejected design may become right later, which is why each row is dated.

Add a row when a change is tried and reverted, rejected on principle, shipped then replaced, or folded into another change. Keep the measured result and the date, and leave out who tried it. Keep closed demos and folded patches out of any count of failed optimizations unless the evidence shows they failed.

## Tried, and not used

The template for your register: one row per distinct idea.

| Date | Change | Outcome | What limited it | Try again when | Evidence |
| --- | --- | --- | --- | --- | --- |
| `<date>` | `<change>` | `<measured and rejected · rejected on principle · shipped then replaced · folded into another change>` | `<what was measured, and what it showed>` | `<the condition that would change the answer>` | `<PR or run, or why there's none>` |

### Worked example

A sample of rows from the source repo, one for each kind of outcome, by week of its CI work. Results are relative to that repo's baseline at the time, and its evidence was its own PRs and runs. Its full register is [guide section 18](../docs/pages/18-tried-and-dropped.md); keep yours in one place, and point ci.md at it.

| When | Change | Outcome | What limited it | Try again when | Evidence |
| --- | --- | --- | --- | --- | --- |
| Week 1 | Arm runners for the JavaScript tests | Measured and rejected | A much cheaper minute, but the shards ran about a third slower and some integration files failed | The workload's Arm speed or the failures change; native Arm coverage stayed useful elsewhere | Measured runs |
| Week 1, and week 4 | A sticky disk for `node_modules` alone | Measured and rejected, then replaced | Installs and postinstalls still ran, since their markers live in the package store, so it saved about a second a job | Replaced by a disk of the whole install, toolchain, store markers and every project's links included, keyed by the manifests' hash, which skips the install ([Blacksmith's disks](../skills/blacksmith/references/disks.md#the-dependencies-disk)) | Measured runs |
| Week 2 | Shards split by recorded time instead of by count | Modelled and rejected | Could not help while one file took longer alone than a shard's share | Every file is well under a shard's share (it later shipped, once they were) | A model of recorded file times |
| Week 2 | Two shards of nine workers instead of three of six | Measured and rejected | CPU saturated, the shards took well over half again as long, and timing tests failed under the load | Never as a substitute for independent capacity; spare CPU isn't spare capacity | Measured runs |
| Week 3 | Building release binaries for one platform less often | Rejected | Every such job was a real release, and each binary names its version, which the service and its workers must share | Fewer releases, or a version contract the components don't share | The release jobs' records |
| Week 4 | A staging-connected recording and proof extension | Shipped then reverted | The revert removed it and its connections; the evidence doesn't say why | Deterministic recording and replay stayed; don't infer a reason | The revert |
| Week 4 | Merging a declaration and cached-check spike wholesale | Folded into another change | Closed unmerged; project-level caching was built locally first | Not a rejection of the technique | The closed PR |
| Week 4 | Four server test files to a cached task | Measured and rejected | Fewer launches, but longer shards, a much longer idle tail and more billed minutes: indivisible groups and stale estimates | Slow files named from several runs' times, for at most about one shard's saving | Measured runs |
| — | A test mode in production code | Rejected on principle | One code path, where a period differs by setting | — | Judged without a run: one code path |

## Why

In the source repo, the move to Blacksmith tried several of these rows in one day, and the list was kept so that no later agent tried them again. Days later, splitting the shards by time was proposed again, and was modelled from a run's file times before anyone built it. Once the files that blocked it were split, it shipped: a dated row with its limiting condition let a later reader see the condition had changed.

## Pointed at from

- [`ci-workflows`](../skills/ci-workflows/SKILL.md), before changing the workflow.
- [`ci-workflows`](../skills/ci-workflows/references/change-checks.md), before you design a change.
- [`speed-up-tests`](../skills/speed-up-tests/references/campaign.md), before planning a campaign, and when one ends.
- The repo's `.agents/repo/ci.md`, its Tried and dropped section, which names the register.
- [guide section 18](../docs/pages/18-tried-and-dropped.md), which draws the lessons.
