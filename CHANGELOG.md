# Changelog

Each release is a git tag, `vMAJOR.MINOR.PATCH`. To update, fetch the tags, read every entry between your tag and the new one, do the **Action** lines that apply to your repo, then move your pin. `progress.md` records the version a plan was made with.

- **Major:** a phase, a skill's name or a script's interface changed. Adapted copies need work.
- **Minor:** a new technique, skill section, script or template.
- **Patch:** fixes and wording.

Under 1.0, a minor release carries what would be a major one.

## Unreleased

### Shards

- **`ci-runners` owns shard splitting.** The shard scripts moved from `scripts/shards/` into `skills/ci-runners/scripts/`, with their tests, so they install with that skill alone: the plan (`test-shards.ts`), `test-groups.ts`, the lanes runner (`test-lanes.ts`), the claims (`test-claims.ts`), the Actions cache client (`ci-cache.ts`), `test-tasks.ts` and `container-pack.ts`. `scripts/shards/README.md` is now the skill's `references/shards.md`, which the hub's Phase 3 excerpt, `ci-workflows`, `speed-up-tests` and the guide point to. **Action:** the templates still call the scripts at `scripts/shards/` in your repo; refresh that copy from `skills/ci-runners/scripts/`, less its `*.test.ts`, and point any link of yours to `scripts/shards/README.md` at `skills/ci-runners/references/shards.md`.
- **Shard times: the median of each file's newest 3.** `test-shards.ts --merge` keeps each file's newest 3 times and plans from their median, so one slow machine doesn't move a file. It drops a time over an hour (`longestFile`), a run dated more than a day ahead, and a file the checkout no longer tracks. The sweep's `test-times` job stays the only writer of the stored times: measured in the source repo, times a week old split shards about as evenly as fresh ones, so a sweep at any cadence is enough. `references/shards.md`'s "Keeping the times current" and `ci-workflows`' tiers say that the sweep's cadence and shard freshness are separate decisions. **Action:** refresh your `scripts/shards/test-shards.ts`. Your stored `test-times.json` reads as it is, each file as one sample; the next sweep adds more.
- **Sweep cadence, from the repo's numbers.** `ci-workflows`' new `scripts/sweep-cadence.ts` measures, read-only through `gh`, the merges a day (first-parent commits, the commits a bisect walks), a full sweep's job-minutes, a quiet slot's, what PR selection skips and the releases. It prices five crons at the sweep's own time of day (every 6 hours, every 12 hours, daily, every 2 days, weekly) by monthly job-minutes and the merges a missed break can hide. `references/tiers.md`'s "Choosing the sweep's cadence" has the agent show them and the user choose one, recorded as a cron in the `ci.md` template's new Sweep cadence. There's no trigger by merge count. A schedule is replayed at its cron's own slots, and one whose longest gap over the calendar's 400-year cycle is more than half the window is marked unavailable. `sweep.yml`'s fallback for a missed cron finds the newest slot with the same cron reader, `ci-workflows`' `scripts/cron.ts`, so a weekly or every-2-days sweep starts once a slot, not every day; its `SWEEP_AT` and `SERVER_AT` are now `SWEEP_CRON` and `SERVER_CRON`, the crons themselves. **Action:** run it for your repo, choose, record the cron, and set it in `sweep.yml`'s cron and `SWEEP_CRON`. Copy `skills/ci-workflows/scripts/cron.ts` to `scripts/sweeps/cron.ts`, and take `sweep.yml`'s `env` and both jobs' checkout, Node and newest-slot steps.

### Templates

- **The dependencies action commits main's disk after the install copy ran, not `on-change`.** `on-change` skips a change under 4 KB, which a new install can be, and then the disk stays a lockfile behind and every job installs again. The copy step now detaches a disk that already holds this install, as the warm path does. **Action:** if you copied `templates/github/actions/dependencies/action.yml`, take its `commit:` line and the copy step's detach.
- **`affected-checks.ts` lists each tree once and reads each commit's files in one batch,** memoised by object ID. It reads only the files a change needs, as before, streaming `cat-file`'s output through a file rather than a buffer, so no repo or file size reaches a buffer's limit. Its output doesn't change; across its tests a run starts 8.4 Git processes, from 12.6. **Action:** if you copied the planner, take the Git section and its callers, or copy it again and refill the config block.

