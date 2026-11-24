<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img alt="ref0 ci-doctor" src="assets/logo-light.svg" />
  </picture>
</h1>

Burning time and money on CI? ci-doctor is a set of skills and tools your agents use to make CI faster and cost less, and keep it that way.

It's what we learned in a 1.5M-line TypeScript and Rust monorepo where AI agents write most of the code, without letting tests prove less: across 189 successful first-attempt runs of ready PRs in one week, CI's wall time had a median of about 3.2 minutes and a p90 of about 4.5 ([how we got here](docs/pages/19-how-we-got-here.md)). It cost us a lot of time and money to learn. It's all here so it doesn't cost you the same.

## AI Quickstart

Copy this into your coding agent, from your repo's root. It installs the skills, by [whichever method](#installation) your agent supports, then starts the plan:

```text
Install the ci-doctor skills using one method. In Claude Code, run `claude plugin marketplace add ref-0/ci-doctor`, then `claude plugin install ci-doctor@ref0`, and start a new session or run `/reload-plugins`. In Codex, run `codex plugin marketplace add ref-0/ci-doctor`, then `codex plugin add ci-doctor@ref0`, and start a new session. In VS Code or Cursor, install `https://github.com/ref-0/ci-doctor` as a plugin from source. For another agent, run `npx skills add https://github.com/ref-0/ci-doctor` and select the agent. Then use the ci-doctor skill to start its plan for this repo.
```

To try it without installing anything, paste this instead:

```text
Clone https://github.com/ref-0/ci-doctor.git into a folder outside this repo, check out its newest release tag, read its skills/ci-doctor/SKILL.md, and follow it for this repo, starting at the beginning.
```

If you scored your repo with `npx @ref0/ci-doctor` or on ci-doctor.ref0.dev, add `Start from this CI report:` and paste the report's `<ci-report>` block after either prompt.

Your agent maps your stack, measures your CI's median and p90, and writes a plan for you to review. Until you approve it, it only reads: no installs, test runs, CI runs, account setup or schedules.

## Skills

| Skill | For |
|---|---|
| [`ci-doctor`](skills/ci-doctor/SKILL.md) | The whole plan: measure CI, write a plan you review, work through it |
| [`ci-runners`](skills/ci-runners/SKILL.md) | A high bill or jobs waiting to start: runner size, spend caps, providers |
| [`blacksmith`](skills/blacksmith/SKILL.md) | Running on Blacksmith, or moving there |
| [`speed-up-tests`](skills/speed-up-tests/SKILL.md) | Slow tests: find what they wait on, without proving less |
| [`cache-ci`](skills/cache-ci/SKILL.md) | Slow installs and caches that never hit |
| [`optimize-graphs`](skills/optimize-graphs/SKILL.md) | An edit that reruns most of the workspace |
| [`fix-flaky-test`](skills/fix-flaky-test/SKILL.md) | Tests that pass only on a retry |
| [`ci-workflows`](skills/ci-workflows/SKILL.md) | Editing workflows without making CI slower or cost more |
| [`test-audit`](skills/test-audit/SKILL.md) | Tests that prove little, and duplicate coverage |
| [`proof-tiers`](skills/proof-tiers/SKILL.md) | Model checks and property tests that stay honest |
| [`prove-it`](skills/prove-it/SKILL.md) | Checking a claim that something got faster, costs less or is fixed |
| [`review-gate`](skills/review-gate/SKILL.md) | Reviewing a PR while it’s a draft |
| [`ci-merge-workflow`](skills/ci-merge-workflow/SKILL.md) | A PR from draft to merged on one CI run |
| [`agent-knowledge`](skills/agent-knowledge/SKILL.md) | Keeping AGENTS.md, CLAUDE.md and skills current |

## Installation

### Claude Code

```sh
claude plugin marketplace add ref-0/ci-doctor
claude plugin install ci-doctor@ref0
```

Start a new session, or run `/reload-plugins` in an open one. Inside Claude Code the same commands are `/plugin marketplace add ref-0/ci-doctor` and `/plugin install ci-doctor@ref0`. The skills are namespaced, such as `/ci-doctor:review-gate`. To update, run `claude plugin marketplace update ref0`, then `claude plugin update ci-doctor@ref0`.

### Codex

```sh
codex plugin marketplace add ref-0/ci-doctor
codex plugin add ci-doctor@ref0
```

Start a new Codex session after installing. To update, run `codex plugin marketplace upgrade ref0`.

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

Select your agent when it asks, and update with `npx skills update`. This copies the skill folders only; the guide and the reference scripts they link to stay in this repo, at the release tag.

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

Paste the [AI Quickstart](#ai-quickstart)'s first prompt: it picks the method for your agent.

## Contents

| Path | What |
|---|---|
| [`PROMPT.md`](PROMPT.md) | Points your agent at the `ci-doctor` skill |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed in each release, and what to do about it |
| [`docs/`](docs/) | The guide and harness notes |
| [`skills/`](skills/README.md) | The plugin’s skills, as [Skills](#skills) lists |
| [`scorer/`](scorer/README.md) | `@ref0/ci-doctor`: scores a repo's CI on your machine through `gh`, and prints how to install the skills |
| [`scripts/`](scripts/README.md) | Timing, budgets, flakes, sweeps and local test slots. Shards are the `ci-runners` skill's |
| [`tools/`](tools/) | Workspace tools and upstream skill sync |
| [`templates/`](templates/) | CI workflows and the selection planner |
| [`cache/remote/`](cache/remote/README.md) | Vite+ remote cache on Cloudflare |

Everything is a reference implementation with `<placeholders>`. Adapt it; don't copy it unchanged.

The measurements behind the score live in [ci-doctor-db](https://github.com/ref-0/ci-doctor-db): how it's calibrated against labelled fast and slow repos, what measuring 219 public repos showed, and the loop that keeps measuring them and turns what it finds into changes here.

## Updating

Releases are tags, and `main` is always the newest release, which is what each harness's plugin install reads. Read [`CHANGELOG.md`](CHANGELOG.md) from your tag to the newest, do its **Action** lines, then move your pin.

## Contributing

Branch from `next` and open pull requests against it. Before pushing, run the checks (Node 24, `git` and `jq`):

```sh
node scripts/check.ts
```

After editing a source an excerpt copies, run `node scripts/skills/excerpts.ts` first. `node scripts/site/build.ts` builds the guide site into `dist/site/`; `scripts/site/README.md` says how it's deployed.

A release is a pull request, `Release: <version>`, from `next` into `main`. Before it, a pull request into `next` bumps every `version` (the checks keep them equal, and Claude Code updates a plugin only when it changes), points the skills' GitHub links at the new tag and adds the CHANGELOG entry. [`release.yml`](.github/workflows/release.yml) checks the release pull request, and once it passes, merging it publishes the scorer to npm and tags the merge.

## License

[MIT](LICENSE)
