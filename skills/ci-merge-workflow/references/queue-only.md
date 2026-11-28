<!--
What: reading the result when a repo's pull requests run no CI and its merge queue builds them.
Where: read by an agent readying or merging a PR in a repo whose only CI run is the merge group's.
Configure: the queue's workflow and gate job in your repo's `.agents/repo/ci.md`'s Entry points and gate.
Observed in an open-source repo that gates pull requests in its merge queue; adapt to your repo.
-->

# A repo that checks only in its merge queue

Part of the [`ci-merge-workflow`](../SKILL.md) skill. Read it when ci.md says pull requests run nothing, or when a ready PR shows no checks at all.

There's no PR run to read, so step 3's result is the merge group's, and it comes after you ask to merge, not before.

1. **Run what the queue will run, locally, first.** Use the repo's own command for the changed paths, as ci.md names it. It's the only result you get before the queue.
2. **No checks on the PR isn't a pass.** Don't post Verification from it, and don't read an empty `gh pr checks` as green.
3. **Enter the queue by the repo's rule,** which may be a maintainer's to apply, not yours. Don't enqueue a PR the plan didn't authorize you to merge.
4. **Find the group's run.** The queue builds a branch named `gh-readonly-queue/<base>/pr-<n>-<sha>`, on the `merge_group` event: `gh run list --repo <org>/<repo> --event merge_group --branch <that-branch>`. Its SHA is the queue's, not your head's, and its gate is the one that counts.
5. **Read it as any run,** by the hub's [triage](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/triage/TOPIC.md). A group holds other PRs too, so a failure outside your files may be a neighbour's.
6. **A dropped PR isn't merged.** The queue removes a PR whose group failed and leaves it open. Read why before re-entering: fix your own fault and push; for a neighbour's fault or a flake, re-enter as the repo's rule says, and file the flake.
7. **Post Verification after the merge,** naming the group's run and SHA, then go on to step 6.
