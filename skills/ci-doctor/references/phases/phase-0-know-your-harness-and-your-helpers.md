[Start: ci-doctor](../../SKILL.md) · Next: [Phase 1](phase-1-map-the-repo.md)

# Phase 0: know your harness and your helpers

Work out, and record in the plan:

1. **Which harness you are,** for example Claude Code, Codex CLI, Cursor, Copilot agent, T3 Code, or an IDE agent.
2. **Parallel work and scheduling:** whether you can start subagents in separate git worktrees, use a second model for reading, and run recurring work. [The harness notes](../excerpts/phase-0.md#harnesses-parallel-agents-and-recurring-work) say how in each harness. Don't invent a feature your harness doesn't have; if you're unsure it exists, say so and offer the most portable option. Recurring work is all opt-in, and comes in four kinds:
   - an interactive session loop (stops with the session);
   - a cloud agent job (a fresh clone, its own identity and scoped credentials, and model usage);
   - a script-only GitHub Actions cron (runner minutes, no model);
   - a timer on a host (the intended user, config home and `PATH`).
3. **Machine limits:**
   - core count, memory, whether several agents share the machine, and whether Docker or heavy local runs are welcome;
   - the machine's policy for full checks and builds, if it's shared: which local checks are allowed, and which are left to CI;
   - for shared test slots ([guide section 14](../excerpts/phase-2.md#sharing-one-machine)), only if the plan uses them: the one project name, slot directory and cap every caller uses, set once in the shared launch environment;
   - the conditional prerequisites in [logins' "Only if you use them"](logins.md#only-if-you-use-them) and [what the machine needs](../excerpts/phase-0.md#what-the-machine-needs) for the local scripts.
4. **What you can read now.** Check with status commands only (`gh auth status`, and a read of the repo's runs: `gh run list --limit 1`). A private repo, missing SSO or restricted billing may stop a read: note it and ask for the exact missing permission, or for an owner-provided, redacted export.
5. **Accounts the plan may need later.** Only for options the plan might select, note whether they exist: a Blacksmith org and `blacksmith auth status`; a Cloudflare account and `wrangler whoami`; each model CLI's executable, provider, config home and auth-status command. Don't ask for any of these as baseline setup. Write rights, secrets and installs belong to Phase 4.

**Logins are the user's to do.** Never read credential files, and never put a token on a command line. [`logins.md`](logins.md) lists each tool's status check, the login the user runs, and what it's for.

**AI accounts:** the best setup is both Claude and Codex, with more than one account of each when several agents run at once. Note what the user has; [Phase 3](phase-3-set-targets-and-write-the-plan.md#building-the-slow-test-inventory-with-helpers) says which model does which job.

**Default to one agent and one read-only plan.** Ask about parallel agents and a second reading model only once the plan shows work that would benefit, and respect the number the user gives for the whole effort.

## Which ci-doctor skills you have

The phases hand each step to a sibling skill. See which are installed: a folder beside this hub's (`../<name>/SKILL.md` from the hub), or a skill your harness lists, perhaps namespaced, as `ci-doctor:prove-it` is in Claude Code. Record the list in the plan and `progress.md`.

| Skill | Phases that hand work to it |
| --- | --- |
| [`prove-it`](../../../prove-it/SKILL.md) | 2 and 4, and every number the hub's rules label |
| [`speed-up-tests`](../../../speed-up-tests/SKILL.md), [`ci-runners`](../../../ci-runners/SKILL.md), [`fix-flaky-test`](../../../fix-flaky-test/SKILL.md) | 2, 3, 4 and 5 |
| [`cache-ci`](../../../cache-ci/SKILL.md), [`ci-workflows`](../../../ci-workflows/SKILL.md) | 2, 3 and 4 |
| [`blacksmith`](../../../blacksmith/SKILL.md) | 2, 3 and 4, on Blacksmith or for a move there |
| [`optimize-graphs`](../../../optimize-graphs/SKILL.md) | 1, 3, 4 and 5 |
| [`test-audit`](../../../test-audit/SKILL.md), [`proof-tiers`](../../../proof-tiers/SKILL.md) | 3 and 4 |
| [`review-gate`](../../../review-gate/SKILL.md), [`ci-merge-workflow`](../../../ci-merge-workflow/SKILL.md) | 4 and 5, if the repo adopts them |
| [`agent-knowledge`](../../../agent-knowledge/SKILL.md) | 3 and 6, and `progress.md`'s template |

Phase 6 records which of them all the repo adopts.

**For a missing one,** installing is the user's act. Give them the line for it, `npx skills add https://github.com/ref-0/ci-doctor --skill <name>`, or the plugin install in [the README's Installing](../../../../README.md#installing), which adds every skill. Until then, read it at `https://github.com/ref-0/ci-doctor/tree/next/skills/<name>`, and say in the plan which steps ran from that copy.
