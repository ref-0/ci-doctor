<!--
What: templates for the per-repo files the shared skills read, and for running a slow-test campaign.
Where: copy each into your repo, at the path below, and fill its placeholders.
Configure: the placeholders listed below.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Agent knowledge templates

Part of the [`agent-knowledge`](../SKILL.md) skill, which says where each file's knowledge belongs and how to keep it fresh. The [skills](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/README.md) are shared between repos. What's true of one repo, its workflow file, its gate job, its scripts and settings, goes in that repo's own files, which the skills point at. [guide section 17](https://github.com/ref-0/ci-doctor/blob/v0.4.0/docs/pages/17-keeping-agent-knowledge-from-going-stale.md) explains the split.

| Template | Copy to | Read by |
| --- | --- | --- |
| [`AGENTS-snippet.md`](AGENTS-snippet.md) | The instruction file your harness loads at the start, such as `AGENTS.md` for Codex or `CLAUDE.md` for Claude Code; [harnesses](https://github.com/ref-0/ci-doctor/blob/v0.4.0/docs/harnesses.md) covers each | Every agent the harness starts |
| [`repo-facts/ci.md`](repo-facts/ci.md) | `.agents/repo/ci.md` | The `ci-doctor` hub's topics, `ci-merge-workflow` and `fix-flaky-test` |
| [`repo-facts/ci-time.json`](repo-facts/ci-time.json) | `.agents/repo/ci-time.json`: the workflow, shard prefixes, gate job, runner labels' vCPUs and prices. A key you leave out keeps the script's default | `ci-time.ts`, in the `ci-workflows` skill |
| [`repo-facts/speed-up-tests.md`](repo-facts/speed-up-tests.md) | `.agents/repo/speed-up-tests.md` | The `speed-up-tests` skill |
| [`repo-facts/review.md`](repo-facts/review.md) | `.agents/repo/review.md`, where the repo adopts `review-gate`; its list goes in `.agents/repo/review-paths.txt`, as below | `review-gate` |
| [`repo-facts/review-record.json`](repo-facts/review-record.json) | `.agents/repo/review-record.json`, with `review-gate`: the review types, test code, thresholds, effort and the list's path. A key you leave out keeps the script's default | `review-record.ts`, locally and in CI's gate, from the base branch |
| [`repo-facts/proof-tiers.md`](repo-facts/proof-tiers.md) | `.agents/repo/proof-tiers.md`, where the repo has models or property tests | `proof-tiers` |
| [`progress.md`](progress.md) | Next to the plan before approval; then where the authorization record says, such as `.agents/ci-doctor/progress.md` | Every session working the plan, first thing ([`ci-doctor`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/SKILL.md#pick-up-where-the-last-session-stopped)) |
| [`ledger.md`](ledger.md) | Wherever a campaign keeps its state | A slow-test campaign's coordinator |
| [`report.md`](report.md) | Next to the ledger, one per run, as `report-<date>.md` | The coordinator, and whoever reads its proposals |
| [`brief.md`](brief.md) | One per engineer, next to the shared rules | An engineer in a campaign |
| [`briefs-README.md`](briefs-README.md) | Next to the briefs, keeping its name, `briefs-README.md`, which each brief links | Every engineer in a campaign |

Each template keeps the source repo's values as commented examples. Delete them once yours are in. When a fact in these files and the code disagree, the code is right: fix the file in the same change.

The templates hold no relative links into the playbook, since they move when copied: a path into it is written `<skills-dir>/…`, as text to fill in, and a skill is named, not linked, since the harness loads it.

## The review list

With `review-gate`, as its own step:

1. Create `.agents/repo/review-paths.txt` from the example in [`repo-facts/review.md`](repo-facts/review.md): one glob a line for the systems review.md names.
2. Check that `reviewPaths` in `.agents/repo/review-record.json` is that path, or left out for the default.
3. Run `BASE=<base> node <review-checker> --count` on a branch that changes a listed file: its last line names the files the list covers. CI reads the base branch's copy, so the list gates PRs once it's merged.

## Check the copies

Once copied, run the playbook's link checker, `scripts/docs/check-links.ts`, from the repo's root on `.agents/repo <briefs-folder>`: every link and anchor in them must resolve.

## Placeholders

| Placeholder | Meaning |
| --- | --- |
| `<org>/<repo>`, `<repo>` | Your GitHub repository, and its short name. |
| `<workflow-file>`, `<gate-job>` | The workflow that checks pull requests, and the one job branch protection requires. |
| `<selector-script>`, `<shard-script>`, `<budgets-file>`, `<records-script>`, `<flake-script>` | The scripts that select checks, pack shards, hold budgets, read records and file flaky tests' issues. |
| `<sweep-workflow>`, `<sweep-time>`, `<bisect-workflow>`, `<release-workflow>` | The scheduled sweep, when it runs, and what a failed sweep and a release run. |
| `<monthly-cap>` | The month's CI budget, at list price. |
| `<retry-setting>`, `<shared-actions>` | Where the test retry policy and the shared cache actions live. |
| `<test-cmd>`, `<lint-cmd>`, `<types-cmd>`, `<check-cmd>`, `<build-cmd>`, `<cached-tests-cmd>` | Your repo's commands, with their arguments adapted to your tools. |
| `<install-command>` | Your complete frozen, reproducible install command, such as `pnpm install --frozen-lockfile`, `npm ci` or `cargo fetch --locked`. |
| `<shared machine>`, `<own machine>` | The machines agents run on, for the machine policy. |
| `<system>`, `<model>`, `<CLI>`, `<effort>`, `<gate-job>` | review.md's systems, the review model, the CLI that runs it, its effort and the gate. |
| `<model file>`, `<folder>`, `<library>`, `<setup file>`, `<seed variable>`, `<count variable>`, `<size variable>`, `<fixed seed>`, `<testing module>`, `<inventory file>`, `<command>`, `<bound CI runs>`, `<commit>`, `<paths>` | proof-tiers.md's models and property setup. |
| `<the policy>`, `<check>`, `<app>`, `<who>`, `<snapshot-host>`, `<manifests>`, `<lockfile>` | ci.md's verification policy, base-tied checks, deploys, release owners and the snapshot check. |
| `<objective>`, `<value>`, `<factor>`, `<share>`, `<denominator…>`, `<from–to>` | A report's objective, threshold, drift and evidence fields. |
| `<records-command>`, `<scripts-dir>`, `<config-module>`, `<production-config>`, `<test-harness-config>`, `<symbol-search>` | Where the speed-up-tests facts live. |
| `<app-dir>` | An app or package folder. |
| `<skills-dir>`, `<review-checker>`, `<base>`, `<briefs-folder>` | Where the harness installed the skills, the review checker's path, a PR's target branch and where a campaign's briefs live. |
| `<report-file>`, `<target-branches>`, `<watcher>`, `<register>` | A run's report, the branches with ready-run CI, the spend watcher's facts and the tried-and-dropped register, in ci.md and the ledger. |
| `<container-tests-off>` | In ci.md's dispatch examples: your input that skips container tests, if your workflow has one (`-f <input>=false`); drop it otherwise. The template `ci.yml` declares none, and GitHub rejects a dispatch that passes an undeclared input. |
| `<epic>`, `<main-sha>`, `<pr>`, `<engineer>`, `<threshold>`, `<date>`, `<n>`, `<s>`, `<file>`, `<name>` | A campaign's issue, base, PRs, owners and numbers. |
