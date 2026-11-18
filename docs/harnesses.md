# Harnesses: parallel agents and recurring work

How to run several agents at once, each in its own checkout, and how to schedule the standing work in [guide section 16](pages/16-standing-automations.md), in each harness we know. [PROMPT Phase 0](prompts/phase-0-know-your-harness-and-your-helpers.md) asks you to find out which of these yours has; prefer what the user already uses. One agent and no schedule is a complete way to work: every schedule is opt-in, and the default follow-up is a manual, read-only check.

Harnesses change fast. Each row below was checked against its docs in November 2026; check the linked page before you rely on a feature, and if you can't confirm one exists, say so and use a more portable option.

## What you need from a harness

- **Parallel work:** start child agents, each in its own git worktree and branch, so their edits and test runs don't collide, and ideally a second model for reading. Start each worktree from an explicit ref: the default branch for independent work.
- **A schedule,** of one of four kinds, each with its own identity and cost:

  | Kind | Runs where | Signed in as | Costs |
  | --- | --- | --- | --- |
  | Interactive session loop | Inside an open session | The session's account | Model usage; stops with the session |
  | Cloud agent job | A fresh clone on the harness's servers | Its own identity, with credentials scoped to the job | Model usage, plus the provider's job pricing |
  | Script-only GitHub Actions cron | A fresh runner | The workflow's `GITHUB_TOKEN` and the permissions you grant | Runner minutes; no model |
  | Host timer (systemd, cron) | Your machine, with its files | The intended user, with its config home and `PATH` | The machine; model usage if it runs an agent |

  Prefer a script for a deterministic task. Use a model only when the job needs judgement.
- **Limits that hold:** the agreed number of agents at once, the machine's slot cap for tests ([guide section 14](pages/14-local-speed-and-many-agents-on-one-machine.md)), and a scheduled run's permissions no wider than its job.
- **A plan for the first run:** who checks the first eligible result, and what happens if no run starts.

## Skills folder and instruction file

