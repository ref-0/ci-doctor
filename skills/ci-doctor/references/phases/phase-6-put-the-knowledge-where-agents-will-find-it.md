[Start: ci-doctor](../../SKILL.md) · Previous: [Phase 5](phase-5-make-it-stay-fast.md)

# Phase 6: put the knowledge where agents will find it

Fit this into the user's existing layout rather than imposing ours. If they have `AGENTS.md`, `CLAUDE.md`, Cursor rules or a skills folder, use it, and put the snippet in the file the active harness actually loads.

- **Keep the top-level agent file short:** a map, the commands, a machine policy, and the rule *"when docs and code disagree, the code is right; fix the doc in the same change."*
- **Adapt the commands whole,** arguments included, not just their names. An install command is the stack's complete frozen or reproducible install. Where the machine is shared, say which checks run locally before pushing and which are left to CI, and verify the CI ones in the ready run.
- **Adopt only the skills the user approved.** The plugin installs every skill; the user installs it, as [the README's Installing](../../../../README.md#installing) says for each harness. Record which skills the repo adopts in its facts files, and leave out what doesn't fit, such as `blacksmith` off Blacksmith. Then check the repo's facts with [`scripts/docs/check-links.ts`](../../../../scripts/docs/check-links.ts) run on `.agents/repo`.
- **CI skills or docs** for how CI works here, split as [`skills/README.md`](../../../README.md) maps them: workflows, selection, tiers and caches ([`ci-workflows`](../ci-workflows/TOPIC.md)); runner size and cost ([`ci-runners`](../ci-runners/TOPIC.md)); the provider's own specifics, if any, such as [`blacksmith`](../blacksmith/TOPIC.md); and the merge path ([`ci-merge-workflow`](../../../ci-merge-workflow/SKILL.md)). Each description names its siblings, and no two claim one trigger.
- **Review:** keep the repo's existing review process. A gate-checked review procedure from [`code-review`](../../../code-review/SKILL.md), with the repo's policy in `.agents/repo/review.md`, is a separate change: it needs its validator and the policy change approved. Where the repo has bounded models or property tests, a [`proof-tiers`](../../../proof-tiers/SKILL.md) facts file too.
- **One slow-tests skill** with references by topic:
  - `fixes.md`: the kinds of wait and the fix for each;
  - `measuring.md`: where CI's records are, how to read them, and the test-specific rules for comparing before and after;
  - `flakes.md`: finding a flake's cause;
  - `fakes.md`: what to fake and what to keep real;
  - `campaign.md`: running many fixes at once.

  Start each from guide sections 10–11 and keep only what fits this repo.
- **An evidence check** from [`verify-evidence`](../verify-evidence/TOPIC.md), which owns how to judge a number, linked from the measuring and test-value docs.
- **Stack-specific pages** only for the stacks the repo has, linked from the general text with "if your stack uses X".
- **Repo-specific values** (commands, settings names, thresholds) go in one facts file the skills point to, so the method and the values can change separately.
- **A "what was tried" register:** every measured-and-dropped idea, with its numbers, its evidence and its date, in one place `.agents/repo/ci.md`'s Tried and dropped section names ([template](../checks/ci-read-what-was-tried.md)).
- **Every lesson carries a date and a PR or issue,** so a later agent can check it's still true.
- **Freshness:** propose a recurring docs drift review (guide section 17) and, if their CI allows it, a size budget on agent instruction files.
