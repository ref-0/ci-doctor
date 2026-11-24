<!--
What: where each kind of agent knowledge goes, and the shape it takes there: the top-level file, skills, checks, facts files, the register and stack pages.
Where: read by a coding agent before it writes or reorganizes a repo's instruction files, skills or agent docs.
Configure: nothing; the repo's own layout decides the paths.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Where it lives

Part of the [`agent-knowledge`](../SKILL.md) skill. People ask "does all that go into `AGENTS.md`?". No: each kind of knowledge has its own home, and the top-level file maps them.

## The top-level instruction file

- **A short map:** the repo's layout, the commands, the machine policy and a few rules, among them *"When docs and code disagree, the code is right. Fix the doc in the same change."* It's size-budgeted in CI.
- **The file the harness loads:** `AGENTS.md` for Codex, `CLAUDE.md` for Claude Code, Cursor's rules for Cursor. Where a team uses several, one holds the map and the others point at it, as the harness allows.
- **Commands adapted whole,** arguments included, not just their names. An install command is the stack's complete frozen or reproducible install.
- **Each skill named by its moment:** "before changing a runner", "for a slow test", so the agent knows when, not only what.

## Skills

A skill is a folder an agent harness loads when a task matches its description.

- **`SKILL.md`** has only what every use needs: the rules, the steps, and links out.
- **`references/` by topic** holds the detail, read when needed. A slow-tests skill might have `fixes.md`, `measuring.md`, `flakes.md`, `fakes.md` and `campaign.md`.
- **`scripts/`** holds the mechanics: collecting, ranking, grouping, budgets and filing are code with tests, so the words describe judgement, not steps that drift.
- **The description** is what the harness picks the skill by, alone. Write it in the words of someone asking for the work, say when to use it, and name the sibling skill that owns the neighbouring work, so no two skills claim one trigger. A topic whose task doesn't sound like its parent skill's becomes a skill of its own.
- **Stack-specific detail gets its own reference page,** linked with "if your stack uses X", so the general text reads correctly without it.

## Checks

A check is one rule per small document, short enough to read at the moment it applies. Each has the moment, yes/no questions, the commands that answer them, and the incident and numbers that motivated it. Skills link checks rather than copying them. Add one when the same mistake has happened twice, or once at real cost; generalize a near-match rather than add a second. The hub's [checks README](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/ci-doctor/references/checks/README.md) has a page's shape.

## Shared skills, per-repo facts

- **Skills are shared; facts are the repo's.** Skills can live in one shared repo, linked into every checkout's skills folder. That's how they're shared, not how a harness finds them: point each harness at them as its docs say.
- **Each repo keeps its own facts** in `.agents/repo/*.md`: its commands, CI tiers, settings names, thresholds, holds and fakes. The skill gives the procedure, the repo the values that change, so each can change without the other. [The templates](../templates/README.md) has one per file the ci-doctor skills read.
- **Agent docs have no release cycle:** an edit to a linked skill reaches every worktree at once. Review it like code.

## The register of what was tried

One place lists every measured-and-dropped idea: when it was tried, its numbers, its evidence (the PR or run, or why there's none), and what would have to change to try it again. The repo's facts name where it is. A later run may propose one again only with new numbers; some ideas do come back once conditions change, which is why each row says when. For CI, the hub's [read what was tried](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/ci-doctor/references/checks/ci-read-what-was-tried.md) has the columns and example rows.

## Memories

An agent's own memory holds what no doc covers yet. When a skill or facts file comes to cover it, the memory goes. A memory that keeps being needed is a lesson to write down.
