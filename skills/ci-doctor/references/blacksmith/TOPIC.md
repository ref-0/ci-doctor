<!--
What: what's specific to Blacksmith: its CLI, labels, sticky disks, cache, billing, and the move to it.
Where: read by a coding agent working on a repo whose GitHub Actions run on Blacksmith, or moving there.
Configure: your org (<org>), labels and disks in `.agents/repo/ci.md`; the shared actions in <actions-repo>.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Blacksmith

[Blacksmith](https://blacksmith.sh) runs GitHub Actions jobs on its own runners: a job moves by changing its `runs-on` label. On GitHub Actions with GitHub-hosted or self-hosted runners we recommend it, backed by the repo's baseline and with the optimization period priced, never as a requirement: the user decides, and off GitHub Actions it doesn't apply. [`ci-runners`' providers](../ci-runners/references/providers.md#choosing) says how the plan makes the case. This skill holds only what's specific to Blacksmith. The general rules are in [`ci-workflows`](../../../ci-workflows/SKILL.md) (workflows, selection, tiers, caches) and [`ci-runners`](../ci-runners/TOPIC.md) (sizing, packing, cost). [guide section 2](../../../../docs/pages/02-runners-blacksmith-and-the-cost-of-getting-fast.md#setting-up-blacksmith) has the setup in order.

## What to read

- **The CLI:** install, sign-in, spend by job, a job's CPU, comparing runners, logs, disks, cache entries, testbox and org tokens: [CLI](references/cli.md).
- **Labels, sticky disks, the Actions cache and the Docker disk:** [disks and caches](references/disks.md). Read it before changing a disk action, its key or who commits it.
- **How it bills,** a sticky disk's cost and the free allowance: [billing](references/billing.md).
- **Moving a repo from GitHub-hosted or self-hosted runners,** once the user said yes: [migrate](references/migrate.md).

## Rules

- **A person signs in.** `blacksmith auth login` opens a browser; ask the user to run it, and check with `blacksmith auth status`. Never read or print `~/.blacksmith/credentials`, and never put a token on a command line.
- **Never re-enable a workflow the team's spend watcher disabled,** and keep Blacksmith's own spend limit above the watcher's cap, so the watcher stops CI first.
- **Only main's runs commit a sticky disk.** Turn on Blacksmith's branch protection for sticky disks.
- **Run macOS only in a release, or by hand with a person's yes:** a Mac minute costs several Linux ones.
- **Check current pricing and labels** in [Blacksmith's docs](https://docs.blacksmith.sh) before quoting either; they change.

`ci-time.ts --bill blacksmith`, in [`ci-workflows`](../../../ci-workflows/SKILL.md#measuring-a-run), takes each job's billed vCPU-minutes and each shard's CPU from Blacksmith through [`scripts/blacksmith-bill.ts`](scripts/blacksmith-bill.ts). The bill counts every attempt, while ci-time.ts's minutes count the latest. Its tests: `node --test blacksmith-bill.test.ts`, from `scripts/`.

## Why we recommend it

These are what the source repo leaned on, as [guide section 2](../../../../docs/pages/02-runners-blacksmith-and-the-cost-of-getting-fast.md#why-we-recommend-blacksmith) says. Measure each on your workload before counting on it:

- **A size per job,** billed per vCPU-minute, so the plan, static checks and test shards each get the size their work needs, and a small selection runs on 2 vCPU.
- **Native arm64 and macOS,** so a Rust service builds on both Linux architectures with no emulation.
- **Sticky disks,** so a job whose manifests match main's skips the install.
- **An Actions cache beside the runners,** whose reservations also served as atomic claims for work stealing and as transport for small cross-job records.
- **A CLI** that prices jobs, reads each job's CPU and compares runner choices.

## Related

- [`ci-runners`](../ci-runners/TOPIC.md): sizing, packing, the cap and choosing a provider.
- [`ci-workflows`](../../../ci-workflows/SKILL.md): changing workflows and tiers; [`cache-ci`](../../../cache-ci/SKILL.md): caches.
- [`ci-merge-workflow`](../../../ci-merge-workflow/SKILL.md): a PR's result, runs by hand and the merge.
