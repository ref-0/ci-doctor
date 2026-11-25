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

`SKILL.md` and its references keep openclaw's value bar and retention bar word for word, and its authoring gate and junk patterns with these local additions, laid out as [Layout](#layout) says:

- **Authoring gate:** three paragraphs, the `undefined` check, the conditional pointer to property tests in [`proof-tiers`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/proof-tiers/SKILL.md) (now in [`references/property-tests.md`](references/property-tests.md)), and the producer-faithful fixture rule with its [reference](references/fixtures.md).
- **Junk patterns:** two entries, constant pins and mock-only assertions.
- **Description:** rewritten in the shape `skills/README.md` gives, routing slow, flaky and property tests to `speed-up-tests`, `fix-flaky-test` and `proof-tiers`.

Every link to the rest of ci-doctor is a full link to its repo at the skill's release tag or to its guide site, so the skill reads the same installed alone.

Three sections point at openclaw's own tooling, so they are rewritten for any repo:

- **Discovery:** the lanes are the kinds of code the repo's `AGENTS.md` map names, instead of openclaw's `src/` and `extensions/`.
- **Validation:** named test files, the repo's checks from its `AGENTS.md` commands block and the PR's CI run, instead of openclaw's test runner scripts and its own skills.
- **Landing and continuation:** the repo's PR template and [`ci-merge-workflow`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-merge-workflow/SKILL.md), instead of openclaw's `scripts/pr` flow.

The tests-reviewer pointers go to [`review-gate`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/review-gate/SKILL.md), and Validation points at [`prove-it`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/prove-it/SKILL.md) for evidence quality. `CAMPAIGN.md` keeps examples from openclaw's Telegram plugin campaign, marked as upstream history, and adds a baseline fallback and a single-agent route. `references/audit-workflow.md` holds openclaw's Discovery, Candidate evidence, Edit shape, Landing and Handoff, moved out of `SKILL.md`. `references/fixtures.md` is not from openclaw: its example comes from the production monorepo this kit was ported from.

## Layout

To keep `SKILL.md` under the docs budget's 5 KB, these sections moved out of it word for word, each leaving one pointer line. An upstream change to one of them goes in the file named here, not in `SKILL.md`:

- **Junk patterns:** the whole section, its intro and list, to [`references/junk-patterns.md`](references/junk-patterns.md) under `## Junk patterns`. Its heading left `SKILL.md`; the authoring gate's link to it points there.
- **Retention bar:** the whole section to [`references/junk-patterns.md`](references/junk-patterns.md) under `## Retention bar`. Its heading left `SKILL.md`; the authoring gate's link and a pointer line under Value bar point there.
- **Value bar:** its second paragraph, "Before judging a candidate, …", to the top of `## Candidate evidence` in [`references/audit-workflow.md`](references/audit-workflow.md). The first paragraph stays.
- **Validation:** its numbered steps 1 to 5 to [`references/validation.md`](references/validation.md). The opening paragraph stays.
- **Authoring gate:** the local property-tests paragraph, "A test of a parser, a wire format, …", to [`references/property-tests.md`](references/property-tests.md). openclaw's paragraphs stay.

## Updating

This copy is edited, so a skills package manager must not overwrite it: keep it out of `skills-lock.json`. To update, diff the upstream folder against the source commit above and carry over changes outside the rewritten sections, into the file [Layout](#layout) names for a moved section, then move the commit. The playbook's `tools/upstream-sync/` has a weekly workflow that files that diff as an issue when upstream moves.
