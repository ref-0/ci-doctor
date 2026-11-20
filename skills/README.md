<!--
What: the plugin's eight agent skills: the ci-doctor hub, for CI on any provider and the plan, and the skills for a workspace's graphs, slow and flaky tests, review, merging, test value and proof tiers, and how to keep them fresh.
Where: installed with the ci-doctor plugin, or copied into the skills folder your agent harness reads; see the README's Installing.
Configure: write your repo's facts files from the hub's references/agent-knowledge/, and fill the placeholders below.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Skills

Each folder is one skill: a `SKILL.md` with a name and a short description, which the harness loads when a task matches, plus `references/` the skill opens by topic and, for some, scripts. A harness picks a skill by its description, so topics an agent would call CI work share the hub's, and tasks that don't sound like CI have their own.

## Map

Each topic has one home; the others link to it.

| Skill | Owns | Applies when |
| --- | --- | --- |
| [`ci-doctor`](ci-doctor/SKILL.md) | The rules, `progress.md` and the plan's [phases](ci-doctor/references/phases/), and the CI topics below, CI-result [triage](ci-doctor/references/triage/TOPIC.md), the one-rule [checks](ci-doctor/references/checks/README.md) and the [agent-knowledge templates](ci-doctor/references/agent-knowledge/README.md). | Always |
| [`review-gate`](review-gate/SKILL.md) | The review gate in CI, for a repo that adopts it: what the gate requires before a draft's one CI run, the tests reviewer, and the review record (`scripts/review-record.ts`) CI's result job checks for format and reviewer types. Who reviews and how is the repo's own; [guide section 15](../docs/pages/15-the-agent-workflow-around-ci.md#how-we-run-a-review) has ours. | The repo adopted the gate (`.agents/repo/review.md`); otherwise the repo's own review process |
| [`ci-merge-workflow`](ci-merge-workflow/SKILL.md) | A PR from draft to merged on one CI run: marking ready, runs by hand, merging, releases, then main and the deploy. | Adopted (`.agents/repo/ci.md`); otherwise the repo's own merge path |
| [`test-audit`](test-audit/SKILL.md) | A test's value, weak or duplicate coverage and test-only seams. From openclaw, under its MIT licence: see [`test-audit/UPSTREAM.md`](test-audit/UPSTREAM.md). | Any repo |
| [`proof-tiers`](proof-tiers/SKILL.md) | Bounded model checks and property tests, and how CI runs them (seeds, timeouts). | Any repo with them |
| [`optimize-graphs`](optimize-graphs/SKILL.md) | The five graphs that set how far an edit reaches and how long CI waits: package dependencies, export paths, layers inside packages, workspace tasks and CI jobs. How to measure them, what to propose and in what order, and how to adopt the checks. The hub's Phase 1 maps them with it. | Any repo with several packages or jobs |
| [`speed-up-tests`](speed-up-tests/SKILL.md) | Slow tests, in CI or locally: CI's records and how to read them (`measuring`, `ci-history-data`), naming the wait, fixes, fakes, campaigns over many files, and stack pages for [Cloudflare Workers](speed-up-tests/references/workers.md) and [Effect](speed-up-tests/references/effect.md). | Any repo with tests |
| [`fix-flaky-test`](fix-flaky-test/SKILL.md) | A test that fails sometimes or passes only on a retry: telling it from a real or infrastructure failure, matching the symptom, forcing the interleaving, the fix, proving it with retries off, and filing what's left. | Any repo with tests; the repo's flake policy from `.agents/repo/ci.md` |

The hub's topics, each a `references/<topic>/TOPIC.md`. They aren't named `SKILL.md`, since Codex registers a `SKILL.md` at any depth as a skill of its own:

| Topic | Owns | Not here: see |
| --- | --- | --- |
| [`triage`](ci-doctor/references/triage/TOPIC.md) | A PR's CI result: which job failed and why, whether the run counts, and the exceptions. | Readying and merging: `ci-merge-workflow`. A flake's cause and fix: `fix-flaky-test`. |
| [`ci-workflows`](ci-doctor/references/ci-workflows/TOPIC.md) | Changing or debugging workflows: the checks for a CI change, selection, tiers, caches, slow runs, Rust in CI, and `scripts/ci-time.ts`, which prints where a run's time and minutes went. | Runner size and cost: `ci-runners`. Blacksmith: `blacksmith`. |
| [`ci-runners`](ci-doctor/references/ci-runners/TOPIC.md) | Runner size and architecture, packing against minute rounding, the spend cap, the cost of getting fast, and choosing a provider. | Workflows: `ci-workflows`. One provider's specifics: `blacksmith`. |
| [`blacksmith`](ci-doctor/references/blacksmith/TOPIC.md) | Blacksmith only: its CLI, labels, sticky disks, its cache, billing, the move to it, and `ci-time.ts`'s `--bill blacksmith` adapter. Skip it on other runners. | General sizing and cost: `ci-runners`. |
| [`verify-evidence`](ci-doctor/references/verify-evidence/TOPIC.md) | Substantiating a measurement or a claim about CI: like-for-like comparisons, interleaving, controls, static estimates. The other topics hand evidence to it. | Where CI's records are: the `speed-up-tests` skill's `measuring`. |

