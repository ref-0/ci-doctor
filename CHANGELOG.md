# Changelog

Each release is a git tag, `vMAJOR.MINOR.PATCH`. To update, fetch the tags, read every entry between your tag and the new one, do the **Action** lines that apply to your repo, then move your pin. `progress.md` records the version a plan was made with.

- **Major:** a phase, a skill's name or a script's interface changed. Adapted copies need work.
- **Minor:** a new technique, skill section, script or template.
- **Patch:** fixes and wording.

## Unreleased

## v0.1.0

The first public release:

- the phased prompt (`PROMPT.md`, `docs/prompts/`), with resumable progress (`templates/agent-knowledge/progress.md`);
- the guide, sections 1–20;
- nine skills and their checks;
- reference scripts for timing, shards, budgets, flakes, records, sweeps and local test slots;
- the GitHub Actions templates and the selection planner, which records why each test was selected;
- the Vite+ remote cache Worker.
