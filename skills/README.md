<!--
What: nine agent skills for CI on GitHub Actions, its runners (on any provider; Blacksmith recommended on GitHub Actions), review, the tests CI runs and the evidence behind them, and how to install them and keep them fresh.
Where: installed with the ci-doctor plugin, or copied into the skills folder your agent harness reads; see the README's Installing.
Configure: write your repo's facts files from templates/agent-knowledge/, and fill the placeholders below.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Skills

Each folder is one skill: a `SKILL.md` with a name and a short description, which the harness loads when a task matches, plus `references/` the skill opens by topic and, for some, scripts. Each description names its siblings, so an agent picks the right one.

## Map

Each topic has one home; the others link to it.

| Skill | Owns | Not here: see |
| --- | --- | --- |
| [`ci-workflows`](ci-workflows/SKILL.md) | Changing or debugging workflows: the checks for a CI change, selection, tiers, caches, slow runs, Rust in CI, and `scripts/ci-time.ts`, which prints where a run's time and minutes went. | Runner size and cost: `ci-runners`. Blacksmith: `blacksmith`. |
| [`ci-runners`](ci-runners/SKILL.md) | Runner size and architecture, packing against minute rounding, the spend cap, the cost of getting fast, and choosing a provider. | Workflows: `ci-workflows`. One provider's specifics: `blacksmith`. |
| [`blacksmith`](blacksmith/SKILL.md) | Blacksmith only: its CLI, labels, sticky disks, its cache, billing, the move to it, and `ci-time.ts`'s `--bill blacksmith` adapter. Skip it on other runners. | General sizing and cost: `ci-runners`. |
| [`code-review`](code-review/SKILL.md) | Whether a PR needs review, who reviews, the tests reviewer, and the review record (`scripts/review-record.ts`) CI's gate checks for format and reviewer types. | When review runs in a PR's life: `ci-merge-workflow`. |
| [`ci-merge-workflow`](ci-merge-workflow/SKILL.md) | A PR from draft to merged on one CI run: reading the result, runs by hand, merging, releases, then main and the deploy. | Review: `code-review`. Workflow changes: `ci-workflows`. |
| [`speed-up-tests`](speed-up-tests/SKILL.md) | Slow tests and flakes: CI's records and how to read them (`measuring`, `ci-history-data`), fixes, fakes, and stack pages for [Cloudflare Workers](speed-up-tests/references/workers.md) and [Effect](speed-up-tests/references/effect.md). | Judging a number: `verify-evidence`. A test's value: `test-audit`. |
| [`test-audit`](test-audit/SKILL.md) | A test's value, weak or duplicate coverage and test-only seams. From openclaw, under its MIT licence: see [`test-audit/UPSTREAM.md`](test-audit/UPSTREAM.md). | Evidence quality: `verify-evidence`. |
| [`verify-evidence`](verify-evidence/SKILL.md) | Substantiating a measurement or a completion claim: like-for-like comparisons, interleaving, controls, static estimates. The other skills hand evidence to it. | Where CI's records are: `speed-up-tests`' `measuring`. |
| [`proof-tiers`](proof-tiers/SKILL.md) | Bounded model checks and property tests, and how CI runs them (seeds, timeouts). Optional for stacks with neither. | Which tier runs a file: `ci-workflows`' tiers. |

[`tools/upstream-sync/`](../tools/upstream-sync/README.md) isn't a skill: it's an opt-in weekly check that the skills you copied from upstream changed there, filed as one issue. [`docs/harnesses.md`](../docs/harnesses.md) says how to run agents in parallel and on a schedule in each harness.

The rules each skill relies on are one page each in [`checks/`](../checks/README.md). The skills hold no repo's values: they read them from `.agents/repo/*.md`, written from [the templates](../templates/agent-knowledge/README.md).

## Install

