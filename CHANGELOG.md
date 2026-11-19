# Changelog

Each release is a git tag, `vMAJOR.MINOR.PATCH`. To update, fetch the tags, read every entry between your tag and the new one, do the **Action** lines that apply to your repo, then move your pin. `progress.md` records the version a plan was made with.

- **Major:** a phase, a skill's name or a script's interface changed. Adapted copies need work.
- **Minor:** a new technique, skill section, script or template.
- **Patch:** fixes and wording.

## Unreleased

### The guide on ci.ref0.dev

- `node scripts/site/build.ts` builds the guide for `https://ci.ref0.dev/guide/`: the Markdown in `docs/`, `skills/`, `templates/`, `scripts/`, `tools/`, `cache/` and `scorer/`, the README, CHANGELOG and LICENSE, and every file or folder they link to, each at the path it has in the repo, so a relative link resolves there as it does here. `/llms.txt` lists the guide's pages, the skills and the reference implementations, and `/guide/llms-full.txt` holds the guide whole. It isn't deployed yet.
- The hub's "Outside the skills" names `https://ci.ref0.dev/guide/` for a skills-only install, with the repo's paths.
- `node scripts/check.ts` builds the site and fails on a link that leaves what it serves, or a page `llms.txt` misses or names unserved.
- **Action:** none. A skills-only install that followed the hub to ci.ref0.dev's root reads under `/guide/` instead.

### The AI Quickstart installs the plugin

- The README's AI Quickstart prompt installs the skills by the agent's own method, then starts the plan with the `ci-doctor` skill. The clone prompt stays, for trying it without installing, and now reads `skills/ci-doctor/SKILL.md` directly. `PROMPT.md` still points there, so older copies of the prompt keep working.
- A `<ci-report>` block, from `npx @ref0/ci-doctor` or ci.ref0.dev, can follow either prompt. Phase 2 checks its numbers against the repo's own runs and collects what it left out. The scorer's output says how to paste it.
- **Action:** none. If you saved the old clone prompt, it still works; the new one skips `PROMPT.md`.

### The scorer, `@ref0/ci-doctor`

- `scorer/` holds the scorer as an npm package, not yet published. `npx @ref0/ci-doctor` scores the checkout's repo from its GitHub Actions history, reading everything through `gh`, so a private repo scores the same as a public one. It prints to the terminal and writes no files unless asked. `npx @ref0/ci-doctor agents skills` prints the install steps, which `node scripts/check.ts` keeps in step with this README.
- **Action:** none.

### Build checks

- `node scripts/check.ts` runs every build check: the plugin's manifests, the phase excerpts against their sources, links in the repo and in a skills-only copy, a scan for replaced names and paths, the docs budget, and every skill script's tests.
- A skill script's test no longer skips when its fixture is missing: `review-record.test.ts` needs `review-recheck.yml`, and `ci-time.test.ts` the hub's `blacksmith` adapter. `ci-time.ts` finds that adapter in the hub, not in a sibling skill.
- **Action:** none for a repo that installed the plugin. If you copied `review-record.test.ts` or `ci-time.test.ts`, copy this release's.

### `review-gate`, and settings in the repo's own files

- `code-review` is now `review-gate`, in its folder, its name and every mention. In Claude Code it's `/ci-doctor:review-gate`, apart from the built-in `/code-review`.
- A link between two of `review-gate`, `ci-merge-workflow`, `test-audit` and `proof-tiers` says to follow it only if the repo adopted that skill; otherwise the repo's own process applies.
- `ci-time.ts` reads its settings from `.agents/repo/ci-time.json`, and `review-record.ts` from `.agents/repo/review-record.json`, in place of the config blocks people edited. Their templates are in the hub's `references/agent-knowledge/repo-facts/`. CI's review step reads the base branch's copy, through `REVIEW_SETTINGS`.
- **Action:** rename `code-review` to `review-gate` in your `AGENTS.md`, `.agents/repo/review.md` and your gate's `<review-checker>` path. Move the values you set in `ci-time.ts`'s config block and `review-record.ts`'s CONFIG block into those two files, then replace your copies of the scripts with this release's, unedited. In `ci.yml`'s review step, add `.agents/repo/review-record.json` to the sparse checkout and set `REVIEW_SETTINGS`, as the template does.

