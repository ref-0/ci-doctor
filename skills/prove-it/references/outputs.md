<!--
What: how to check that something works or is fixed: the real artifact over its proxies, a scripted check, and a deliberate mutation that shows a test catches what it guards.
Where: read by a coding agent before it calls a task done, accepts another agent's result, or claims a test proves a fix.
Configure: the repo's own test command and its cache settings.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Outputs

Part of the [`prove-it`](../SKILL.md) skill: the claim that something works, is fixed or was checked.

## Check the real thing

Run the feature, read the actual value, inspect the diff, read the job's log for what ran. These are proxies, not checks:

- a file's modification time, or that a file exists;
- an agent's own report of what it did, including your own earlier one;
- cached output, or a result replayed from a cache;
- a green check whose log you haven't read, or a skipped run on the same commit;
- "it compiles", or "the types pass".

When a check fails, suspect how you observed it before you suspect the system: the wrong process, port, commit, environment or cache.

## Script it

Script the check where you can, so it runs again the same way, and keep its output where a person can read it: the command, the commit, what it printed. A check only you ran once, by hand, can't be run again by the next reader.

## A fix

A fix is proved when the failure it fixes reproduces before it and doesn't after it, under the same conditions.

- Reproduce the failure first, and keep how: the command, the input, the seed.
- After the fix, run the same thing. For a failure that happens only sometimes, run it enough times that the old failure rate would have shown, with retries off.
- Name what's left: the cases the reproduction didn't cover.

## A deliberate mutation

To show a test catches what it guards, break the code it guards and watch it fail.

- Only after the user approved the work, in a disposable checkout.
- Remote cache writes off and the test run uncached, so nothing replays a pass.
- Check it fails for the intended reason, not a syntax error or an unrelated assertion.
- Restore the source, and confirm the clean file passes with retries off.
- Use the repo's own test command, and keep the mutation out of commits and CI.