### Skills

- **`speed-up-tests` and `fix-flaky-test`:** a saving under a second a case read from the case's own times, not whole files on a loaded machine; and a test that fails only in deep checkouts, from a path filling a fixed-length stack trace.
- **`ci-merge-workflow`'s releases:** an optional handoff of a checked release tarball to its publish job through the Actions cache, keyed and checked by its digest, for when artifact storage runs out.
- **`speed-up-tests` and `fix-flaky-test`:** an emulator once a file with its state reset per test, a module's settled value, a throttle's remainder, every operation to its hold, a Linux process-kill proof, a rerun's checkout and a single-file job's controls.

### The remote task cache

- **An exact match answers `entries`, as Vite+ 1.7.0 reads it.** The Worker answered one entry's `value` and `blob_id` alone, which Vite+ 1.7.0 can't decode, so every hit printed `remote cache fetch failed` and ran the task while the job still passed. `src/cbor.ts` encodes the list, and `worker.test.ts` checks each reply as 1.7.0 decodes it. The README's pitfalls say to check a replay after moving Vite+. **Action:** if you deployed `cache/remote/`, take `vendor/.../src/fetch.ts` and `src/cbor.ts` and deploy; on a Vite+ older than 1.7.0, check which shape it decodes first.

### The scorer, `@ref0/ci-doctor`

- **A run that never ran isn't CI time.** A failed first attempt on a pull request that took over an hour and has no jobs, such as a fork's run nobody approved that GitHub failed days later, is left out of the PR wait and the red heads, and counted as `wait.neverRan`. One jobs call per such run, at most 60 a report. On two popular repos, such runs had stretched the PR wait p90 to 11 and 58 hours; without them it is 16 and 17 minutes.
- **An unscored repo whose pushes nearly all came from bots says so,** naming the bots, instead of saying that too few pushes ran the main workflows. `wait.botPushes` and `wait.bots` count them.

## v0.2.0

Released 19 November 2026. Nine new skills, the hub's topics moved into them, the phases hand each step to a skill, and every description is rewritten.

### Do first

1. **Install the new skills:** `agent-knowledge`, `blacksmith`, `cache-ci`, `ci-runners`, `ci-workflows`, `fix-flaky-test`, `optimize-graphs`, `prove-it` and `speed-up-tests`. Updating the plugin brings them. With `npx skills`, run `npx skills add https://github.com/ref-0/ci-doctor` again and select every skill. For a copy by hand, copy every folder in `skills/` again.
2. **The hub's topics moved:** if you keep a copy of the hub, delete its `references/graphs/`, `references/speed-up-tests/`, `references/verify-evidence/`, `references/ci-workflows/`, `references/ci-runners/`, `references/blacksmith/` and `references/agent-knowledge/`, then copy `skills/ci-doctor/` again. Point any path your docs or scripts give at the new home: `ci-time.ts` at `skills/ci-workflows/scripts/ci-time.ts`, `blacksmith-bill.ts` and any `--adapter-dir` at `skills/blacksmith/scripts/`, and the templates at `skills/agent-knowledge/templates/`. Your `.agents/repo/` files don't change. A session mid-plan rereads the phase it's on.
3. **Guide section 8 is renamed:** change any link to `08-a-cheaper-test-harness.md` to `08-a-faster-test-harness.md`.
4. **Your instruction file:** change its "CI", "Tests" and "Evidence" lines, and add the "Packages" and "Agent docs" lines, as the `AGENTS.md` snippet in `skills/agent-knowledge/templates/` now reads.

### Skills

