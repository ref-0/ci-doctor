<!--
What: where this skill's work starts: the repo's runner facts, or what to do without them.
Where: read by an agent before it sizes a runner, prices a change or reads a queue, in a repo it hasn't worked in.
Configure: your repo's `.agents/repo/ci.md`, from the template this page links.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Start here

Part of the [`ci-runners`](../SKILL.md) skill. Which start fits depends on what the repo has.

## With the repo's facts file

`.agents/repo/ci.md` holds, in its Runners, budgets and records section:

- **Where each value lives:** each pull request job's budget and the month's cap (`<monthly-cap>`), each runner label's price, unit and rounding (`<price-per-minute>`, with the date it was read), the shard script and its cap, and each job's `runs-on` with the comment that says why that size.
- **Runner sizes, as measured:** what each size was measured to do, and when.
- **Tried and dropped:** the register to read before proposing a runner change.

Its Spend watcher section, where the user approved one, names what the watcher reads, which workflows it may stop and who recovers after a stop. Read the values from there, never from a copy, then work from the skill's "What to read".

## With no facts file

Ask the user once whether the repo keeps these facts elsewhere. If it doesn't, work from what you find, and at the end offer to write the section from [the template](https://github.com/ref-0/ci-doctor/blob/next/skills/agent-knowledge/templates/repo-facts/ci.md#runners-budgets-and-records), filled with what you learned:

1. **Runners:** each job's `runs-on` in the workflow files, grouped by label, with any matrix expanded. A label you can't place on a provider is a question for the user.
2. **Prices:** each label's unit and rounding from the provider's current pricing page, with the date read. Without a price, report minutes, and no money total.
3. **Records:** the jobs API's history over a complete window, every page and attempt, as [CI history data](https://github.com/ref-0/ci-doctor/blob/next/skills/speed-up-tests/references/ci-history-data.md) says, and per-job CPU from the provider or none, recorded as unknown.
4. **The cap:** the provider's budgets and alerts, where you're allowed to read them. Without a cap, say so in the plan; don't set one.

Say which values you assumed until the file exists: the source repo's numbers in these pages are examples, not this repo's.
