<!--
What: the facts about one repo's review that the review-gate skill reads: its systems, review list, model and account, types and checker.
Where: copy to `.agents/repo/review.md` in your repo, and the review list to `.agents/repo/review-paths.txt`.
Configure: replace every <placeholder>; delete the commented examples once yours are in.
Reference implementation from a production monorepo; adapt to your repo.
-->

# <repo>'s review

What the `review-gate` skill reads about this repo. It wins on policy. Keep values in the checker's settings, `.agents/repo/review-record.json`, and the review list, and name them here.

## Systems and the review list

- `<system>`: `<why a miss there is costly: a security hole, lost data, hard to undo>`.
- The review list is `.agents/repo/review-paths.txt`: one glob a line, `*` crossing folders, `!` taking a path off, `#` a comment. The gate reads the base branch's copy.

<!-- Example review-paths.txt:
# sign-in and tokens
src/auth/*
# stored state
migrations/*
src/storage/*
# contracts
packages/contracts/*
!packages/contracts/README.md
-->

## Model, account and effort

- Review model: `<model>`, run through `<CLI>` at effort `<effort>`.
- Account: `<whose authorized account, and its config home>`. Sign-in status: `<the CLI's status command>`. A person signs it in; agents never read its token files.
- At a usage limit: `<who decides whether to go on without a review>`.

## Types

- Accepted: `<the types in review-record.ts's reviewTypes>`.
- Considered on every covered change, each either run or named as not run: `<consideredTypes>`.
- Test code: `<testCode's globs>`. Production source: `<extensions and exclusions>`.
- Large change: `<largeChange>` net lines. Low-risk limit: `<lowRiskLines>` lines.

## Checker and gate

- Checker: `<review-checker>`, the repo's copy of review-record.ts, from the repo root, on Node 24 or later. `<gate-job>` runs it with `PR`, `GITHUB_REPOSITORY`, `GITHUB_SHA`, `GH_TOKEN` and `BASE`.
- Local, from the repo root: `BASE=<base> node <review-checker> --count`, and `node <review-checker> --comment <file> [--covered]` before posting.
- The gate checks the record's format and types, not that it reviewed the current head: after a push past the reviewed SHA, a person or agent compares the two.
- A record that lands after the gate failed for it alone: `<the workflow that reruns only the gate>`.

<!-- Example: the gate is `CI result`; `review-recheck.yml` reruns it when a member's `## Review:` comment
     or a `No review:` body edit lands and the gate was the only failed job. -->
