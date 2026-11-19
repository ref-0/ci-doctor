<!--
What: an opt-in check that the skills you copied from upstream changed there, filed as one issue, plus the helper that reapplies your edits.
Where: the workflow runs on GitHub Actions weekly; the helper runs there and locally.
Configure: adaptations.json (from adaptations.example.json), the workflow's placeholders.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Upstream sync

Opt-in. Skills copied from upstream go stale; this tells you when, and never updates them for you. It isn't a skill, so it lives in `tools/`: nothing here is loaded by a harness. [guide section 17](../../docs/pages/17-keeping-agent-knowledge-from-going-stale.md) says why skills are pinned.

| File | What it does |
| --- | --- |
| [`upstream-skills.yml`](upstream-skills.yml) | Weekly, in the runner's throwaway checkout: the skills CLI's update for the locked skills, your edits reapplied, a diff of only the locked folders and the lock, and for each hand-edited copy a diff of upstream since its baseline. Anything changed: one issue, or a comment on the one still open. It pushes nothing and merges nothing. |
| [`skills-edits.ts`](skills-edits.ts) | Reapplies your edits after an install or update: renamed siblings' names, rows for skills you leave out, and your own descriptions from `HEAD`. Running it twice changes nothing. `--edited` lists the hand-edited copies. |
| [`skills-edits.test.ts`](skills-edits.test.ts) | Each edit, and that a second run changes nothing. `node --test skills-edits.test.ts` |
| [`adaptations.example.json`](adaptations.example.json) | The manifest of your edits. Copy it to `adaptations.json`. |

## Set it up

Set it up only once the user approves the plan, as a new scheduled job ([PROMPT, "Before approval"](../../skills/ci-doctor/SKILL.md#before-approval-read-only)).

1. Copy this folder where your repo keeps scripts, as `<path-to>/upstream-sync/` with `<path-to>` relative to the repo root (for example `tools`), and `adaptations.example.json` to `adaptations.json` beside it. List the locked skills whose description you wrote (`ours`), the upstream skills you skip (`leftOut`), and each hand-edited copy with its upstream repo, path and the commit you copied it from (`edited`).
2. Install locked skills with the skills CLI (`npx skills add …`), which writes `skills-lock.json`. Keep edited copies, such as [`test-audit`](../../skills/test-audit/UPSTREAM.md), out of the lock, so an update can't overwrite them.
3. Copy `upstream-skills.yml` to `.github/workflows/`. Fill `SKILLS_SCRIPTS` (`<path-to>/upstream-sync`, relative to the root), the runner label and the pinned versions. Create a `skills` label. It needs `issues: write` and reads public upstream repos with the job's own token; add nothing else.
4. Run it once by hand, on a branch with a `skills-lock.json`, so the first check exercises the lockfile path: `gh workflow run upstream-skills.yml --repo <org>/<repo> --ref main`, then read its summary.

## When it files an issue

A person, or an agent they ask, applies it locally, from the repo root:

1. `npx -y skills@<pinned-version> update --project --yes`, then `node <path-to>/upstream-sync/skills-edits.ts`, then `git diff`.
2. For an edited copy, diff upstream since its baseline and carry over what's outside your documented adaptations (for test-audit, those in its `UPSTREAM.md`). Then move `baseline` to the commit you read.
3. Run the docs budget, `node scripts/docs/docs-budget.ts`: an upstream description can grow past 320 characters.
4. Open a normal PR. Never merge an update automatically.

## Placeholders

| Placeholder | Meaning |
| --- | --- |
| `<org>/<repo>` | Your repository. |
| `<path-to>` | The folder holding `upstream-sync/`, relative to the repo root, e.g. `tools`. |
| `<small-runner-label>` | The smallest runner, such as Blacksmith's 2 vCPU. |
| `<pinned-version>`, `<pinned-sha>` | The skills CLI's version, and setup-node's full commit. |
| `<vendor>-workers`, `<skill-you-skip>` | Example entries in the manifest. |
