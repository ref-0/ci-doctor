---
name: blacksmith
description: "Handles Blacksmith runners for GitHub Actions: labels, sticky disks, CLI, bill and a move there. Use when an ask names Blacksmith, its labels, sticky disks, CLI or bill, or a move to it. Not for other workflow, runner, cache or failed-check work in a Blacksmith repo (ci-workflows, ci-runners, cache-ci, ci-doctor)."
metadata:
  version: "0.1.0"
---

<!--
What: what's specific to Blacksmith: its CLI, labels, sticky disks, cache, billing, the move to it, and its billing adapter.
Where: read by a coding agent working on a repo whose GitHub Actions run on Blacksmith, or moving there.
Configure: your org (<org>), labels and disks in `.agents/repo/ci.md`; the shared actions in <actions-repo>.
Reference implementation from a production monorepo; adapt to your repo.
-->

# blacksmith

[Blacksmith](https://blacksmith.sh) runs GitHub Actions jobs on its own runners: a job moves by changing its `runs-on` label. On GitHub Actions with GitHub-hosted or self-hosted runners we recommend it, backed by the repo's baseline and with the optimization period priced, never as a requirement: the user decides, and off GitHub Actions it doesn't apply. [`ci-runners`' providers](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-runners/references/providers.md#choosing) says how a plan makes the case. This skill holds only what's specific to Blacksmith. The general rules are in [`ci-workflows`](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-workflows/SKILL.md) (workflows, tiers, caches) and [`ci-runners`](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-runners/SKILL.md) (sizing, packing, queues, cost). [Guide section 2](https://ci-doctor.ref0.dev/guide/docs/pages/02-runners-blacksmith-and-the-cost-of-getting-fast.md#setting-up-blacksmith) has the setup in order. [The checks](references/checks.md) it follows are here in short.

## Start here

- **The repo runs on Blacksmith and has `.agents/repo/ci.md`:** read its Runners, budgets and records, its Caches and its Spend watcher, then pick from "What to read". [Start here](references/setup.md#with-the-repos-facts-file) says what they hold.
- **No facts file:** ask once whether the repo keeps these facts elsewhere, and otherwise read the labels, disk actions and spend limit yourself, as [start here](references/setup.md#with-no-facts-file) says.
- **The repo isn't on Blacksmith yet:** a move needs the user's yes first, as a plan item with a monthly projection. Until then, use [`ci-runners`](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-runners/SKILL.md), and read [migrate](references/migrate.md) only once they agree.

## What to read

- **The CLI:** install, sign-in, spend by job, a job's CPU, comparing runners, logs, disks, cache entries, testbox and org tokens: [CLI](references/cli.md).
- **Labels, sticky disks, the Actions cache and the Docker disk:** [disks and caches](references/disks.md). Read it before changing a disk action, its key or who commits it.
- **How it bills,** a sticky disk's cost and the free allowance: [billing](references/billing.md).
- **Moving a repo from GitHub-hosted or self-hosted runners,** once the user said yes: [migrate](references/migrate.md).

## Rules

- **A person signs in.** `blacksmith auth login` opens a browser; ask the user to run it, and check with `blacksmith auth status`. Never read or print `~/.blacksmith/credentials`, and never put a token on a command line.
- **Never re-enable a workflow the team's spend watcher disabled,** and keep Blacksmith's own spend limit above the watcher's cap, so the watcher can act first; neither stops spend exactly at its cap ([billing](references/billing.md)).
- **Only main's runs commit a sticky disk.** Turn on Blacksmith's branch protection for sticky disks.
- **Run macOS only in a release, or by hand with a person's yes:** a Mac minute costs several Linux ones.
- **Check current pricing and labels** in [Blacksmith's docs](https://docs.blacksmith.sh) before quoting either; they change.

## The billing adapter

`ci-time.ts --bill blacksmith`, in [`ci-workflows`](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-workflows/SKILL.md#measuring-a-run), takes each job's billed vCPU-minutes and each shard's CPU from Blacksmith through this skill's [`scripts/blacksmith-bill.ts`](scripts/blacksmith-bill.ts). It finds the adapter when this skill is installed beside `ci-workflows`, as a plugin install has it. The bill counts every attempt, while ci-time.ts's minutes count the latest. Its tests: `node --test blacksmith-bill.test.ts`, from `scripts/`, on Node 24 with nothing installed.

A skills-only install of this folder carries the adapter but not `ci-time.ts`: clone ci-doctor once, outside the user's repo, on `next` until the release that adds this skill, then at the release this skill names in `metadata.version`, and point it at this folder:

```sh
git clone --depth 1 --branch next https://github.com/ref-0/ci-doctor.git <ci-doctor>
node <ci-doctor>/skills/ci-workflows/scripts/ci-time.ts --bill blacksmith --adapter-dir <skills-dir>/blacksmith/scripts
```

## Why we recommend it

These are what the source repo leaned on, as [guide section 2](https://ci-doctor.ref0.dev/guide/docs/pages/02-runners-blacksmith-and-the-cost-of-getting-fast.md#why-we-recommend-blacksmith) says. Measure each on your workload before counting on it:

- **A size per job,** billed per vCPU-minute, so the plan, static checks and test shards each get the size their work needs, and a small selection runs on 2 vCPU.
- **Jobs that start in seconds,** where GitHub-hosted runners had kept jobs queued for minutes at busy times ([`ci-runners`' queues](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-runners/references/queues.md)).
- **Native arm64 and macOS,** so a Rust service builds on both Linux architectures with no emulation.
- **Sticky disks,** so a job whose manifests match main's skips the install.
- **An Actions cache beside the runners,** whose reservations also served as atomic claims for work stealing and as transport for small cross-job records.
- **A CLI** that prices jobs, reads each job's CPU and compares runner choices.

## Not here

- Runner size, packing, queues, the spend cap and choosing a provider on any runner: [`ci-runners`](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-runners/SKILL.md).
- Changing a workflow, its tiers or its caches: [`ci-workflows`](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-workflows/SKILL.md).
- A PR's result, runs by hand and the merge: [`ci-merge-workflow`](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-merge-workflow/SKILL.md). A whole CI plan, or a failed check: the [`ci-doctor`](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-doctor/SKILL.md) hub.
- Whether a cost or a speed-up holds up: [`prove-it`](https://github.com/ref-0/ci-doctor/blob/next/skills/prove-it/SKILL.md).

## Outside this skill

Every link that leaves this folder is a full link, so it reads the same with this skill installed alone: the guide at [ci-doctor.ref0.dev/guide/](https://ci-doctor.ref0.dev/guide/), and the hub, the other skills and the tools in [the ci-doctor repo](https://github.com/ref-0/ci-doctor) on `next`, the branch the skills track. To read them at a release instead, open the repo at the tag `v<version>`.