### One hub skill, `ci-doctor`

- `PROMPT.md` and `docs/prompts/` moved into the new `skills/ci-doctor/` skill: the rules and `progress.md` in its `SKILL.md`, the phases in `references/phases/`, and what the repo carries, a reading route and what not to build in `references/playbook.md`. `PROMPT.md` points at the skill.
- The skills `ci-workflows`, `ci-runners`, `blacksmith`, `speed-up-tests` and `verify-evidence` are now topics of the hub, at `skills/ci-doctor/references/<topic>/TOPIC.md`, with their references and scripts beside them. Reading a PR's CI result moved from `ci-merge-workflow` into the hub's `triage` topic, with `ci-result.md`.
- `checks/` moved to `skills/ci-doctor/references/checks/`, and `templates/agent-knowledge/` to `skills/ci-doctor/references/agent-knowledge/`.
- The hub carries what Phases 0–3 need from the guide and the reference READMEs, in `references/excerpts/phase-<n>.md`, generated from their sources by `node scripts/skills/excerpts.ts`. Phase 1 reads a technique index of guide sections 2–17 and section 18 from there, in place of reading sections 2–19 whole.
- Each technique heading in guide sections 2–17 opens with an **Applies when:** and **Skip when:** line, and Phase 1's index carries them, so a skills-only install can tell which techniques apply. The excerpts also carry section 5's release checklist, section 6's "Trust", section 12's spend-audit rules, section 14's local runner contract and its shared-machine slots, and section 17, each linked from the step that needs it.
- Phase 1 says to time local checks from CI's logs and the repo's docs, with no local installs, tests or linters before approval. Phase 4 links the check for a change to CI. The `ci-runners` topic sends a queue question to the provider's start-up by hour of day, and to `blacksmith`. The hub says what to do when `progress.md` can't be written.
- **Action:** delete installed copies of the five old skills. Point any link or script path at the new folders: `ci-time.ts` is at `skills/ci-doctor/references/ci-workflows/scripts/`, `blacksmith-bill.ts` at `skills/ci-doctor/references/blacksmith/scripts/`. A `progress.md` keeps working: resume at the phase it records.

### The repo is a plugin

- The repo installs as a plugin in Claude Code, Codex, VS Code and Cursor, with `npx skills add` for other agents: manifests in `.claude-plugin/`, `.codex-plugin/` and `.cursor-plugin/`, a root `plugin.json`, and marketplaces listing `ci-doctor@ref0`. The README's Installing says how, per harness, with a prompt to paste into your agent.
- `node scripts/plugin/validate.ts` checks that the manifests agree and that each skill loads as one skill.
- The hub's `SKILL.md` names its release in `metadata.version`, which the build checks keep equal to `plugin.json`'s, so a skills-only install knows which tag its links mean.
- Codex's marketplace lists the plugin from the marketplace's own checkout (`"source": "local", "path": "./"`), not a second clone of the repo's URL. A local folder installs without GitHub, and `codex plugin marketplace add ref-0/ci-doctor --ref <tag>` installs that tag's skills, where the URL source installed the default branch's.
- `skills/install.ts` and its tests are gone: a harness installs every skill, and the plan decides which ones the repo adopts. `scripts/docs/check-links.ts` checks links in their place.
- **Action:** if you installed skills with `install.ts`, delete those copies and install the plugin instead. Replace any `install.ts --check` call with `node scripts/docs/check-links.ts <paths>`.

## v0.1.0

The first public release:

- the phased prompt (`PROMPT.md`, `docs/prompts/`), with resumable progress (`templates/agent-knowledge/progress.md`);
- the guide, sections 1–20;
- nine skills and their checks;
- reference scripts for timing, shards, budgets, flakes, records, sweeps and local test slots;
- the GitHub Actions templates and the selection planner, which records why each test was selected;
- the Vite+ remote cache Worker.
