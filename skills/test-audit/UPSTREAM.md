<!--
What: where this skill came from, its licence and what was changed.
Where: read by whoever updates the skill from upstream.
Configure: nothing.
Reference implementation from a production monorepo; adapt to your repo.
-->

# test-audit provenance

- Source: <https://github.com/openclaw/openclaw/tree/80930af448ebabc84174146b56bc106d37fab3b4/.agents/skills/test-audit>, at the commit below; its moving `main` is where upstream sync diffs from.
- Source commit: `80930af448ebabc84174146b56bc106d37fab3b4` (23 Sept 2026)
- Licence: MIT, in [`LICENSE`](LICENSE), as upstream ships it. Keep it with the skill. Its last lines point at openclaw's `THIRD_PARTY_NOTICES.md`, which at that commit covers code openclaw adapted from Pi (pi-mono) and GitHub's Octicons. This skill holds none of that code, so the notices file isn't shipped here.

## Changes from the source

`SKILL.md` keeps openclaw's value bar and retention bar word for word, and its authoring gate and junk patterns with these local additions:

- **Authoring gate:** three paragraphs, the `undefined` check, the conditional pointer to property tests in [`proof-tiers`](../proof-tiers/SKILL.md), and the producer-faithful fixture rule with its [reference](references/fixtures.md).
- **Junk patterns:** two entries, constant pins and mock-only assertions.
- **Description:** rewritten to route between this skill, `speed-up-tests`, `proof-tiers` and `review-gate`.

Three sections point at openclaw's own tooling, so they are rewritten for any repo:

- **Discovery:** the lanes are the kinds of code the repo's `AGENTS.md` map names, instead of openclaw's `src/` and `extensions/`.
- **Validation:** named test files, the repo's checks from its `AGENTS.md` commands block and the PR's CI run, instead of openclaw's test runner scripts and its own skills.
- **Landing and continuation:** the repo's PR template and [`ci-merge-workflow`](../ci-merge-workflow/SKILL.md), instead of openclaw's `scripts/pr` flow.

The tests-reviewer pointers go to [`review-gate`](../review-gate/SKILL.md), and Validation points at [`prove-it`](../prove-it/SKILL.md) for evidence quality. `CAMPAIGN.md` keeps examples from openclaw's Telegram plugin campaign, marked as upstream history, and adds a baseline fallback and a single-agent route. `references/audit-workflow.md` holds openclaw's Discovery, Candidate evidence, Edit shape, Landing and Handoff, moved out of `SKILL.md`. `references/fixtures.md` is not from openclaw: its example comes from the production monorepo this kit was ported from.

## Updating

This copy is edited, so a skills package manager must not overwrite it: keep it out of `skills-lock.json`. To update, diff the upstream folder against the source commit above and carry over changes outside the rewritten sections, then move the commit. The playbook's `tools/upstream-sync/` has a weekly workflow that files that diff as an issue when upstream moves.
