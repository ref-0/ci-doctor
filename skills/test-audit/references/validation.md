<!--
What: the checks to run after editing tests or source, and what to report.
Where: read by an agent that has changed tests, test support or production code.
Configure: your repo's commands block in AGENTS.md, and its `.agents/repo/ci.md`.
Reference implementation from a production monorepo; adapt to your repo. Adapted from openclaw (MIT); see ../UPSTREAM.md.
-->

# Validation

Part of the [`test-audit`](../SKILL.md) skill: the checks after an edit, in order. Read it when you have edited tests or source.

1. Run each owner or sibling test file by name, filtered to the tests you changed where you can, as the commands block of the repo's `AGENTS.md` says. Never pass a directory, package or glob. Follow it for local checks.
2. For removed source greps or plan assertions, run the executable script or
   dry-run that owns the real contract.
3. Run the repo's format, lint and type check, as its commands block says, then `git diff --check`.
4. Leave the full check, and what the commands block keeps off your
   machine, to the PR's CI run, as its `.agents/repo/ci.md` says
   (template: [`repo-facts/ci.md`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/agent-knowledge/templates/repo-facts/ci.md)).
5. Inspect `git diff --numstat`; report production/tooling separately from
   tests and test support.