Where each harness looks for skills and which instruction file it loads at the start. Install skills into that folder (`<skills-dir>` in [`skills/README.md`](../skills/README.md#install)) and put the [agent-knowledge snippet](../templates/agent-knowledge/README.md) in that file.

| Harness | Repo skills folder (`<skills-dir>`) | User skills folder | Instruction file |
| --- | --- | --- | --- |
| Claude Code | `.claude/skills/<skill>/SKILL.md` | `~/.claude/skills/` | `CLAUDE.md` or `.claude/CLAUDE.md`; it reads `AGENTS.md` when no `CLAUDE.md` exists, or through a `@AGENTS.md` import in one |
| Codex CLI | `.agents/skills/`, in any folder from the working directory up to the repo root | `~/.agents/skills/` | `AGENTS.md` (an `AGENTS.override.md` in the same folder wins), one per folder from the root down, plus `~/.codex/AGENTS.md` |
| T3 Code | The folders of the provider each thread runs | The same | The same |

Docs: [Claude Code skills](https://code.claude.com/docs/en/skills), [Claude Code's instruction files](https://code.claude.com/docs/en/memory), [Codex skills](https://developers.openai.com/codex/skills), [Codex's AGENTS.md](https://developers.openai.com/codex/guides/agents-md). One `AGENTS.md`, imported from `CLAUDE.md`, serves both.

## Claude Code

- **Subagents** run in their own context and return a summary; several run in parallel, in the background or the foreground. Define reusable ones as Markdown files in `.claude/agents/` (project) or `~/.claude/agents/` (user). Docs: [subagents](https://code.claude.com/docs/en/sub-agents).
- **Worktrees:** `isolation: worktree` in a subagent's frontmatter runs it in a temporary git worktree, removed if it changed nothing. It branches from the repo's default branch unless the `worktree.baseRef` setting says to branch from your current work. Docs: [choose the base branch](https://code.claude.com/docs/en/worktrees#choose-the-base-branch).
- **`/loop`** reruns a prompt on an interval, or at one Claude chooses, inside an open session; tasks are session-scoped, stop when the session exits, and recurring ones expire after seven days. Good for watching a run or a PR, not for a standing job. Docs: [run prompts on a schedule](https://code.claude.com/docs/en/scheduled-tasks).
- **`/schedule` (cloud scheduled tasks, formerly routines)** run a saved prompt against a fresh clone of the repo, on a schedule, an API call or a GitHub event, with the machine off. They don't share your interactive session's local files or config home: configure their identity and credentials for the job itself. They suit the slow-tests campaign or a docs drift sweep, not the machine timers. Docs: [scheduled tasks](https://code.claude.com/docs/en/routines).
- **Desktop scheduled tasks** run on your machine with its files and tools, while the app runs.
- **Headless:** `claude -p "<prompt>"` for scripts, CI and timers. Docs: [headless mode](https://code.claude.com/docs/en/headless).

## Codex CLI

- **`codex exec "<task>"`** runs without the TUI: progress to stderr, the final message to stdout. It's read-only by default; `--sandbox workspace-write` lets it edit. `--json` streams events, `-o <file>` saves the last message, and `codex exec resume --last` continues a session. Docs: [non-interactive mode](https://developers.openai.com/codex/non-interactive-mode).
- **Parallel work:** start one `codex exec` per git worktree, each from its own folder, and wait for them all. Name the start ref, or the worktree starts from your current `HEAD`: `git fetch origin && git worktree add ../<repo>-<task> -b <branch> origin/<default-branch>`.
- **In CI:** use [`openai/codex-action`](https://github.com/openai/codex-action). Pass the provider's key only as the action's input, never as a job-level variable in a workflow that runs repository code. The action keeps the key safe only with its documented privilege setting (`safety-strategy: drop-sudo` or a configured unprivileged user) on a compatible runner: read [its credential safeguards](https://github.com/openai/codex-action/blob/main/docs/security.md#protecting-your-openai_api_key) before you enable it. Let a separate job, with its own scoped credentials and no model key, apply any change.

## T3 Code

[T3 Code](https://github.com/pingdotgg/t3code) runs Claude, Codex and other providers' agents in threads, each of which can have its own git worktree. That much is in its public docs.

Some builds also give the agent orchestration tools: starting a child agent on a named provider and model, optionally in its own worktree, and scheduling a prompt to run on a cadence. Their names and options vary by build and aren't in the public user docs. Check your build's tool list before you rely on one, keep within the agreed agent count, and say which build you checked. Without them, use the plain recipes: one worktree per task with `git worktree add`, and each harness's headless command, as the sections above and below show.

## GitHub Actions cron

A scheduled workflow (`on: schedule:` plus `workflow_dispatch:`) runs in a fresh checkout. It's the most portable option.

- **Script-only first.** The [`templates/github/`](../templates/github/README.md) sweep is a script-only cron: it dispatches ordinary CI and runs no agent. Use that shape for anything a script can decide.
- **An agent headless,** when the job needs one: the job runs the harness's headless command with the provider's key passed only to the step or action that needs it.
- **Don't trust the cron's time:** GitHub starts scheduled runs late or skips them under load. Make a merge or a dispatch start a missed run, as the sweep does ([guide section 5](pages/05-tiers-what-runs-where.md#cron-is-not-a-scheduler-you-can-trust)).
- **Least privilege:** give the job only the permissions its job needs, and let a separate job, without the model's key, apply any change, as in Codex's auto-fix pattern. [Claude Code's GitHub Actions](https://code.claude.com/docs/en/github-actions) and [`openai/codex-action`](https://github.com/openai/codex-action) each document theirs.
- **Its cost:** runner minutes at your CI provider's price, as any job; a job that runs an agent adds model usage on top. Count both in the budget.

## A machine of your own: systemd timers or cron

For jobs that need the machine's files, such as the CI-records collector or the temp and Rust sweeps, use a systemd user timer or a crontab entry that runs a plain script, or the agent's headless command when the job needs judgement.

- **The intended user and config home:** a timer runs with a minimal environment. Run it as the user who owns the job, and set `HOME`, `PATH` and the model CLI's config folder to what that user's sessions use, or it runs signed out.
- **Survive logout:** `loginctl enable-linger` for systemd user timers. `Persistent=true` reruns a missed timer once the machine is back.
- **Examples:** [`scripts/records/`](../scripts/records/README.md) and [`scripts/local/`](../scripts/local/README.md) ship `.service` and `.timer` files, and [`scripts/local/README.md`](../scripts/local/README.md#what-the-machine-needs) lists what the machine needs. Install them only once the plan approves them.

## Which to use

| Job | Best fit |
| --- | --- |
| Engineers working briefs in parallel | Subagents or child tasks in worktrees; `codex exec` per worktree |
| Watching one run or PR for an hour | `/loop` or your harness's PR watcher |
| The slow-tests campaign, the docs drift sweep | A cloud agent job with its own scoped identity, or GitHub Actions cron running the agent headless |
| The CI-records collector, temp and Rust sweeps, the spend watcher | A script on a systemd timer or service on the machine |
| A follow-up check at a main-only job's first run | A manual, read-only check by a named person or agent at a set time; a one-off scheduled task if the user approves one |
