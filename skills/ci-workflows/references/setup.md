<!--
What: where this skill's work starts: the repo's facts file, or the workflows themselves when there is none.
Where: read by an agent before it changes CI in a repo it hasn't worked in.
Configure: your repo's `.agents/repo/ci.md` and `.agents/repo/ci-time.json`, from the templates this page links.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Start here

Part of the [`ci-workflows`](../SKILL.md) skill. Which start fits depends on what the repo has.

## With the repo's facts file

`.agents/repo/ci.md` names, for this repo:

- **Entry points and gate:** the workflow that runs pull requests, whether drafts run, the gate job by its ID and the required checks.
- **Selection and tiers:** what a change selects, what a path the selector doesn't know runs, the sentinel cases, the covered-only list, the sweep and what a release waits for; and the real-container files, with what selects each.
- **Runners, budgets and records:** where each value lives, by file: each job's budget and runner, the price list, the shard cap and its statistic, concurrency, the schedules, retries and flakes, and the records. Then the runner sizes as measured, and the register of what was tried and dropped.
- **Caches:** each cache's key, who writes it and who reads it, and what's left uncached on purpose.
- **Manual runs and failures:** who approves a run by hand, the approved exceptions and each workflow's declared inputs.

`.agents/repo/ci-time.json` holds `ci-time.ts`'s settings: the workflow, the shard prefixes, the gate job, and each runner label's vCPUs and price. A key it leaves out keeps the script's default.

Read ci.md, then the workflows its Entry points name: each header says what runs when, and the comment above each job and step says why.

## With no facts file

Ask the user once whether the repo keeps these facts elsewhere. If it doesn't, read them from the workflows: the triggers, the gate's `needs:`, each job's `runs-on`, the cache steps and their keys, `concurrency`, and the scripts the jobs call. Say which values you read from code and which you assumed, and at the end offer to write the file from [the template](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/agent-knowledge/templates/repo-facts/ci.md), filled with what you learned, and `ci-time.json` from [its template](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/agent-knowledge/templates/repo-facts/ci-time.json).

Until then, `ci-time.ts` takes the same values as flags: `--repo`, `--workflow` and a `--shard` for each sharded job's name prefix.
