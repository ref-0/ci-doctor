<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img alt="ref0 ci-doctor" src="assets/logo-light.svg" />
  </picture>
</h1>

Everything we learned getting CI to a ~3-minute median in a 1.5M LOC TypeScript + Rust monorepo, where AI agents write most of the code, without letting tests prove less. It cost us a lot of time and money to learn. It's all here so it doesn't cost you the same.

## AI Quickstart

Copy this into your coding agent, from your repo's root:

```text
Clone https://github.com/ref-0/ci-doctor.git into a folder outside this repo, check out its newest release tag, read its PROMPT.md, and follow it for this repo, starting at the beginning.
```

Your agent maps your stack, measures your CI's median and p90, and writes a plan for you to review. Until you approve it, it only reads: no installs, test runs, CI runs, account setup or schedules.

## Installing

The plugin holds five skills, in [`skills/`](skills/README.md): `ci-doctor`, which runs the plan and day-to-day CI work, and `review-gate`, `ci-merge-workflow`, `test-audit` and `proof-tiers`. Every one is installed; the plan you approve decides which ones your repo adopts. Installing adds skills only: no MCP server, no hooks, and no scripts run. Choose one method.

### Claude Code

```sh
claude plugin marketplace add ref-0/ci-doctor
claude plugin install ci-doctor@ref0
```

Start a new session, or run `/reload-plugins` in an open one. Inside Claude Code the same commands are `/plugin marketplace add ref-0/ci-doctor` and `/plugin install ci-doctor@ref0`. The skills are namespaced, such as `/ci-doctor:review-gate`.

### Codex

```sh
codex plugin marketplace add ref-0/ci-doctor
codex plugin add ci-doctor@ref0
```

Start a new Codex session after installing.

### VS Code / GitHub Copilot

1. Enable `chat.plugins.enabled` in VS Code's settings.
2. Run **Chat: Install Plugin From Source** from the Command Palette.
3. Enter `https://github.com/ref-0/ci-doctor`.

### Cursor

Open **Customize**, select **Plugins**, choose **From GitHub Repository**, and enter `https://github.com/ref-0/ci-doctor`.

### Any other agent

```sh
npx skills add https://github.com/ref-0/ci-doctor
```

Select your agent when it asks. This copies the skill folders only; the guide and the reference scripts they link to stay in this repo, at the release tag.

### By hand

Clone this repo at its newest release tag and copy each folder in `skills/` into your agent's skills folder:

| Agent | Skills folder |
| --- | --- |
| Claude Code | `~/.claude/skills/`, or `.claude/skills/` in a repo |
| Codex | `~/.agents/skills/`, or `.agents/skills/` in a repo |
| Cursor | `~/.cursor/skills/` |
| OpenCode | `~/.config/opencode/skills/` |
| Pi | `~/.pi/agent/skills/` |

[`docs/harnesses.md`](docs/harnesses.md#skills-folder-and-instruction-file) lists more. Updating is each harness's own; for a copy by hand, read [`CHANGELOG.md`](CHANGELOG.md) and copy again.

### Or let your agent install it

```text
Install the ci-doctor skills using one method. In Claude Code, run `claude plugin marketplace add ref-0/ci-doctor`, then `claude plugin install ci-doctor@ref0`, and start a new session or run `/reload-plugins`. In Codex, run `codex plugin marketplace add ref-0/ci-doctor`, then `codex plugin add ci-doctor@ref0`, and start a new session. In VS Code or Cursor, install `https://github.com/ref-0/ci-doctor` as a plugin from source. For another agent, run `npx skills add https://github.com/ref-0/ci-doctor` and select the agent. Then use the ci-doctor skill to start its plan for this repo.
```

## Contents

| Path | What |
|---|---|
| [`PROMPT.md`](PROMPT.md) | Points your agent at the `ci-doctor` skill |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed in each release, and what to do about it |
| [`docs/`](docs/) | The guide and harness notes |
| [`skills/`](skills/README.md) | The plugin's skills: the `ci-doctor` hub, with the plan's phases, its topics, the one-rule checks and the agent-knowledge templates, and the skills for review, merging, test value and proof tiers |
| [`scripts/`](scripts/README.md) | Timing, shards, budgets, flakes, sweeps and local test slots |
| [`tools/`](tools/) | Workspace tools and upstream skill sync |
| [`templates/`](templates/) | CI workflows and the selection planner |
| [`cache/remote/`](cache/remote/README.md) | Vite+ remote cache on Cloudflare |

Everything is a reference implementation with `<placeholders>`. Adapt it; don't copy it unchanged.

## Updating

Releases are tags. Read [`CHANGELOG.md`](CHANGELOG.md) from your tag to the newest, do its **Action** lines, then move your pin.

## Contributing

Run `node scripts/plugin/validate.ts` after changing a manifest or a skill's folder: the plugin's manifests must agree, and each skill must be one Codex and Claude Code load.

## License

[MIT](LICENSE)
