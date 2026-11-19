# Changelog

Each release is a git tag, `vMAJOR.MINOR.PATCH`. To update, fetch the tags, read every entry between your tag and the new one, do the **Action** lines that apply to your repo, then move your pin. `progress.md` records the version a plan was made with.

- **Major:** a phase, a skill's name or a script's interface changed. Adapted copies need work.
- **Minor:** a new technique, skill section, script or template.
- **Patch:** fixes and wording.

## Unreleased

### One hub skill, `ci-doctor`

- `PROMPT.md` and `docs/prompts/` moved into the new `skills/ci-doctor/` skill: the rules and `progress.md` in its `SKILL.md`, the phases in `references/phases/`, and what the repo carries, a reading route and what not to build in `references/playbook.md`. `PROMPT.md` points at the skill.
- The skills `ci-workflows`, `ci-runners`, `blacksmith`, `speed-up-tests` and `verify-evidence` are now topics of the hub, at `skills/ci-doctor/references/<topic>/TOPIC.md`, with their references and scripts beside them. Reading a PR's CI result moved from `ci-merge-workflow` into the hub's `triage` topic, with `ci-result.md`.
- `checks/` moved to `skills/ci-doctor/references/checks/`, and `templates/agent-knowledge/` to `skills/ci-doctor/references/agent-knowledge/`.
- **Action:** delete installed copies of the five old skills. Point any link or script path at the new folders: `ci-time.ts` is at `skills/ci-doctor/references/ci-workflows/scripts/`, `blacksmith-bill.ts` at `skills/ci-doctor/references/blacksmith/scripts/`. A `progress.md` keeps working: resume at the phase it records.

### The repo is a plugin

- The repo installs as a plugin in Claude Code, Codex, VS Code and Cursor, with `npx skills add` for other agents: manifests in `.claude-plugin/`, `.codex-plugin/` and `.cursor-plugin/`, a root `plugin.json`, and marketplaces listing `ci-doctor@ref0`. The README's Installing says how, per harness, with a prompt to paste into your agent.
- `node scripts/plugin/validate.ts` checks that the manifests agree and that each skill loads as one skill.
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
