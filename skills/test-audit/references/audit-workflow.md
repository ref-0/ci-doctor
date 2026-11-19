<!--
What: how to find weak tests, the evidence a deletion needs, the edit's shape and the handoff.
Where: read by an agent sweeping existing tests.
Configure: the kinds of code your repo has (its AGENTS.md map).
Reference implementation from a production monorepo; adapt to your repo. Adapted from openclaw (MIT); see ../UPSTREAM.md.
-->

# Auditing existing tests

Part of the [`test-audit`](../SKILL.md) skill: finding candidates, the evidence a deletion needs, the edit's shape and the handoff. Read it when sweeping existing tests.

## Discovery

Keep discovery read-only and report evidence before editing. For broad scope,
run parallel discovery lanes when available:

- one lane for each top-level kind of code the repo map in `AGENTS.md`
  names, such as its packages, its apps and its tooling;
- a cross-cutting pattern sweep.

Outside campaign mode, prefer a few high-confidence candidates over a large
speculative inventory. Hunt for the [junk patterns](../SKILL.md#junk-patterns).

## Candidate evidence

Record every field below before editing. A missing field means the candidate is
not ready for deletion:

- exact test name and location;
- what failure it can actually detect;
- non-test callers of the covered production or support seam;
- stronger remaining owner-boundary proof, or why no proof is needed;
- relevant history and the reason the test or seam exists;
- production or test-support deletion unlocked;
- risk and the focused validation command.

## Edit shape

Choose one coherent owner-boundary batch. Delete obsolete test-only exports,
globals, wrappers, and dead production paths instead of preserving aliases.
Move retained regressions to their canonical owners. Consolidate repeated
package or dependency assertions into one generic contract.

Prefer net-negative production LOC. Do not add replacement tests that restate
the same implementation, and do not convert uncertain candidates into cleanup
to increase deletion counts.

## Landing and continuation

Commit, push, or open a PR only when authorized, using the repository's PR
template, and merge it as [`ci-merge-workflow`](../../ci-merge-workflow/SKILL.md) says where the repo adopted it, or by the repo's own merge path. Keep one coherent PR at a time; after it merges,
refresh from current `main` and rerun read-only discovery for the next
high-confidence batch.

## Handoff

Report:

- root cause and removed low-value categories;
- production owner simplifications;
- retained false positives and why they remain valuable;
- focused and full proof actually run;
- production versus test LOC;
- PR and merge state;
- named follow-ups.
