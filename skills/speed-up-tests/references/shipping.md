<!--
What: how to ship a faster test: what goes in each pull request, what to read in its run before merging, and what to do after the merge.
Where: read by an agent before it opens a pull request that speeds up tests.
Configure: nothing.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Shipping a faster test

Part of the [`speed-up-tests`](../SKILL.md) skill: what each pull request carries, what to check in its run, and what follows the merge. Read it before you open the pull request.

- One shared cause or area per pull request, with the times before and after in its body. Take CI's before from its records and its after from the pull request's own run once it's ready, never from a run by hand. A draft quotes local times.
- Before you merge, read the run's logs: the plan chose the changed files, they ran, and their times match. Green checks can hide a file that never ran.
- A setting added in several parallel pull requests can conflict in a generated file: take main's copy and regenerate it on each rebase.
- After a merge, fix any docs that name a file the change split or renamed.
- Anything only main runs, such as a cron or a sweep's deeper property, gets a check at the time of its first run, which you then read.
