# Changelog

Each release is a git tag, `vMAJOR.MINOR.PATCH`. To update, fetch the tags, read every entry between your tag and the new one, do the **Action** lines that apply to your repo, then move your pin. `progress.md` records the version a plan was made with.

- **Major:** a phase, a skill's name or a script's interface changed. Adapted copies need work.
- **Minor:** a new technique, skill section, script or template.
- **Patch:** fixes and wording.

## Unreleased

- The scorer reads the CI job graph: jobs, `needs:`, matrices, reusable workflows and skipped jobs, from the workflow files it already reads, joined with its sampled PR runs' jobs. The report's new "Job graph" block, `jobGraph` in `--json` and two `<ci-report>` lines give the chain that sets the wait, blocked, queued and work time on it, the top blocker, setup inside the path, guessed waits on a single step, and runs with a wait the YAML can't show; runs whose jobs don't fit the default branch's YAML are counted and left out. Two fixes come with it: "Setup on the critical path" (guide section 7) and "A blocker most jobs wait on" (section 21). It adds no API calls unless a repo has more than 40 workflow files, and a workflow read that fails leaves that part of the graph unknown instead of stopping the run. Guide section 21's "CI jobs" says what it reports.
- Guide sections 5, 8, 10 and 11 teach what a review of the source repo's history found missing. Section 8: timing a harness's start by phase and overlapping independent setup, cache restores as writers (content-addressed build copies), cheap module load with an allocation gate, fixtures that fail at once on a bad socket, and detached servers that exit on their parent's EOF. Section 10: fixture builders profiled as algorithms, immutable inputs built once with mutable state per test, deep setup built in bulk with an equivalence check, and interactive proofs that wait for completion evidence. Section 5: replaying recorded sessions through the real boundary, and container images deployed by digest with changed-only builds. Section 11 has a new "Cause, symptom, fix" list: `ETXTBSY` across fork and exec, Git's auto maintenance in fixtures, long socket paths, orphaned fixture servers, refused uploads that reset, reporting steps reading an empty sparse tree, and installers that keep their log on the runner. Section 20 has the new thresholds.
- The hub's topics carry the same: `speed-up-tests`' `workers.md` has Workers notes on startup at module load, Miniflare's start by phase, cache restores under `dist/`, refused uploads through the local proxy and persisted Workflow waits; `fixes.md` has three new kinds and a build-once checklist; `flakes.md` has "Match the symptom"; `ci-workflows`' `tiers.md` has a replay recipe, `caches.md` digest-pinned images and `change-checks.md` steps that must not gate; `triage` has the installer-log step. **Action:** if your repo installs through a shared setup action, add the failure-only step that prints the installer's log; if you keep a copy of the hub, copy the changed reference files and the regenerated `references/excerpts/`.
- Guide section 21, "Optimize all of your graphs": the five graphs that set how far a change reaches and how long CI waits (package dependencies, package export paths, layers inside a package, workspace tasks and CI jobs), each with what we did, what it cost, what it saved and what to measure, and how to adopt the first three in a repo that has none. Sections 4 and 9 link to it. The measuring tool for graphs 1–4 is coming to `scripts/graph/`, and the scorer's job graph for graph 5.
- The hub has a `graphs` topic, and Phase 1 maps all five graphs; its technique index takes section 21's headings. **Action:** if you keep a copy of the hub, copy `references/graphs/`, the topic map's new row, Phase 1's new bullets and the regenerated `references/excerpts/phase-1.md`.
- `tools/workspace/` has `package-graph`: it holds every import across packages to a declared `package-graph.json` (by package, entry point and kind, with no import of an app and no relative path out of a package) and each layered folder's imports to its layers, with exceptions that only shrink. `--generate` writes the current graph for a first declaration. Its README gives the contracts for entry re-exports and for layers in another language. **Action:** to adopt it, copy `src/graph/`, `config.ts`'s and `bin.ts`'s changes and the test, run `package-graph --generate > package-graph.json`, then add `check:graph` to your static job.
- The README links [ci-doctor-db](https://github.com/ref-0/ci-doctor-db), the measurements, calibration and learning loop behind the score.
- Guide section 9: Vite+ 1.7 and later run Oxlint's type-aware rules on tsrs themselves, so the tsgolint adapter, its override and its peer rule go; the section says to upgrade rather than build it, and how to show type-aware lint still runs after deleting it. Section 18 has the adapter's row, and `tools/workspace/`'s README drops its contract. **Action:** on Vite+ 1.7 or later, delete your `oxlint-tsgolint` adapter package, its override and its `oxlint>oxlint-tsgolint` peer allowance, then check that a floating promise in a scratch file still fails `vp lint` and `vp check`.
- Guide section 9's "If you use Effect": `effect-tsgo tsrs` runs the tsrs that `@effect/tsgo` ships, so the type check and type-aware lint can run different tsrs releases.
- The remote cache Worker takes two upstream fixes: a multipart part streams past a boundary prefix that isn't one, instead of buffering the whole body, and cleanup frees a generation whose multipart upload R2 can no longer abort, instead of retrying it forever with its bytes charged. Its vendored README says what else upstream changed and why it isn't taken, and that Vite+ 1.7's protocol is 1.6's. **Action:** if you deployed the Worker, copy `vendor/vite-plus-remote-cache-cloudflare/src/multipart.ts` and `database.ts`'s changes, marked `local:`, and redeploy.
- The scorer's report has a `stack`: languages, packages by ecosystem, package managers and workspace tools, every test runner found, lint and format tools, the 20 libraries the most packages use, CI runners by provider and agent files, each `unknown` when its inputs couldn't be read. It reads each package's manifest, 100 to a GraphQL query, which adds one call for most repos. `stack.graph` holds the workspace's package graph from the same reads: the packages each workspace declares, each one's internal dependencies, through aliases, renames and paths, and its `exports` entries, and the repo's package and edge counts, cycles, deepest chain and the 5 packages with the most dependents, unknown, with the reason, when a manifest couldn't be read or parsed. The terminal report shows it as a block. Packages in a `template-*` folder, such as a scaffolder's templates, no longer count as the repo's packages.
- `@ref0/ci-doctor` exports `scoreRepo(repo, { days, token, cacheDir })`, which returns the report `--json` prints, and the scoring functions, with their types.
- The scorer counts a repo on Vite+ as using Oxlint and Vitest, which Vite+ bundles, and takes Oxlint's `oxlint.config.ts`, so such a repo no longer gets "Lint with Oxlint or Biome".

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