- **`prove-it`**, for any claim that something is faster, costs less or is fixed: a benchmark, a before and after, a profile, a cost or saving, a load test or a test result. Write the decision and noise floor first, compare like for like, interleave runs, keep a control, name the limiter, rule out what else a number measured, and label every number with its count, spread and limiter. It reads as general performance and evidence work. The hub's `verify-evidence` topic moved into it; the checks `ci-measure-before-changing-it`, `check-what-ci-ran` and `wait-for-the-effect` stay in the hub.
- **`speed-up-tests`**, for a test, a file or a suite that's slow, in CI or locally: the slow files from CI's records, what each waits on, the fixes and fakes that keep each test's proof, measuring before and after, campaigns over many files, and the Workers and Effect pages. `references/setup.md` has the facts file, what to do without one and an uncached local baseline. The hub's `speed-up-tests` topic moved into it.
- **`fix-flaky-test`**, for a test that fails sometimes, passes only on a retry, or fails only in CI or under load: telling a flake from a real or infrastructure failure, matching the symptom, forcing the interleaving, the fix, proving it with repeat runs and retries off, and filing what's left. A rerun happens only where the repo's flake policy allows one; `references/policy.md` says what to do with none. The hub's `flakes.md` moved into it, as `causes.md`, `symptoms.md` (guide section 11's "Cause, symptom, fix", each with how to force it) and `filing.md`.
- **`ci-workflows`**, for editing a workflow without making it slower, costlier or less trustworthy: adding or changing a job, tiers, moving a test off pull requests, scheduled runs and slow runs. It has the checks for a CI change, the tiers, slow runs and the Rust page, and `ci-time.ts` and its test in its own `scripts/`. The hub's `ci-workflows` topic moved into it, but for `selection.md`, now `optimize-graphs`' `references/selection.md`.
- **`cache-ci`**, for CI that spends ages installing, adding caching, a cache that never hits and cache keys. It opens on the measured reason (in 219 public repos, setup is 15% of a typical repo's job time and 42% in the most setup-heavy tenth, and repos with no dependency cache wait about 40% longer for their size, a correlation), keys each cache by every input that can change its output, and has a key recipe each for a package store, a full install and build outputs. `references/misses.md` has the usual causes of a miss. `ci-workflows`' `caches.md` moved into it.
- **`ci-runners`**, for a bill that's too high, jobs that wait to start, a runner's size or a shard count, capping spend and leaving GitHub-hosted runners, on any provider. The hub's `ci-runners` topic moved into it, with a new `references/queues.md` from guide section 2's "When jobs wait to start", which now summarizes and links it. `billing.md` and `providers.md` keep GitHub's free standard runners on public repos apart from included usage, and link GitHub's pages instead of quoting allowances.
- **`blacksmith`**, for a repo on Blacksmith or moving there: runner labels, sticky disks, the Actions cache and Docker disk, the CLI, billing and the move, with `scripts/blacksmith-bill.ts` and its test. The hub's `blacksmith` topic moved into it. `ci-time.ts --bill blacksmith` finds the adapter only in `blacksmith/scripts/` beside `ci-workflows`, or by `--adapter-dir`. `billing.md` reads a job's rounding from billed records, and says neither Blacksmith's spend limit nor a watcher stops spend exactly at its cap.
- **`optimize-graphs`**, for an edit that reruns or rebuilds most of a workspace, or misses its task cache: package dependencies and cycles, `exports`, entry points and barrels, layers inside a package, task inputs, the CI job graph and the selector that walks them. It measures read-only, says what to propose and in what order, verifies a change by replaying recent merges, and adopts the checks. The hub's `graphs` topic moved into it. Setup caches go to `cache-ci`.
- **`agent-knowledge`**, for writing or fixing `AGENTS.md`, `CLAUDE.md`, skills and agents' docs that went stale or contradict each other: what each harness loads, what goes in the top-level file, a skill, a check, a facts file and the register of what was tried, and keeping it fresh with dated lessons, a drift sweep, size budgets and pinned upstream skills. The hub's `references/agent-knowledge/` moved into it as `templates/`, unchanged but for the README's opening line. Guide section 17 points to it.
- **Each skill installs alone.** Its `references/setup.md` has the facts it reads from `.agents/repo/ci.md` and what to do without them, and `references/checks.md` the checks it follows in short. Every link out of a skill's folder is a full link, to the guide at `ci-doctor.ref0.dev/guide/` or to this repo at the tag `v0.2.0`, and each skill names that release in its `metadata.version`. A skill whose tools live in the repo says how to clone it at that tag and run them. **Action:** if you keep copies of the skills, copy them again.
- **Descriptions:** every skill's follows one shape, from Anthropic's, Claude Code's, Codex's and Cursor's guidance and the Agent Skills spec: what it does, in the third person, then "Use when" and the words people ask with, then "Not for" and each nearby request's sibling. `skills/README.md`'s "Writing a description" has the rules and how to run the trigger cases, and `evals/` has a `claude plugin eval` suite: per skill, three prompts that should load it and two that belong to a sibling. **Action:** harness listings pick up the new descriptions when you update the plugin.

### The hub and its phases

- The hub is the planner and a failed check's triage; its only topic is `triage`. It hands each step to the skill that does it, and a phase says only when and why. Its "Not here" names the four skills the topic map doesn't.
- Phase 0 checks which skills are installed, with a table of the phases that use each, and gives the user the install line for a missing one. Until then the agent reads it on GitHub at the hub's release tag, and reading it authorizes no command.
- Phase 1 maps all five graphs. Phase 2's skills read only records already reachable and classify past attempts, with missing evidence marked unavailable. Phase 3's changes are a table with a Skills column, and the authorization record's Skills row lists the required skills (`prove-it` always) and conditional ones. Phase 4 checks a skill is in that row before each handoff, and re-measures by `prove-it`. Phase 5 names the skill behind each standing part. Phase 6 follows `agent-knowledge` for where the plan's findings go.
- `triage` has a failure-only step that prints a shared setup action's installer log. **Action:** if your repo installs through a shared setup action, add that step.

### The guide

- Section 8 is "A faster test harness", at `docs/pages/08-a-faster-test-harness.md`. Where the guide and skills spoke of what CI costs or pitched a saving, they say "costs less" or "a lower minute price"; "cheap" stays where it means little work.
- Each page has a one-sentence lead under its title, saying what it helps a reader do, which the site uses as the page's description. The techniques index reads a heading's applies-when line from under the lead.
- Section 21, "Optimize all of your graphs": the five graphs that set how far a change reaches and how long CI waits (package dependencies, export paths, layers inside a package, workspace tasks and CI jobs), each with what we did, what it cost, what it saved and what to measure. Sections 4 and 9 link to it.
- Sections 5, 8, 10 and 11 teach what a review of the source repo's history found missing: timing a harness's start by phase, cache restores as writers, an allocation gate on module load, fixtures that fail at once and servers that exit on their parent's EOF (8); fixture builders profiled as algorithms and deep setup built in bulk (10); replaying recorded sessions and images deployed by digest (5); and section 11's "Cause, symptom, fix". Section 20 has the new thresholds. The skills carry the same, in `speed-up-tests`' `workers.md` and `fixes.md`, `fix-flaky-test`'s `symptoms.md`, `ci-workflows`' `tiers.md` and `change-checks.md`, and `cache-ci`'s `caches.md`.
- Section 9: Vite+ 1.7 and later run Oxlint's type-aware rules on tsrs themselves, so the tsgolint adapter goes; section 18 has its row. Its "If you use Effect" says `effect-tsgo tsrs` runs the tsrs `@effect/tsgo` ships. **Action:** on Vite+ 1.7 or later, delete your `oxlint-tsgolint` adapter package, its override and its `oxlint>oxlint-tsgolint` peer allowance, then check that a floating promise in a scratch file still fails `vp lint` and `vp check`.

### The scorer, `@ref0/ci-doctor`

- It reads the CI job graph: jobs, `needs:`, matrices, reusable workflows and skipped jobs, joined with its sampled runs. The "Job graph" block, `jobGraph` in `--json` and two `<ci-report>` lines give the chain that sets the wait, blocked, queued and work time on it, the top blocker and setup inside the path, with two new fixes. It adds no API calls unless a repo has more than 40 workflow files.
- It reads section 21's export paths and workspace tasks from outside: each package's entries, re-exports and overload, with `overloaded-entry` and `root-barrel` flags, and Turborepo, Nx, Vite+ and package-script tasks, with `no-inputs`, `wide-inputs`, `deep-chain` and `task-cycle` flags. The report has a "Graphs" block and `--json` a `graphs` object, in `scripts/graph/`'s shape. It reads in GraphQL batches, 1 to 4 more calls on the repos tried and at most 19, bounded at 1,000 files and 8 levels of re-exports.
- The report has a `stack`: languages, packages by ecosystem, package managers and workspace tools, test runners, lint and format tools, the 20 most-used libraries, CI runners and agent files, each `unknown` when its inputs couldn't be read, and `stack.graph`, the workspace's package graph. Packages in a `template-*` folder no longer count.
- It counts a repo on Vite+ as using Oxlint and Vitest, and takes `oxlint.config.ts`.
- It exports `scoreRepo(repo, { days, token, cacheDir })`, which returns what `--json` prints, and the scoring functions, with their types. The package gains `keywords` and its homepage.

### Scripts, tools and the site

- `scripts/graph/` measures a JavaScript or TypeScript workspace's first four graphs from committed trees, with nothing installed or run, and replays the last 200 merges through them for the share each change reaches. `--json` prints `packages`, `exports`, `layers` and `tasks`, each with `nodes`, `edges` and `flags`. It shares `scorer/src/graph-core.ts` with the scorer. **Action:** in a JavaScript or TypeScript repo, run `node scripts/graph/graph.ts --repo <path-to-repo>` during Phase 1 and paste its headline into Phase 2's baseline. If you copied `scripts/graph/`, copy `scorer/src/graph-core.ts` beside it and point its imports there.
- `tools/workspace/` has `package-graph`: it holds every import across packages to a declared `package-graph.json`, and each layered folder's imports to its layers, with exceptions that only shrink. **Action:** to adopt it, copy `src/graph/`, `config.ts`'s and `bin.ts`'s changes and the test, run `package-graph --generate > package-graph.json`, then add `check:graph` to your static job.
- The remote cache Worker takes two upstream fixes: a multipart part streams past a boundary prefix that isn't one, and cleanup frees a generation whose multipart upload R2 can no longer abort. Vite+ 1.7's protocol is 1.6's. **Action:** if you deployed the Worker, copy `vendor/vite-plus-remote-cache-cloudflare/src/multipart.ts` and `database.ts`'s changes, marked `local:`, and redeploy.
- `ci-doctor.ref0.dev` is served by the site's Worker, which passes `/guide/*` and `/llms.txt` to the guide's Worker; `/` is the site's home page.
- `node scripts/check.ts` gains "links, each skill alone", which copies each skill's folder alone and fails a relative link out of it and a full link that names no file in the repo or points at another release's tag; "descriptions"; and an old-name scan of the moved topics' paths. Links to the release's tag check against the working tree, so they pass before the tag is pushed.
- The README opens on both pains: "Burning time and money on CI? ci-doctor is a set of skills and tools your agents use to make CI faster and cost less, and keep it that way.", and `llms.txt`'s summary with it. It states the measured result with its cohort, links section 19, and links [ci-doctor-db](https://github.com/ref-0/ci-doctor-db), the measurements behind the score.

## v0.1.0

The first public release:

- a plugin for Claude Code, Codex, VS Code and Cursor, and skills for any agent through `npx skills add`: the `ci-doctor` hub, which runs the phased plan with resumable progress and day-to-day CI work, and `review-gate`, `ci-merge-workflow`, `test-audit` and `proof-tiers`;
- the guide, sections 1–20, also at https://ci-doctor.ref0.dev/guide/ with an `llms.txt`;
- the scorer, `npx @ref0/ci-doctor`, which scores a repo's CI from its Actions history on your machine, private repos included;
- reference scripts for timing, shards, budgets, flakes, records, sweeps and local test slots;
- the GitHub Actions templates and the selection planner, which records why each test was selected;
- the Vite+ remote cache Worker;
- `node scripts/check.ts`, the build checks.

### For copies made before this release

Before v0.1.0, the repo had the phased prompt in `PROMPT.md` and `docs/prompts/`, and nine skills installed by `skills/install.ts`. To bring such a copy to this release, do the **Action** lines below.

#### The guide on ci-doctor.ref0.dev

- `node scripts/site/build.ts` builds the guide for `https://ci-doctor.ref0.dev/guide/`: the Markdown in `docs/`, `skills/`, `templates/`, `scripts/`, `tools/`, `cache/` and `scorer/`, the README, CHANGELOG and LICENSE, and every file or folder they link to, each at the path it has in the repo, so a relative link resolves there as it does here. `/llms.txt` lists the guide's pages, the skills and the reference implementations, and `/guide/llms-full.txt` holds the guide whole. It isn't deployed yet.
- The hub's "Outside the skills" names `https://ci-doctor.ref0.dev/guide/` for a skills-only install, with the repo's paths.
- `node scripts/check.ts` builds the site and fails on a link that leaves what it serves, or a page `llms.txt` misses or names unserved.
- **Action:** none.

#### The AI Quickstart installs the plugin

- The README's AI Quickstart prompt installs the skills by the agent's own method, then starts the plan with the `ci-doctor` skill. The clone prompt stays, for trying it without installing, and now reads `skills/ci-doctor/SKILL.md` directly. `PROMPT.md` still points there, so older copies of the prompt keep working.
- A `<ci-report>` block, from `npx @ref0/ci-doctor` or ci-doctor.ref0.dev, can follow either prompt. Phase 2 checks its numbers against the repo's own runs and collects what it left out. The scorer's output says how to paste it.
- **Action:** none. If you saved the old clone prompt, it still works; the new one skips `PROMPT.md`.

#### The scorer, `@ref0/ci-doctor`

- `scorer/` holds the scorer, published to npm as `@ref0/ci-doctor`. `npx @ref0/ci-doctor` scores the checkout's repo from its GitHub Actions history, reading everything through `gh`, so a private repo scores the same as a public one. It prints to the terminal and writes no files unless asked. `npx @ref0/ci-doctor agents skills` prints the install steps, which `node scripts/check.ts` keeps in step with this README.
- **Action:** none.

#### Build checks

- `node scripts/check.ts` runs every build check: the plugin's manifests, the phase excerpts against their sources, links in the repo and in a skills-only copy, a scan for replaced names and paths, the docs budget, and every skill script's tests.
- A skill script's test no longer skips when its fixture is missing: `review-record.test.ts` needs `review-recheck.yml`, and `ci-time.test.ts` the hub's `blacksmith` adapter. `ci-time.ts` finds that adapter in the hub, not in a sibling skill.
- **Action:** none for a repo that installed the plugin. If you copied `review-record.test.ts` or `ci-time.test.ts`, copy this release's.

#### `review-gate`, and settings in the repo's own files

- `code-review` is now `review-gate`, in its folder, its name and every mention. In Claude Code it's `/ci-doctor:review-gate`, apart from the built-in `/code-review`.
- `review-gate` holds the gate CI checks: what it requires, the tests reviewer, the record and the reviewed head. How we planned reviewers, ran rounds and checked findings moved to guide section 15, "How we run a review", since who reviews and how is each repo's own choice.
- A link between two of `review-gate`, `ci-merge-workflow`, `test-audit` and `proof-tiers` says to follow it only if the repo adopted that skill; otherwise the repo's own process applies.
- `ci-time.ts` reads its settings from `.agents/repo/ci-time.json`, and `review-record.ts` from `.agents/repo/review-record.json`, in place of the config blocks people edited. Their templates are in the hub's `references/agent-knowledge/repo-facts/`. CI's review step reads the base branch's copy, through `REVIEW_SETTINGS`.
- **Action:** rename `code-review` to `review-gate` in your `AGENTS.md`, `.agents/repo/review.md` and your gate's `<review-checker>` path. Move the values you set in `ci-time.ts`'s config block and `review-record.ts`'s CONFIG block into those two files, then replace your copies of the scripts with this release's, unedited. In `ci.yml`'s review step, add `.agents/repo/review-record.json` to the sparse checkout and set `REVIEW_SETTINGS`, as the template does.

#### One hub skill, `ci-doctor`

- `PROMPT.md` and `docs/prompts/` moved into the new `skills/ci-doctor/` skill: the rules and `progress.md` in its `SKILL.md`, the phases in `references/phases/`, and what the repo carries, a reading route and what not to build in `references/playbook.md`. `PROMPT.md` points at the skill.
- The skills `ci-workflows`, `ci-runners`, `blacksmith`, `speed-up-tests` and `verify-evidence` are now topics of the hub, at `skills/ci-doctor/references/<topic>/TOPIC.md`, with their references and scripts beside them. Reading a PR's CI result moved from `ci-merge-workflow` into the hub's `triage` topic, with `ci-result.md`.
- `checks/` moved to `skills/ci-doctor/references/checks/`, and `templates/agent-knowledge/` to `skills/ci-doctor/references/agent-knowledge/`.
- The hub carries what Phases 0–3 need from the guide and the reference READMEs, in `references/excerpts/phase-<n>.md`, generated from their sources by `node scripts/skills/excerpts.ts`. Phase 1 reads a technique index of guide sections 2–17 and section 18 from there, in place of reading sections 2–19 whole.
- Each technique heading in guide sections 2–17 opens with an **Applies when:** and **Skip when:** line, and Phase 1's index carries them, so a skills-only install can tell which techniques apply. The excerpts also carry section 5's release checklist, section 6's "Trust", section 12's spend-audit rules, section 14's local runner contract and its shared-machine slots, and section 17, each linked from the step that needs it.
- Phase 1 says to time local checks from CI's logs and the repo's docs, with no local installs, tests or linters before approval. Phase 4 links the check for a change to CI. The `ci-runners` topic sends a queue question to the provider's start-up by hour of day, and to `blacksmith`. The hub says what to do when `progress.md` can't be written.
- **Action:** delete installed copies of the five old skills. Point any link or script path at the new folders: `ci-time.ts` is at `skills/ci-doctor/references/ci-workflows/scripts/`, `blacksmith-bill.ts` at `skills/ci-doctor/references/blacksmith/scripts/`. A `progress.md` keeps working: resume at the phase it records.

#### The repo is a plugin

- The repo installs as a plugin in Claude Code, Codex, VS Code and Cursor, with `npx skills add` for other agents: manifests in `.claude-plugin/`, `.codex-plugin/` and `.cursor-plugin/`, a root `plugin.json`, and marketplaces listing `ci-doctor@ref0`. The README's Installing says how, per harness, with a prompt to paste into your agent.
- `node scripts/plugin/validate.ts` checks that the manifests agree and that each skill loads as one skill.
- The hub's `SKILL.md` names its release in `metadata.version`, which the build checks keep equal to `plugin.json`'s, so a skills-only install knows which tag its links mean.
- Codex's marketplace lists the plugin from the marketplace's own checkout (`"source": "local", "path": "./"`), not a second clone of the repo's URL. A local folder installs without GitHub, and `codex plugin marketplace add ref-0/ci-doctor --ref <tag>` installs that tag's skills, where the URL source installed the default branch's.
- `skills/install.ts` and its tests are gone: a harness installs every skill, and the plan decides which ones the repo adopts. `scripts/docs/check-links.ts` checks links in their place.
- **Action:** if you installed skills with `install.ts`, delete those copies and install the plugin instead. Replace any `install.ts --check` call with `node scripts/docs/check-links.ts <paths>`.
