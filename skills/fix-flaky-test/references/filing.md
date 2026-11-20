<!--
What: what to do with a flake CI filed, and how to log one it didn't.
Where: read by an agent with a confirmed flake it isn't fixing now, or after a run that passed with one.
Configure: your repo's `.agents/repo/ci.md` says whether CI files flakes itself, its labels and its flake script.
Reference implementation from a production monorepo; adapt to your repo.
-->

# File what's left

Part of the [`fix-flaky-test`](../SKILL.md) skill. A flake nobody files is seen once by each of several threads and never fixed.

## When CI files a flake itself

Where the repo's CI retries a failed test and files an issue for each flake, a flake doesn't turn a run red, and the run that hits one files it or comments on its issue, within the per-run cap and the job roll-up its flake script names. So when your pull request's run passed with a flake, or a rerun passed a job that failed, read the issue the run filed; if the cap or a roll-up left it unfiled, log it as below. When the comment says the pull request changes the test's file, the flake is likely the pull request's own: fix it there before it merges.

The issue closes only after real clean runs, as the repo's policy says: in the source repo, 7 quiet days and 50 qualifying clean executions of the file, and cache replays count as zero ([guide section 11](https://ci-doctor.ref0.dev/guide/docs/pages/11-flakes.md)).

## A flake CI doesn't file

Log a confirmed flake yourself the first time you see it, not the second: two threads that each see it once never file it otherwise. That covers a test that fails and then passes on a run with no retry, such as a Rust test, or one you saw on another machine. Search the `flake` issues, closed ones too, for the test's file:

```sh
gh issue list --repo <org>/<repo> --label flake --state all --search "<the test file's name>"
```

If one covers it, comment with the run's link, the commit, the job and the failing line, one comment a sighting, so its comments count how often it fails. Reopen it if it's closed, since its fix didn't hold. Otherwise open one that names the run it came from.

A race you find in the repo's own code, such as two writes landing out of order, goes the same way, labelled `bug` without `flake`, even before a test fails on it.
