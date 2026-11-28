<!--
What: scaling a review to a change's risk tier, with the tiers read from the base branch.
Where: read by an agent choosing how much review a PR gets, in a repo that sorts changes by risk.
Configure: your repo's risk file and what each tier requires, in `.agents/repo/review.md`.
Observed in an open-source repo that gates pull requests in its merge queue; adapt to your repo.
-->

# Review scaled to risk

Part of the [`review-gate`](../SKILL.md) skill. Read it when the repo sorts changes into risk tiers, or when you're asked whether every change needs the same review.

The gate above has two answers, a review or a `No review:` line. A repo can have more: a file that maps paths to low, medium and high risk, and a review whose effort follows the highest tier a change touches. In one open-source repo's last 100 merged pull requests with a record, 27 were low, 40 medium and 11 high, so most changes took less than the full review and the costly one went where a fault costs most.

## The rules that keep it honest

- **Read the risk file from the base branch,** never the PR's head, as the review list is read. A PR that edits the file is judged by the file it's changing, so it can't lower its own tier.
- **A change to the risk file is itself the highest tier.**
- **A path the file doesn't name takes the highest tier,** not the lowest, so new code isn't waved through until someone sorts it.
- **The tier is computed, not chosen.** Code reads the changed paths and names the tier; the reviewer doesn't pick it, and the record states it with the paths that set it.
- **Say what each tier gets** in review.md: which reviewer types, at what effort, in how many rounds, and which tier a person has to approve.

## What it doesn't do here

`review-record.ts` knows no tiers: it checks the review list, the large-change line and test code. A repo that adds tiers keeps those checks and writes its own for the tier, or lists its high-risk paths in `review-paths.txt` and lets the lower tiers fall to `No review:`.
