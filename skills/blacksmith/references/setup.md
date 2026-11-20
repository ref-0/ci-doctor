<!--
What: where this skill's work starts: the repo's Blacksmith facts, or what to read without them.
Where: read by an agent before it changes a label, a disk action or the spend limit, in a repo it hasn't worked in.
Configure: your repo's `.agents/repo/ci.md`, from the template this page links.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Start here

Part of the [`blacksmith`](../SKILL.md) skill. Which start fits depends on what the repo has.

## With the repo's facts file

`.agents/repo/ci.md` holds, for this repo:

- **Runners, budgets and records:** each label's price per vCPU-minute (`<price-per-vcpu-minute>`) with the date it was read, the month's cap (`<monthly-cap>`), and each job's `runs-on` with the comment that says why that size.
- **Caches:** each sticky disk and cache, its key, who commits it and who reads it, and the shared actions in `<actions-repo>` that mount them.
- **Spend watcher,** where the user approved one: what it reads with the `blacksmith` CLI, which workflows it may stop, and who recovers after a stop.

Read the values from there, never from a copy, then work from the skill's "What to read".

## With no facts file

Ask the user once whether the repo keeps these facts elsewhere. If it doesn't, read them yourself, and at the end offer to write those sections from [the template](https://github.com/ref-0/ci-doctor/blob/next/skills/agent-knowledge/templates/repo-facts/ci.md#runners-budgets-and-records):

1. **Labels:** each job's `runs-on` in the workflow files. A `blacksmith-<n>vcpu-…` label is Blacksmith's; anything else runs elsewhere.
2. **Disks and caches:** the steps that mount a sticky disk (`useblacksmith/stickydisk` or a shared action wrapping it), their keys, and which events may commit them.
3. **The org and the CLI:** ask the user to run `blacksmith auth status` and say which org it shows. Without a signed-in CLI, price from labels and say the bill wasn't read.
4. **The spend limit:** ask the user what Blacksmith's own limit is, since only its dashboard shows it. Without one, say so in the plan; don't set one.

Say which values you assumed until the file exists: the source repo's numbers in these pages are examples, not this repo's.