## When a topic becomes its own skill

A harness picks a skill by its description alone, so a topic inside the hub reaches only tasks that sound like CI. A topic becomes a skill of its own when:

- **its task doesn't sound like CI:** an agent asked "should this be a barrel file?" never opens a CI skill;
- **it has a clear deliverable,** such as a measured map and an ordered list of changes;
- **it's worth installing alone,** in a repo that never runs the plan.

What moves, and what stays:

- **Everything moves.** The topic's `TOPIC.md` becomes the skill's `SKILL.md`, its detail goes to the skill's `references/`, and the topic's folder goes. Each fact keeps one home.
- **The hub keeps links only:** its topic map's row, the phases that used the topic, and its "Not here", each pointing to the skill by name and path. Nothing is copied back.
- **The description is in the asker's words,** not CI's, under 320 characters, and names the skill's neighbours where two could claim one task.
- **It stands alone.** What an agent needs to start, such as the setup step, the facts it reads and the checks it follows, is inside the skill, as a short copy or a reference page of its own. Everything else is a full link, to the guide at `https://ci-doctor.ref0.dev/guide/<path>` or to the repo on GitHub at `next`, never a relative path out of the folder. The skill names its release in `metadata.version`, says how to run its tools from a skills-only install, and has its own "Outside this skill" section.
- **It's in the map** above, the README's Installing, the [`AGENTS.md` snippet](ci-doctor/references/agent-knowledge/AGENTS-snippet.md) and guide section 17's list, and the changelog says what a copy of the hub must change.

The build checks (`scripts/check.ts`) copy each skill's folder alone, as `npx skills add` with one skill chosen installs it, and fail on a link inside it that doesn't resolve in the copy, a relative link out of it, which dangles there, and a full link to the guide site or to GitHub at `next` that names no file in the repo. Only the hub may link out relatively, to what the guide site serves, since its ["Outside the skills"](ci-doctor/SKILL.md#outside-the-skills) covers it. A new skill gets that check by being a folder here.

[`tools/upstream-sync/`](../tools/upstream-sync/README.md) isn't a skill: it's an opt-in weekly check that the skills you copied from upstream changed there, filed as one issue. [`docs/harnesses.md`](../docs/harnesses.md) says how to run agents in parallel and on a schedule in each harness.

The skills hold no repo's values: they read them from `.agents/repo/*.md`, written from [the templates](ci-doctor/references/agent-knowledge/README.md).

## Install

Install the plugin, as [the README's Installing](../README.md#installing) says for each harness. It installs every skill at once. Installing is the user's own act, outside the plan's read-only rule.

The plan the user approves says which skills the repo **adopts**, and the repo's facts files record it. A skill the repo didn't adopt stays installed but defers to the repo's own process.

The map's **Applies when** says when each one applies. In the hub, the `blacksmith` topic applies only when the repo runs on Blacksmith, or the user approved a move there.

1. **Write the repo's facts:** `.agents/repo/ci.md`, `speed-up-tests.md`, and the others the adopted skills read, from the [templates](ci-doctor/references/agent-knowledge/README.md). Add the [`AGENTS.md` snippet](ci-doctor/references/agent-knowledge/AGENTS-snippet.md) to the instruction file your harness loads.
2. **Configure the scripts the adopted skills use:** `.agents/repo/ci-time.json`, from [its template](ci-doctor/references/agent-knowledge/repo-facts/ci-time.json), or `ci-time.ts`'s flags (`node <skills-dir>/ci-doctor/references/ci-workflows/scripts/ci-time.ts --help`; add `--bill blacksmith` only on Blacksmith); and, with `review-gate`, `.agents/repo/review-record.json`, from [its template](ci-doctor/references/agent-knowledge/repo-facts/review-record.json), with `review-record.ts` wired into the gate as [the record](review-gate/references/record.md) says.
3. **Check the result:** run [`scripts/docs/check-links.ts`](../scripts/docs/check-links.ts) from the repo's root on `.agents/repo`: every link and anchor in the facts must resolve. Run the skills' tests from this repo: `node --test ci-time.test.ts` in `ci-doctor/references/ci-workflows/scripts/`, `node --test blacksmith-bill.test.ts` in `ci-doctor/references/blacksmith/scripts/` on Blacksmith, `node --test review-record.test.ts` in `review-gate/scripts/` with `review-gate`, and `node --test run-breaks.test.ts` in `proof-tiers/scripts/` with `proof-tiers`.

## Keeping them fresh

[guide section 17](../docs/pages/17-keeping-agent-knowledge-from-going-stale.md) has the method. In short:

- **Code wins.** When a skill and the code disagree, fix the skill in the same change. Scripts do the mechanics, so the words don't have to.
- **Date each lesson,** and keep what was tried and dropped in the repo's one register, which `.agents/repo/ci.md` names (template: [read what was tried](ci-doctor/references/checks/ci-read-what-was-tried.md)), so no agent tries it again.
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
