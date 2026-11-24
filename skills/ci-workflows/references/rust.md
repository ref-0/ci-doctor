<!--
What: reusing Rust's work in CI and locally: a pass key apart from a binary key, rust-cache, a cached
toolchain, and local sccache.
Where: read by an agent changing a Rust job's caches, keys or toolchain setup. Skip it for a repo with no Rust.
Configure: your crate's folder, version files and toolchain pin, in `.agents/repo/ci.md`'s Caches.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Rust

Part of the [`ci-workflows`](../SKILL.md) skill, if your stack uses Rust. The general rules are in [`cache-ci`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/cache-ci/SKILL.md)'s [caches](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/cache-ci/references/caches.md); [guide section 6](https://ci-doctor.ref0.dev/guide/docs/pages/06-reuse-work-by-its-real-inputs.md#rust-reuse-passes-and-binaries-separately) has the design and what it measured.

## Two keys: a pass and a binary

- **A pass key** covers everything the checks read: sources, tests, fixtures, the lockfile, the toolchain pin, Cargo config found above the crate, shared contract vectors, the build workflow and its pinned action, and the CI job blocks that run them. It leaves out version-only churn, which changes no check.
- **A binary key** adds the release version, since a binary embeds it.
- **Trust main, not branch caches.** A pull request skips Rust's tests, rustfmt and Clippy only when `main` passed the exact pass key recently (30 hours in the source repo, so a daily run can arrive late). Only verified main runs write passes.
- **A merge promotes its PR's proven pass,** after checking the merge commit the PR tested has the final head as its second parent and both keys recompute the same.
- **A pass isn't a binary cache.** When a pass key skips the checks, resolve the binaries separately and move them to the job that packs them explicitly: a wait between jobs doesn't copy files.
- **Versions pair.** Before reusing a binary of unchanged source, find each binary's embedded version and any rule that components must match versions. An older binary of identical source broke such a pairing in the source repo.
- **Test that the key holds every file a component reads** outside its folder. [`scripts/reuse/`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/scripts/reuse/README.md) has both keys (`pass-key.ts`), the promotion (`merge-pass.ts`) and that test (`outside-reads.ts`).

## Build caches

- **`Swatinem/rust-cache`** caches `target/` and Cargo's registry by the lockfile and toolchain, on the Actions cache, and works unchanged on Blacksmith. Save it only from `main`.
- **sccache in CI** saved nothing on changed crates in the source repo; measure before adding it.
- **Locally, sccache is worth it,** shared by every worktree on a machine. Setup and validation are in [`scripts/local/README.md`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/scripts/local/README.md), section 5, with a best-effort sweep of old `target/` folders.

## The toolchain

Cache the toolchain that `rust-toolchain.toml` pins, with its components and targets, keyed by that file and the installing action. Probe it before use, as [`cache-ci`'s caches](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/cache-ci/references/caches.md#a-toolchain-cache) say. If you run on Blacksmith, a sticky disk holds it ([disks](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/blacksmith/references/disks.md#the-rust-toolchains-disk)); elsewhere, cache `~/.rustup` with `actions/cache`, as the [templates' README](https://github.com/ref-0/ci-doctor/blob/v0.3.0/templates/github/README.md#without-blacksmith) shows.

## Running Rust's tests

Compile every test binary first, then run independent test binaries at once. Use tmpfs for scratch, and turn off core dumps for deliberate aborts. Run the suite against the profile you ship, and name any check a second profile gave that you drop, such as debug-only overflow checks, as a tradeoff ([guide section 7](https://ci-doctor.ref0.dev/guide/docs/pages/07-shards-runners-and-billing.md#shorten-the-critical-path-before-buying-cores)).
