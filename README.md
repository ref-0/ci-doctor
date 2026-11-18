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

## Contents

| Path | What |
|---|---|
| [`PROMPT.md`](PROMPT.md) | Instructions for your agent |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed in each release, and what to do about it |
| [`docs/`](docs/) | The guide, the agent's phase-by-phase prompts, and harness notes |
| [`skills/`](skills/README.md) | Agent skills for CI, slow tests, review and merging |
| [`checks/`](checks/README.md) | One-rule checks the skills link to |
| [`scripts/`](scripts/README.md) | Timing, shards, budgets, flakes, sweeps and local test slots |
| [`tools/`](tools/) | Workspace tools and upstream skill sync |
| [`templates/`](templates/) | CI workflows, the selection planner and agent-knowledge templates |
| [`cache/remote/`](cache/remote/README.md) | Vite+ remote cache on Cloudflare |

Everything is a reference implementation with `<placeholders>`. Adapt it; don't copy it unchanged.

## Updating

Releases are tags. Read [`CHANGELOG.md`](CHANGELOG.md) from your tag to the newest, do its **Action** lines, then move your pin.

## License

[MIT](LICENSE)
