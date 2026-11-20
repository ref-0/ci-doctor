[Start: ci-doctor](../../SKILL.md) · Previous: [Phase 5](phase-5-make-it-stay-fast.md)

# Phase 6: put the knowledge where agents will find it

Follow the [`agent-knowledge`](../../../agent-knowledge/SKILL.md) skill for the layout: fit the user's existing files rather than imposing ours, keep the top-level file a short map with the commands adapted whole, write the repo's facts from [its templates](../../../agent-knowledge/templates/README.md), and keep it fresh. This phase adds what the plan's own findings need:

- **The snippet** from [the template](../../../agent-knowledge/templates/AGENTS-snippet.md), in the file the active harness actually loads. Where the machine is shared, say which checks run locally before pushing and which are left to CI, and verify the CI ones in the ready run.
- **Adopt only the skills the user approved.** The plugin installs every skill; the user installs it, as [the README's Installing](../../../../README.md#installing) says for each harness. Record which skills the repo adopts in its facts files, and leave out what doesn't fit, such as `blacksmith` off Blacksmith. Then check the repo's facts with [`scripts/docs/check-links.ts`](../../../../scripts/docs/check-links.ts) run on `.agents/repo`.
- **CI skills or docs** for how CI works here, split as [`skills/README.md`](../../../README.md) maps them: workflows, selection, tiers and caches ([`ci-workflows`](../ci-workflows/TOPIC.md)); runner size and cost ([`ci-runners`](../ci-runners/TOPIC.md)); the provider's own specifics, if any, such as [`blacksmith`](../blacksmith/TOPIC.md); and the merge path ([`ci-merge-workflow`](../../../ci-merge-workflow/SKILL.md)). Each description names its siblings, and no two claim one trigger.
- **Review:** keep the repo's existing review process. A gate-checked review procedure from [`review-gate`](../../../review-gate/SKILL.md), with the repo's policy in `.agents/repo/review.md`, is a separate change: it needs its validator and the policy change approved. Where the repo has bounded models or property tests, a [`proof-tiers`](../../../proof-tiers/SKILL.md) facts file too.
- **One slow-tests skill** with references by topic:
  - `fixes.md`: the kinds of wait and the fix for each;
  - `measuring.md`: where CI's records are, how to read them, and the test-specific rules for comparing before and after;
  - `flakes.md`: finding a flake's cause;
  - `fakes.md`: what to fake and what to keep real;
  - `campaign.md`: running many fixes at once.

  Start each from guide sections 10–11 and keep only what fits this repo.
- **An evidence check** from [`verify-evidence`](../verify-evidence/TOPIC.md), which owns how to judge a number, linked from the measuring and test-value docs.
- **Stack-specific pages** only for the stacks the repo has.
- **A "what was tried" register** in the one place `.agents/repo/ci.md`'s Tried and dropped section names ([template](../checks/ci-read-what-was-tried.md)), holding what the baseline and the plan measured and dropped.
- **Freshness:** propose the skill's drift sweep and, if their CI allows it, its size budget, each as its own step.
