<!--
What: when and how to run CI by hand.
Where: read by an agent before it dispatches a workflow run itself.
Configure: the workflow's dispatch inputs and their limits, in your repo's `.agents/repo/ci.md`'s Manual runs and failures.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Run CI by hand

Part of the [`ci-merge-workflow`](../SKILL.md) skill. Read it when chasing a failure or running a file a PR's run leaves out. The repo's dispatch modes, the inputs each workflow declares, who approves a run, repeat limits and retry behaviour are in `.agents/repo/ci.md`'s Manual runs and failures; a run that isn't one of its approved exceptions doesn't start.

A run by hand checks a pushed branch or commit with `main`'s workflow, unless you pass `--ref <branch>`: `--ref` picks the workflow's revision, and a `ref` input, where the workflow has one, picks the code it checks out. Pass both to test a branch's workflow change on that branch. A hosted runner bills each job at least a minute, and per-vCPU providers such as Blacksmith a minute of every vCPU it has ([`ci-runners`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-runners/references/billing.md)). Before you start one:

- **Run it locally first.** Repeats, mutations, timings and race proofs run on your machine. A PR's CI times come from its own run once it's ready. A run by hand answers only what a local run can't.
- **Working from a brief, ask first.** Start no run by hand without the yes of whoever briefed you, and say what its result decides. Once, two agents started a couple of dozen runs on drafts within minutes, for timings and mutations, and none passed.
- **Know what its result decides.** Chase a failure CI shows and a local run doesn't, answer a flake question a local run can't, try a file a PR's run leaves to a later tier before a risky merge, or check a snapshot on a draft you're about to install. A run with no decision behind it is waste.
- **Run the narrowest one.** Name the paths or the one file, with the inputs ci.md says the workflow declares (in the source repo: `test_paths`, at most 4 at a time, or `sandbox_file`). A run by hand of everything costs more than a ready PR's own run, which checks only what the diff reaches.
- **Fix before you run again.** Don't start a run on code you know fails, or a second run on a commit while one is still going.
- **A run the same as one still going may cancel it,** where runs by hand share a concurrency group keyed by their inputs.
- **Keep repetitions at 3 or under,** unless you're measuring a flake's rate with a yes, as [`fix-flaky-test`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/fix-flaky-test/references/policy.md#an-extra-ci-repeat) says (for example 50 repeats for an ordinary file, 20 for a container file). Other people use these runners too.
- **Never run a macOS job without a person's yes.** A Mac minute costs several Linux ones on every provider we know (check current pricing).

Take the dispatch command whole from ci.md: `--ref` always, and only `-f` inputs the workflow declares. GitHub rejects an undeclared input. In the source repo it was:

```sh
gh workflow run <workflow-file> --repo <org>/<repo> --ref <branch> -f ref=<branch> -f test_paths=<path> -f repeat=<n>
gh run watch <run-id> --repo <org>/<repo> --interval 60 --exit-status > /dev/null && echo passed || echo failed
gh run view <run-id> --repo <org>/<repo> --json conclusion,jobs \
  --jq '.conclusion, (.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | .name)'
```

Wait with `--interval 60`: every run on one login shares 5,000 API calls an hour, and `gh run watch` polls every 3 s by default.
