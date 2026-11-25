<!--
What: the review session comment, line by line, as the gate's checker reads it, with examples and the local check.
Where: read by an agent when a review session ends, before it marks the PR ready.
Configure: the accepted types, considered types, thresholds and effort in `.agents/repo/review-record.json`, from the agent-knowledge skill's templates/repo-facts/review-record.json; your gate's call to it.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The review record

Part of the [`review-gate`](../SKILL.md) skill. A session ends with one comment on the PR, which [`scripts/review-record.ts`](../scripts/review-record.ts) reads in CI's result job. Copy the first line and the table's columns; don't reword them.

```text
## Review: <model>, <effort>, <k> reviewers, <n> rounds, <end>

Reviewers: <type>: <scope>; <type>: <scope>; …
Not run: <type>: <why>; <type>: <why>; …

| # | Round | Type | Sev | Finding | Found by | State |
```

- `<effort>` is the one the checker requires (`high` here). `<k>` is round 1's reviewers, 1 to 8, written `1 reviewer` for one.
- `Reviewers:` has `<k>` entries joined by `; `, each one type in lowercase and a scope, such as `red team: token refresh`. A scope never holds `; `.
- `Not run:` names, on a change to the review list's paths, each type in the checker's `consideredTypes` that the session didn't run, with what the change doesn't reach. Leave it out when there's none.
- `<n> rounds` is the rounds run, `1 round` for one. `<end>` is `clean at <short sha>` when the last round found nothing new, or `open at <short sha>` when a fix landed after it or the session stopped early.
- `Sev` is `P0` to `P3`, or `—` for a dismissed finding. `State` starts `Fixed in <sha>`, `Filed #<n>`, `Kept: <why, who decided>`, `Dismissed: <why>` or `Question`.
- No tally line, so a count can't disagree with the rows. A collision check goes on its own line below the table.
- Fold each reviewer's own review, as written, under the table.

With no findings, the table gives way to "No findings."

## Examples

A covered change, two reviewers, clean:

```text
## Review: <model>, high, 2 reviewers, 1 round, clean at 1a2b3c4

Reviewers: red team: token refresh; storage: the sessions migration
Not run: stress test: no input parsing; system design: no new state; program design: no contract change; bounded verification: no model covers it; fuzzing: no parser

No findings.
```

A large change, one round, with a fix after it:

```text
## Review: <model>, high, 1 reviewer, 1 round, open at 5d6e7f8

Reviewers: code quality: the new exporter

| # | Round | Type | Sev | Finding | Found by | State |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | code quality | P2 | Two copies of the retry loop | code quality | Fixed in 9a8b7c6 |
```

The code quality reviewer gets no round 2, so the session stays `open at` the head round 1 reviewed, and the fix is named in the table.

No review, in the PR's body: `No review: docs only.` or, for a typo on a covered path, `No review: low risk, a typo in a comment.`

## Check it before posting

From the repo's root, on Node 24, with `<review-checker>` the path review.md names:

```sh
BASE=<base> node <review-checker> --count          # large? test code? which files the review list covers?
node <review-checker> --comment session.md --covered
```

The gate runs the same file with `PR`, `GITHUB_REPOSITORY`, `GITHUB_SHA` and `GH_TOKEN` set, and `BASE` for a target other than `main`, such as a stacked PR's parent. It checks the record's format and reviewer types, not that a session covers the tested head: [the reviewed head](reviewed-head.md) says how to check that before merging. It fails a ready PR whose record is missing or wrong; a rerun-the-result workflow reruns only that job when the record lands after it failed for that alone. Only a member's session comment counts (author association OWNER, MEMBER or COLLABORATOR, the same list the rerun workflow checks), so an outsider's comment on a public repo can't satisfy the gate.

CI's result job runs this script, and reads its settings, from the base branch's copy, so a change to it gates PRs only once it merges; until the base has it, the step warns and passes. Keep the script's settings file, your review list and review.md's accepted types in step: a type the skill adds and the script lacks fails by name.
