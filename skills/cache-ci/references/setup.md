<!--
What: where this skill's work starts: the repo's facts file, or the workflows' cache steps when there is none.
Where: read by an agent before it changes a cache in a repo it hasn't worked in.
Configure: your repo's `.agents/repo/ci.md`, from the template this page links.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Start here

Part of the [`cache-ci`](../SKILL.md) skill. Which start fits depends on what the repo has.

## With the repo's facts file

`.agents/repo/ci.md`'s **Caches** lists each cache: its key, who writes it and who reads it, and what's left uncached on purpose, with why. Its **Entry points and gate** names the workflows; its **Runners, budgets and records** says where each cache's key lives, in the workflow's cache steps or a shared action, and names the register of what was tried and dropped. Read the register before proposing a cache: the source repo dropped several that cost more to restore than they saved.

Read the Caches section, then the cache steps it points to.

## With no facts file

Ask the user once whether the repo keeps these facts elsewhere. If it doesn't, list the caches from the workflows and the actions they call: every `actions/cache` or restore and save step, each setup action's own cache option (such as `actions/setup-node`'s `cache:`; from v6 it caches npm's store without one when `packageManager` or a lockfile says npm, so a job with no cache step may still restore one), each language's cache action, and any disk or volume a job mounts. For each, write down its key, its paths, which jobs save it and on which events. A cached package store still needs the install: with npm, `npm ci` runs over the restored store and builds `node_modules` from it. Say which values you read from code and which you assumed, and at the end offer to write ci.md's Caches from [the template](https://github.com/ref-0/ci-doctor/blob/next/skills/agent-knowledge/templates/repo-facts/ci.md#caches), filled with what you learned.
