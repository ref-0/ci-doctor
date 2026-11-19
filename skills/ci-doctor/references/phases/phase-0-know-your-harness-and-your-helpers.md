[Start: ci-doctor](../../SKILL.md) · Next: [Phase 1](phase-1-map-the-repo.md)

# Phase 0: know your harness and your helpers

Work out, and record in the plan:

1. **Which harness you are,** for example Claude Code, Codex CLI, Cursor, Copilot agent, T3 Code, or an IDE agent.
2. **Parallel work and scheduling:** whether you can start subagents in separate git worktrees, use a second model for reading, and run recurring work. [`docs/harnesses.md`](../../../../docs/harnesses.md) says how in each harness. Don't invent a feature your harness doesn't have; if you're unsure it exists, say so and offer the most portable option. Recurring work is all opt-in, and comes in four kinds:
   - an interactive session loop (stops with the session);
   - a cloud agent job (a fresh clone, its own identity and scoped credentials, and model usage);
   - a script-only GitHub Actions cron (runner minutes, no model);
   - a timer on a host (the intended user, config home and `PATH`).
3. **Machine limits:**
   - core count, memory, whether several agents share the machine, and whether Docker or heavy local runs are welcome;
   - the machine's policy for full checks and builds, if it's shared: which local checks are allowed, and which are left to CI;
   - for shared test slots (guide section 14), only if the plan uses them: the one project name, slot directory and cap every caller uses, set once in the shared launch environment;
   - the conditional prerequisites in README's "Only if you use them" and [`scripts/local/README.md`](../../../../scripts/local/README.md#what-the-machine-needs).
4. **What you can read now.** Check with status commands only (`gh auth status`, and a read of the repo's runs: `gh run list --limit 1`). A private repo, missing SSO or restricted billing may stop a read: note it and ask for the exact missing permission, or for an owner-provided, redacted export.
5. **Accounts the plan may need later.** Only for options the plan might select, note whether they exist: a Blacksmith org and `blacksmith auth status`; a Cloudflare account and `wrangler whoami`; each model CLI's executable, provider, config home and auth-status command. Don't ask for any of these as baseline setup. Write rights, secrets and installs belong to Phase 4.

**Logins are the user's to do.** Never read credential files, and never put a token on a command line. [`logins.md`](logins.md) lists each tool's status check, the login the user runs, and what it's for.

**AI accounts:** the best setup is both Claude and Codex, with more than one account of each when several agents run at once. Note what the user has; [Phase 3](phase-3-set-targets-and-write-the-plan.md#building-the-slow-test-inventory-with-helpers) says which model does which job.

**Default to one agent and one read-only plan.** Ask about parallel agents and a second reading model only once the plan shows work that would benefit, and respect the number the user gives for the whole effort.
