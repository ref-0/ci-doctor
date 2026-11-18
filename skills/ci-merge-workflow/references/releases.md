<!--
What: what only a release's owners may do, how to try an unpublished change, and the released-versions check before marking ready.
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
