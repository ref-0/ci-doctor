<!--
What: the rules for CI's caches on any provider: who may write a cache, a warm install keyed by the
manifests, and what not to cache.
Where: read by an agent before changing cache keys, scopes, setup caches or image reuse.
Configure: your repo's own caches go in `.agents/repo/ci.md`'s Caches; the shared actions live in <actions-repo>.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Caches

Part of the [`cache-ci`](../SKILL.md) skill: the rules in full. Read it when changing caches or image reuse. Each of the repo's own caches, its key and who writes it, and what's left uncached on purpose, are in `.agents/repo/ci.md`'s Caches. [guide section 6](https://ci-doctor.ref0.dev/guide/docs/pages/06-reuse-work-by-its-real-inputs.md) covers the remote task cache and setup caches.

If you run on Blacksmith, its sticky disks, its Actions cache and its shared Docker disk are in [`blacksmith`'s disks and caches](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/blacksmith/references/disks.md). If your stack uses Rust, the pass key, the binary key and the toolchain are in `ci-workflows`' [Rust page](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-workflows/references/rust.md).

## Who may write a cache

- **On GitHub Actions, the cache is scoped by branch:** a pull request reads its own caches and its base branch's, never another PR's. So a cache a pull request should read has to be written by a run on `main`, as ci.md says which job writes each. Don't turn the scoping off: one PR's run could then write caches another reads. Other CIs scope differently; find out before you share a key.
- **Only main's own runs write what every run reads,** a push and the scheduled sweep. A pull request or a run by hand of another commit reads and commits nothing. Where the provider can enforce that, turn it on, and record any token a job holds that could still ask for a write.
- **A job that pushes what a deploy runs** doesn't trust anything another job could have written, such as a shared Docker store: it builds on fresh storage and holds each tag to the image it built.
- **Deploy images by digest, and build only what changed.** Name each image by its registry digest in the deploy config, so a deploy builds nothing. Record beside each digest the hash of its inputs, and fail a PR that changes them without a new digest. A separate job builds each image whose inputs changed, twice on fresh storage, checks the two builds match, pushes it under a tag named by its inputs (never pushed again), and checks the registry's digest is the build's before the PR may record it. Have the deploy check each digest exists before it switches, so a missing image leaves the live version up ([guide section 5](https://ci-doctor.ref0.dev/guide/docs/pages/05-tiers-what-runs-where.md#releasing-what-the-sweep-checked)).

## A warm install, keyed by the manifests

The rule holds for any package manager: key a saved install by every file that decides it, and take it only on an exact match. The examples are from a JavaScript workspace (pnpm); for Python, the lockfile, the interpreter version and the manager's config play the same part.

- **Key the install by every manifest:** the lockfile, the workspace's settings, every `package.json` and the runtime's version file, hashed together. A job whose manifests hash to the cached install's takes it and skips the install; any other job installs from the package manager's store, cached as usual.
- **The warm shortcut needs the whole install.** A cache of `node_modules` alone still reran postinstall scripts, whose markers live in the package store, and the install's own check: keep the toolchain, the store's markers and every project's links, keyed by the manifests' hash inside it. Check the repo's prepare lifecycle before skipping the install: generation it does outside `node_modules` must still run.
- **One snapshot, not one for each lockfile.** An install runs to a few GB, and a busy main changes its manifests many times a week. Keep main's newest; a pull request whose manifests differ installs as before. To start over, bump the version in the key.
- **Write the manifests' hash last,** so a copy cut short reads as another install's, and let a job with a failed step write nothing.
- **Some jobs always install.** One job a run installs with the package manager's lockfile and policy checks on, so drift and supply-chain rules are still caught; ci.md's Caches says which. A job that pushes what a deploy runs should install fresh too.
- **Measure both paths** in your CI, before and after: the warm path cut each job's setup to a fraction of the install's in the source repo.

Where to keep the snapshot is the provider's question. On GitHub Actions, `actions/cache` keyed by the manifests' hash works on any runner, at the price of a restore each job; the [templates' README](https://github.com/ref-0/ci-doctor/blob/v0.4.0/templates/github/README.md#without-blacksmith) shows it beside each disk action. Time the restore and the install apart before adding a full-install snapshot at all. If you run on Blacksmith, a persistent disk mounted into each job skips the restore ([its disks](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/blacksmith/references/disks.md)); measure both on your workload.

## A toolchain cache

Cache a pinned toolchain by its pin file and the action that installs it. **Take the cached copy only once a probe runs with it within a minute,** such as a compile of a tiny program, and otherwise install fresh with a warning: once a cached disk mounted but none of its files' data read, and every job that used it hung until its timeout.

## Not worth caching

Measure before adding a layer. Sub-second generation, a large tarball restore that costs as much as it saves, and an extra layer whose total daily saving is trivial next to its upkeep were each dropped in the source repo ([guide section 6](https://ci-doctor.ref0.dev/guide/docs/pages/06-reuse-work-by-its-real-inputs.md#not-worth-caching)).
