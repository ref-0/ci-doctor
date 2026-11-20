<!--
What: Blacksmith's runner labels, sticky disks for the dependencies and the Rust toolchain, its Actions
cache, and its shared Docker disk.
Where: read by an agent before changing a runner label, a disk action, its key or who commits it.
Configure: your repo's own caches go in `.agents/repo/ci.md`'s Caches; the shared actions live in <actions-repo>.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Labels, disks and caches

Part of the [`blacksmith`](../SKILL.md) skill. The provider-neutral rules these follow, a warm install keyed by the manifests, who may write a cache and probing a toolchain, are in [`cache-ci`'s caches](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/cache-ci/references/caches.md). The template actions are [`dependencies` and `rust-toolchain`](https://github.com/ref-0/ci-doctor/blob/v0.2.0/templates/github/README.md#composite-actions), each with an `actions/cache` fallback for other runners.

## Runner labels

`blacksmith-<n>vcpu-ubuntu-<version>` for x64 and the same with `-arm` for arm64, such as `blacksmith-2vcpu-ubuntu-2404` and `blacksmith-8vcpu-ubuntu-2404-arm`, in 2 to 32 vCPU; Windows and macOS have their own labels. Check [Blacksmith's runner list](https://docs.blacksmith.sh/blacksmith-runners/overview) for current sizes and images. The [templates' README](https://github.com/ref-0/ci-doctor/blob/v0.2.0/templates/github/README.md#runner-labels) maps each to GitHub-hosted and self-hosted labels.

## The Actions cache

Blacksmith serves the Actions cache API from storage beside its runners, so `actions/cache` and `Swatinem/rust-cache` work unchanged. It scopes entries by branch, as GitHub does. Its reservations are atomic: the source repo used a unique key's first reservation as a claim for work stealing ([guide section 7](https://ci-doctor.ref0.dev/guide/docs/pages/07-shards-runners-and-billing.md#work-stealing-over-cache-key-claims)).

## The dependencies' disk

It holds main's newest install: `node_modules`, each project's links, and the toolchain (such as Vite+ with its Node and pnpm), on a sticky disk, one for each OS and architecture. A shared `dependencies` action in `<actions-repo>` mounts it. Each workflow step names the action by a full commit, and moving to a newer one is a pull request of its own. A job whose commit's manifests hash to the disk's takes it as overlay lower layers, read only, with a writable upper layer of its own, and skips toolchain setup and the install. Any other job installs from pnpm's store in the Actions cache.

- **Only main's own runs commit it,** a push and the sweep, after an install the disk didn't hold. The step that copies the install onto the disk is what decides: every other path on main detaches the disk, so the post step finds nothing to commit. Don't commit `on-change` instead, which skips a change under 4 KB: a new install can be that small, and then the disk stays a lockfile behind and every job installs again. A pull request or a run by hand of another commit mounts its own clone and commits nothing. Each job mounts its own clone, so jobs never share a live disk: when several commit, the last wins, each a whole install, and a job with a failed step commits nothing.
- **Turn on Blacksmith's branch protection for sticky disks.** Then only main's push, schedule and run-by-hand jobs commit at all, whatever a job asks: a pull request's run asked to commit a disk and Blacksmith refused it, since `pull_request` isn't a trusted trigger. Each job's environment still holds a token that can ask for a commit, so record that threat.
- **One disk, not one for each lockfile.** Blacksmith bills a sticky disk by the GB-month until a week after its last use ([billing](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/blacksmith/references/billing.md)). To start over, bump the version in the action's key.

## The Rust toolchain's disk

It holds main's install of the Rust that `rust-toolchain.toml` pins, with rustfmt, Clippy, the runner's musl target and musl-tools' packages, one disk for each architecture, under a GB each. A shared `rust-toolchain` action, by a full commit, mounts it in the jobs that build and test Rust. A job whose disk's stamp is the hash of `rust-toolchain.toml` and the action's own `action.yml` takes the toolchain as an overlay, read only, in a few seconds, where any other job installs with rustup and apt, several times slower. Only main's own runs commit it, and a release installs fresh, with no disk.

**A job takes the disk's toolchain only once rustc checks a small crate with it within a minute,** and otherwise installs fresh with a warning: once the arm64 disk mounted but none of its files' data read, and every arm64 job hung until its timeout. [Rust](https://github.com/ref-0/ci-doctor/blob/v0.2.0/skills/ci-workflows/references/rust.md) has the rest of Rust's caching.

## The Docker disk

**Blacksmith's Docker disk is shared across the organization,** so anything on it may not be what it says. A job that pushes what a deploy runs never trusts that disk: it moves Docker off it and holds each tag to the image it built, as the repo's image job's comments say.
