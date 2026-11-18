<!--
What: a check that each local test, CI run and watcher answers a question that changes the next action.
Where: read by an agent before it runs tests, dispatches CI or starts watching a run.
Configure: your repo's test commands and machine policy (AGENTS.md), its approved dispatch exceptions (`.agents/repo/ci.md`) and its shared test-slot limit.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Run only the checks that decide something

**Moment:** running the work · **Concern:** tests and CI

## Check

- [ ] Each check answers a question that affects the next action, and no existing result already answers it.
- [ ] Local tests name exact files, narrowed with `-t` where useful, and respect shared test slots without raising `--maxWorkers`.
- [ ] Import-related tests run once before pushing, on one or two changed source files; shared helpers use named test files instead.
- [ ] Local work runs what the repo's machine policy allows on this machine, and leaves to CI what it reserves for CI.
- [ ] Work in progress stays on a draft; a run by hand is one of the approved dispatch exceptions in `.agents/repo/ci.md`, with only the files and repeats needed.
- [ ] Watching is at least a minute apart, and no unneeded test run is still going when the work ends.

## How

- Use the repo's file-level test command, such as `<test-cmd> <file> -t '<name>'`, and its format-and-lint command on the changed files. Never pass a test directory, package or glob. Before pushing, run the tests related to a changed source file once where that's useful, such as Vitest's `related <source-file> --run`.
- Let a test file wait for its slot. Where each harness starts a heavy runtime, more local workers don't make that cost go away. Allow one test run per agent on a shared machine.
- Keep the PR a draft through build and review, then mark it ready for its one run, as [`ci-merge-workflow`](../skills/ci-merge-workflow/SKILL.md) says. If the change needs checks only CI can run, such as Docker or the server build, mark it ready earlier.
- For a failure investigation, use an approved dispatch exception with the inputs the workflow declares, as [manual runs](../skills/ci-merge-workflow/references/manual-runs.md) says. Each job bills at least its provider's minimum.
- Watch with your harness's PR watcher where it has one. In a terminal, `gh run watch <run-id> --repo <org>/<repo> --interval 60`: every agent on one login shares 5,000 API calls an hour.

## Why

In the source repo, one three-day plan spent dozens of PRs and many hours on CI, flakes and shared-machine overhead. A UI dependency change once selected every server test file, while every job paid its own setup. Every extra full run, container tests included, cost money. The same day, agents polling runs on their own exhausted the shared GitHub API limit.

## Pointed at from

- The repo's `AGENTS.md`, through the snippet's line under its commands block.
- [`ci-merge-workflow`](../skills/ci-merge-workflow/SKILL.md), local checks and manual runs.
- [`ci-workflows`](../skills/ci-workflows/references/change-checks.md).
