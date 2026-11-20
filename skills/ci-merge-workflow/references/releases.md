<!--
What: what only a release's owners may do, how to try an unpublished change, the released-versions check before marking ready, and handing a release's package to its publish job through the Actions cache.
Where: read by an agent near a release PR or workflow, trying an unpublished change, or asking for an early release.
Configure: release owners, reserved operations, snapshot and release commands, in your repo's `.agents/repo/ci.md`'s Merge, releases and deploy.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Releases

Part of the [`ci-merge-workflow`](../SKILL.md) skill. `.agents/repo/ci.md`'s Merge, releases and deploy says how the repo releases: what a release waits for, who owns it and which branch production deploys from.

## Reserved to the release's owners

Only the people ci.md names as release owners do these, though GitHub may not stop you when agents act through a person's login:

- merge a release PR, push to its branch, or add or remove its labels;
- change a package's version;
- start **or rerun** a release workflow, or a job in one;
- move a branch production deploys from.

## A release waits

Where releases publish only what `main`'s sweep passed, a merged change waits for the next passing sweep. Ask the owners for an earlier release only when a merged change breaks what's published, such as a new value in a contract the published client decodes. Say which change and what it breaks.

## Trying an unpublished change

Publish a snapshot of your branch by hand, as ci.md says, and install it. A snapshot lives only on a draft.

## Released versions before ready

Before marking a PR ready:

1. **Release upstream first.** A change that needs another repo's fix waits for that fix's release.
2. **Pin released versions.** Every dependency taken from another of your repos is at a released version in the manifests, the version catalog and the lockfile, never a snapshot URL. Check with the command ci.md names, such as `grep -rnE '<snapshot-host>' <manifests> <lockfile>`.
3. **Then mark ready.** Where the repo's CI rejects snapshot pins before any test job, a pin you missed fails the one run.

## When artifact storage runs out

A release workflow often builds and checks the package in one job, then hands the tarball to a job that holds the registry token and runs none of the repo's code. That handoff is usually an artifact. When the account's artifact storage is full, every upload fails until the quota resets, and the release stops with it: in the source repo, on 17 November 2026, a package's release stopped at the upload this way. As an option, hand the tarball on through the Actions cache instead, keyed by its digest:

- **The checked job** packs, checks the tarball, then prints its file name and SHA-256 as job outputs and saves it with `actions/cache/save` under a key holding the digest, such as `release-tarball-<sha256>`.
- **The publish job** checks nothing out and runs nothing of the repo's. It restores that exact key with `fail-on-cache-miss: true`, no `restore-keys`, and checks the file's SHA-256 against the checked job's output before it publishes the tarball file.

```yaml
  pack:
    outputs: { tarball: '${{ steps.pack.outputs.tarball }}', sum: '${{ steps.pack.outputs.sum }}' }
    steps:
      # ... checkout, build, `npm pack` into $RUNNER_TEMP/pack, check the tarball ...
      - uses: actions/cache/save@v6
        with:
          path: ${{ runner.temp }}/pack/${{ steps.pack.outputs.tarball }}
          key: release-tarball-${{ steps.pack.outputs.sum }}
  publish:
    needs: pack
    steps:
      - uses: actions/cache/restore@v6
        with:
          path: ${{ runner.temp }}/pack/${{ needs.pack.outputs.tarball }}
          key: release-tarball-${{ needs.pack.outputs.sum }}
          fail-on-cache-miss: true
      - run: echo "$SUM  $RUNNER_TEMP/pack/$TARBALL" | sha256sum --check
        env: { SUM: '${{ needs.pack.outputs.sum }}', TARBALL: '${{ needs.pack.outputs.tarball }}' }
      # ... setup the registry, then publish "$RUNNER_TEMP/pack/$TARBALL" ...
```

The digest check, not the key, is what holds the publish to what the checked job built: a run can restore entries other refs saved, such as the default branch's, so a key alone proves nothing. A miss fails the release rather than publishing something else, and an evicted entry needs both jobs run again, which only the release's owners start. Keep artifacts where storage holds: this is for when it doesn't, and the cache's own size limit and eviction still apply.
