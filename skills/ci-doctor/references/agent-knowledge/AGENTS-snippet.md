<!--
What: the parts of a repo's AGENTS.md (or CLAUDE.md) that the shared skills rely on: a short map, the rule that code beats docs, and the commands block.
Where: paste into the instruction file your harness loads (AGENTS.md, CLAUDE.md or another), and keep that file under its size budget (12 KB here).
Configure: every <placeholder>; the commented example is the source repo's commands block, genericized.
Reference implementation from a production monorepo; adapt to your repo.
-->

## Repo map

<!-- One row per top-level folder an agent might change. Point to a folder's own AGENTS.md rather than copying it. -->

| Path | What it holds |
| --- | --- |
| `<app-dir>` | `<what it is, in a line>` |
| `packages/<name>` | `<what it is>` |
| `scripts/` | CI's plan, the checks and generated files |
| `.agents/skills/` | Shared skills; this repo's facts for them are in `.agents/repo/*.md` |

## Commands

Run the narrowest check that covers your change, from the root:

```sh
<test-cmd> <file>                 # one test file, while you work on it
<test-cmd> <file> -t '<name>'     # its tests whose names match
<lint-cmd> <file>...              # format and lint for those files
<types-cmd>                       # types for the workspace
<check-cmd>                       # types, format and lint for the workspace
<build-cmd>                       # every package's build
<cached-tests-cmd> [<path>...]    # the tests near your change, from the task cache
```

- Give the test command files, not a directory, package or glob.
- Run the permitted focused checks before pushing. Follow this repo's machine policy below for builds and full checks; the checks it reserves for CI are verified in the ready PR's run.
- Never run the whole suite or CI by hand, outside the approved dispatch exceptions in `.agents/repo/ci.md`'s Manual runs and failures. Where this repo skips CI on drafts, CI runs once, when the PR is marked ready.
- Before you run a check or dispatch CI, read the `ci-doctor` skill's check `references/checks/run-only-checks-that-decide.md`.

## Machine policy

<!-- Say which machines may run what. A shared machine's limits win over every other line here. -->

- On `<shared machine>`: only named test files, format, lint and types. `<build-cmd>`, `<cached-tests-cmd>` over the whole repo, container tests and Docker are reserved for CI.
- On `<own machine>`: `<check-cmd>`, `<build-cmd>` and `<cached-tests-cmd>` before pushing.
- Reserved for CI: `<the checks>`. Name them in the PR, and read them in its ready run.

<!-- An optional example, for a pnpm workspace tested with Vitest; replace it with your own:
pnpm exec vitest run <file>               # one test file
pnpm exec vitest run <file> -t '<name>'   # its tests whose names match
pnpm exec prettier --write <file>...      # format, then lint those files with your linter
pnpm exec tsc --build                     # types
pnpm run check                            # types, format and lint
pnpm run build                            # every package's build
-->

## Working here

- When docs and code disagree, the code is right. Fix the doc in the same change.
- CI: read `ci-doctor` before changing it, before changing a runner or costing a change, and for Blacksmith's CLI and disks<!-- drop if you don't run on Blacksmith -->. `review-gate` is the review gate a draft passes before its one CI run<!-- drop if the repo keeps its own review process -->, and `ci-merge-workflow` takes it to merged; before merging, read the `ci-doctor` skill's check `references/checks/check-what-ci-ran.md`. This repo's facts are in `.agents/repo/ci.md` and `.agents/repo/review.md`.
- Packages: `optimize-graphs` before adding a package, an edge between packages, an entry point or a barrel file, or moving a package's folders, and when an edit reruns or rebuilds far more than it touches.
- Tests: `speed-up-tests` for a slow test, in CI or locally, `fix-flaky-test` for a flake, `test-audit` for a test's value, `proof-tiers` for models and property tests.
- Evidence: `prove-it` before you call work done or quote a number.
