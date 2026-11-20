<!--
What: the checks after a merge: main's sweep, the merge's own run, and the deploy.
Where: read by an agent right after it merges a PR.
Configure: what deploys from main, the sweep's time (<sweep-time>) and the failure issue, in your repo's `.agents/repo/ci.md`.
Reference implementation from a production monorepo; adapt to your repo.
-->

# After a merge

Part of the [`ci-merge-workflow`](../SKILL.md) skill. The repo's facts are in `.agents/repo/ci.md`'s Merge, releases and deploy. [guide section 5](https://ci-doctor.ref0.dev/guide/docs/pages/05-tiers-what-runs-where.md) explains the sweep.

**The sweep, and your merge's own run.** Read what the repo's merges and scheduled runs check, such as a daily sweep at `<sweep-time>`, and what a failure on `main` files, such as a "CI on main failed" issue and a bisect. If a failure names your merge, read the failed jobs. When it's your change, fix `main` in a new PR at once; when it's another's, tell its owner. ci.md's Merge, releases and deploy gives the commands to check `main` sooner and to close the failure's issue once a fix merges.

**The deploy.** Find which deploys your merge reaches, from ci.md's list of what deploys from `main` and how. Find the deployment whose commit, artifact or build identity is your merge commit, or a later one that contains it; a deploy that's merely newer may be another's. Tell a person if none appears within the wait ci.md gives. A deploy held on purpose says so in its build's log: say which commit waits. Where a new dependency needs a deploy's trigger paths changed outside the repo, say so.

**Releases.** Where releases publish only what `main`'s sweep passed, a merged change waits for the next one. What only a release's owners may do, how to try an unpublished change and the released-versions check are in [releases](releases.md).

**Production, after a release.** Check that production's newest deployment is newer than the release and names the commit it should.
