---
name: blacksmith
description: "Runs GitHub Actions on Blacksmith: its runner labels, sticky disks, cache, CLI, bill and the move there. Use when a repo's CI runs on Blacksmith or is moving there, or an ask names its labels, sticky disks or bill. Not for runner sizing and spend on any provider (ci-runners); workflow edits (ci-workflows)."
metadata:
  version: "0.4.0"
---

<!--
What: what's specific to Blacksmith: its CLI, labels, sticky disks, cache, billing, the move to it, and its billing adapter.
Where: read by a coding agent working on a repo whose GitHub Actions run on Blacksmith, or moving there.
Configure: your org (<org>), labels and disks in `.agents/repo/ci.md`; the shared actions in <actions-repo>.
Reference implementation from a production monorepo; adapt to your repo.
-->

# blacksmith

[Blacksmith](https://blacksmith.sh) runs GitHub Actions jobs on its own runners: a job moves by changing its `runs-on` label. This skill holds only what's specific to Blacksmith. [Guide section 2](https://ci-doctor.ref0.dev/guide/docs/pages/02-runners-blacksmith-and-the-cost-of-getting-fast.md#setting-up-blacksmith) has the setup in order. [The checks](references/checks.md) it follows are here in short.

## Start here

- **The repo runs on Blacksmith and has `.agents/repo/ci.md`:** read its Runners, budgets and records, its Caches and its Spend watcher, then pick from "What to read". [Start here](references/setup.md#with-the-repos-facts-file) says what they hold.
- **No facts file:** ask once whether the repo keeps these facts elsewhere, and otherwise read the labels, disk actions and spend limit yourself, as [start here](references/setup.md#with-no-facts-file) says.
- **The repo isn't on Blacksmith yet:** a move needs the user's yes first, as a plan item with a monthly projection. Until then, use [`ci-runners`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-runners/SKILL.md), and read [migrate](references/migrate.md) only once they agree.

## What to read

- **The CLI:** install, sign-in, spend by job, a job's CPU, comparing runners, logs, disks, cache entries, testbox and org tokens: [CLI](references/cli.md).
- **Labels, sticky disks, the Actions cache and the Docker disk:** [disks and caches](references/disks.md). Read it before changing a disk action, its key or who commits it.
- **How it bills,** a sticky disk's cost and the free allowance: [billing](references/billing.md).
- **Moving a repo from GitHub-hosted or self-hosted runners,** once the user said yes: [migrate](references/migrate.md).
- **`ci-time.ts --bill blacksmith`,** its adapter and running it from a skills-only install: [the billing adapter](references/billing.md#the-billing-adapter).

## Rules

- **A person signs in.** `blacksmith auth login` opens a browser; ask the user to run it, and check with `blacksmith auth status`. Never read or print `~/.blacksmith/credentials`, and never put a token on a command line.
- **Never re-enable a workflow the team's spend watcher disabled,** and keep Blacksmith's own spend limit above the watcher's cap, so the watcher can act first; neither stops spend exactly at its cap ([billing](references/billing.md)).
- **Only main's runs commit a sticky disk.** Turn on Blacksmith's branch protection for sticky disks.
- **Run macOS only in a release, or by hand with a person's yes:** a Mac minute costs several Linux ones.
- **Check current pricing and labels** in [Blacksmith's docs](https://docs.blacksmith.sh) before quoting either; they change.

## Why we recommend it

When the user weighs a move to Blacksmith, or a plan makes the case for it, read [why we recommend it](references/why.md).

## Not here

- Runner size, packing, queues, the spend cap and choosing a provider on any runner: [`ci-runners`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-runners/SKILL.md).
- Changing a workflow or its tiers: [`ci-workflows`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-workflows/SKILL.md). Caches on any runner, their keys and misses: [`cache-ci`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/cache-ci/SKILL.md).
- A PR's result, runs by hand and the merge: [`ci-merge-workflow`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-merge-workflow/SKILL.md). A whole CI plan, or a failed check: the [`ci-doctor`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/SKILL.md) hub.
- Whether a cost or a speed-up holds up: [`prove-it`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/prove-it/SKILL.md).

## Outside this skill

Every link that leaves this folder is a full link, so it reads the same with this skill installed alone: the guide at [ci-doctor.ref0.dev/guide/](https://ci-doctor.ref0.dev/guide/), and the hub, the other skills and the tools in [the ci-doctor repo](https://github.com/ref-0/ci-doctor) at the tag `v<version>`, the release this skill names in `metadata.version`.