Install the plugin, as [the README's Installing](../README.md#installing) says for each harness. It installs every skill at once. Installing is the user's own act, outside the plan's read-only rule.

The plan the user approves says which skills the repo **adopts**, and the repo's facts files record it. A skill the repo didn't adopt stays installed but defers to the repo's own process.

| Skill | Adopt when |
| --- | --- |
| `ci-workflows`, `ci-runners`, `ci-merge-workflow`, `speed-up-tests`, `test-audit`, `verify-evidence` | The plan adopts the CI, merge or test work they cover. |
| `blacksmith` | The repo runs on Blacksmith, or the user approved a move there. |
| `proof-tiers` | The repo has bounded models or property tests. |
| `code-review` | The user approved its review procedure and gate. Otherwise keep the repo's own review process. |

1. **Write the repo's facts:** `.agents/repo/ci.md`, `speed-up-tests.md`, and the others the adopted skills read, from the [templates](../templates/agent-knowledge/README.md). Add the [`AGENTS.md` snippet](../templates/agent-knowledge/AGENTS-snippet.md) to the instruction file your harness loads.
2. **Configure the scripts the adopted skills use:** `ci-time.ts`'s config block, or its flags (`node <skills-dir>/ci-workflows/scripts/ci-time.ts --help`; add `--bill blacksmith` only on Blacksmith); and, with `code-review`, `review-record.ts`'s CONFIG block, wired into the gate as [the record](code-review/references/record.md) says.
3. **Check the result:** run [`scripts/docs/check-links.ts`](../scripts/docs/check-links.ts) from the repo's root on `.agents/repo`: every link and anchor in the facts must resolve. Run the skills' tests from this repo: `node --test ci-time.test.ts` in `ci-workflows/scripts/`, `node --test blacksmith-bill.test.ts` in `blacksmith/scripts/` on Blacksmith, `node --test review-record.test.ts` in `code-review/scripts/` with `code-review`, and `node --test run-breaks.test.ts` in `proof-tiers/scripts/` with `proof-tiers`.

## Keeping them fresh

[guide section 17](../docs/pages/17-keeping-agent-knowledge-from-going-stale.md) has the method. In short:

- **Code wins.** When a skill and the code disagree, fix the skill in the same change. Scripts do the mechanics, so the words don't have to.
- **Date each lesson,** and keep what was tried and dropped in the repo's one register, which `.agents/repo/ci.md` names (template: [read what was tried](../checks/ci-read-what-was-tried.md)), so no agent tries it again.
- **Generalize, don't append.** A new lesson replaces the rule it refines. Keep every description under 320 characters, upstream copies' too, and each of your own `SKILL.md` under 10 KB; move detail to `references/`. The [docs budget](../scripts/docs/README.md) checks both: point its `layout.skillPath` at the installed skills and run it in CI.
- **Sweep for drift** every two weeks: reviewers list `path:line | duplicate, conflict or stale | evidence | change`, and one change fixes them.
- **Pin what comes from upstream.** `test-audit` records its source commit and stays out of any skills lock. [Upstream sync](../tools/upstream-sync/README.md) diffs upstream weekly and files what changed as one issue; a person applies it, and nothing merges automatically.

## Placeholders

| Placeholder | Meaning |
| --- | --- |
| `<org>/<repo>` | Your GitHub repository. |
| `<skills-dir>` | Where your harness installed the skills: the plugin's copy, or a skills folder such as `.claude/skills`. |
| `<run-id>`, `<job-id>`, `<pr>`, `<n>`, `<k>` | A run, a job, a pull request, a count, a reviewer count. |
| `<full-head-sha>`, `<head-sha>`, `<main-sha>`, `<short sha>` | A PR's head, in full or short, and main's. |
| `<branch>`, `<parent-branch>`, `<body-file>` | A PR's branch, the branch it stacks on, and a file holding its body. |
| `<workflow-file>`, `<workflow-name>`, `<gate-job>` | The PR workflow's file, its `name:`, and its required job. |
| `<monthly-cap>`, `<price-per-minute>` | Your CI budget, and a runner label's list price per started minute, both at list price. |
| `<actions-repo>` | A repo holding shared composite actions. |
| `<app-dir>`, `<server-package>`, `<area>` | An app folder, the package with the heaviest tests, and an area of the code. |
| `<sweep-time>` | When main's scheduled sweep runs. |
| `<file name>` | A test file, as its issue names it. |
| `<file>`, `<name>`, `<path>`, `<module>` | A test file, a test's name, a path, a source module. |
| `<what changes>` | A PR title's summary, after its area. |
| `<review-checker>` | Where the repo keeps `review-record.ts`, from its root, as `.agents/repo/review.md` names it. |
| `<base>`, `<target>` | A PR's base branch, which a stacked PR's parent can be. |
| `<model>`, `<effort>`, `<end>`, `<type>`, `<scope>`, `<why>`, `<reviewer>` | A review session's model, effort, end state, and a reviewer's type, scope or reason not run. |
| `<snapshot-host>`, `<manifests>`, `<lockfile>` | Where branch snapshots are published, the dependency manifests and the lockfile. |
| `<sync>`, `<covered files>` | A model's last-checked commit and the files it covers. |

The scripts' own help and comments name their arguments in angle brackets, such as `<run-id>`, `<owner/name>`, `<prefix>`, `<skill>` and `<word>`, and ci-time.ts quotes Vitest's `<project>` and `<ms>`; they need no value. [`tools/upstream-sync/`](../tools/upstream-sync/README.md) lists its own.
