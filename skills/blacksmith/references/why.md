<!--
What: why we recommend Blacksmith on GitHub Actions: what the source repo leaned on.
Where: read by an agent when the user weighs a move to Blacksmith, or a plan makes the case for it.
Configure: nothing; measure each point on your workload.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Why we recommend it

Part of the [`blacksmith`](../SKILL.md) skill: what the source repo leaned on. Read it when the user weighs a move to Blacksmith, or a plan makes the case for it.

On GitHub Actions with GitHub-hosted or self-hosted runners we recommend it, backed by the repo's baseline and with the optimization period priced, never as a requirement: the user decides, and off GitHub Actions it doesn't apply. [`ci-runners`' providers](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-runners/references/providers.md#choosing) says how a plan makes the case.

These are what the source repo leaned on, as [guide section 2](https://ci-doctor.ref0.dev/guide/docs/pages/02-runners-blacksmith-and-the-cost-of-getting-fast.md#why-we-recommend-blacksmith) says. Measure each on your workload before counting on it:

- **A size per job,** billed per vCPU-minute, so the plan, static checks and test shards each get the size their work needs, and a small selection runs on 2 vCPU.
- **Jobs that start in seconds,** where GitHub-hosted runners had kept jobs queued for minutes at busy times ([`ci-runners`' queues](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-runners/references/queues.md)).
- **Native arm64 and macOS,** so a Rust service builds on both Linux architectures with no emulation.
- **Sticky disks,** so a job whose manifests match main's skips the install.
- **An Actions cache beside the runners,** whose reservations also served as atomic claims for work stealing and as transport for small cross-job records.
- **A CLI** that prices jobs, reads each job's CPU and compares runner choices.
