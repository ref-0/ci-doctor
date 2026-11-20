<!--
What: the rules every engineer's brief in a campaign carries, so each brief holds only its own task.
Where: copy next to your briefs, keeping the name `briefs-README.md`, which each brief links.
Configure: your test command, your complete reproducible install command, PR label (`automation` here), and the machine policy from your AGENTS.md.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Rules for every brief

Each brief has one finish line. These rules hold for all of them.

## Scope

- **One finish line.** What you find outside it goes in a new issue, not your PR.
- **A production bug is in scope** when the test you're speeding up exposes it. Fix it, or file it and say why not.
- **Build it yourself.** Wide reading, such as sweeping logs or estimating many files, goes to a second model that costs less; you measure and build.
- **Read first:** `<skills-dir>/fix-flaky-test/SKILL.md` and, where the repo uses `review-gate`, `<skills-dir>/review-gate/references/tests-reviewer.md`. Fill in `<skills-dir>` when you copy this file.

## Starting

- Note the epic and the base SHA from your brief. Install with `<install-command>`, the repo's complete frozen install, such as `pnpm install --frozen-lockfile`, `npm ci` or `cargo fetch --locked`.
- Check for overlap before you start and before each push: `gh pr list --repo <org>/<repo> --search "<file>"`.

## Measuring

- **Measure first and last,** the same way, at like load.
- **Never retry, raise a timeout or skip** to make a test pass. A test that needs one is a finding.
- **A flake's fix is proved locally** by `<n>` runs in a row with no retry, with the machine's load average noted, and a mutation that reopens the race and fails the test. The PR's ready run is the CI evidence, under the repo's flake policy in `.agents/repo/ci.md`; report a second failure to the coordinator. A flake you can't reproduce gets diagnostics, not a guess.

## Checks

- Run the checks the repo's `AGENTS.md` names for your files, locally, as its machine policy allows: format, lint, types and the test files you touched.
- Run what the machine policy allows on your machine, and no CI by hand outside the approved exceptions in `.agents/repo/ci.md`. What the policy reserves for CI, name in your report. The shared machine's test slots are for everyone; don't raise `--maxWorkers`.
- Stop only processes you started, by their PID.

## The pull request

- Open it as a **draft**, labelled `automation`. Never mark it ready and never start CI by hand: the coordinator does both.
- **Report in at most 10 lines:** the PR, its head SHA, before → after, and the issues you filed.
