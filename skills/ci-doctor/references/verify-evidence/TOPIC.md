<!--
What: the evidence-quality check for outputs and numbers: what was really checked, and what a number really measured.
Where: read by a coding agent before it declares a task done, measures, or quotes a number in a PR, plan or report.
Configure: nothing; the report templates in the hub's references/agent-knowledge/ carry its fields.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Verify evidence

[`test-audit`](../../../test-audit/SKILL.md) judges whether a test is worth keeping. This topic judges whether the evidence for a claim holds, and owns how to judge a number. Where CI's records are and how to read them is [`speed-up-tests`' measuring](../../../speed-up-tests/references/measuring.md).

## An output: check the real thing

Check the artifact itself: run the feature, read the actual value, inspect the diff, read the job's log for the files that ran. A file's modification time, an agent's own report, cached output, a green check or "it compiles" is a proxy, not a check. When a check fails, suspect how you observed it before you suspect the system.

Script the check where you can, so it runs again the same way, and keep its output where a person can read it.

**A deliberate mutation,** to show a test catches what it guards, runs only after the user approved the work, in a disposable checkout: remote cache writes off and the test run uncached, so nothing replays a pass. Check it fails for the intended reason, restore the source, and confirm the clean file passes with retries off. Use the repo's own test command, and keep the mutation out of commits and CI.

## A number: explain it

Before you measure:

- **Say which kind it is.** A retrospective baseline uses only the history that exists: mark CPU, memory and the limiter unknown where the logs lack them, and take the noise floor from comparable existing runs. A causal experiment, a telemetry step or paired runs, is priced and approved first; otherwise collect matched later ready runs beside a control cohort. Label early evidence provisional, and use the target repo's own observed spread, not another repo's band.

- **Write the decision first:** the result that would change what you do, and the noise floor, from repeated runs of the same thing. A threshold chosen after seeing the result isn't one.
- **Plan enough runs to see past the spread.** Stop and say so when the run-to-run spread is larger than the effect.
- **Interleave before and after** at like load, before, after, before, after, and say the load. A baseline at a high load and an after at a low one shows a gain that isn't there.
- **Keep a control group:** what your change didn't touch, over the same window. Always report the unadjusted comparison. Subtract the control's drift only when the control is independent of the change and you can explain why the two cohorts compare; otherwise report the raw changes and the uncertainty.

After:

- **Name the limiter.** Ask why the result isn't double or half: name the resource or code path that bounds it, from a profile, counters or CPU taken during the run. A CPU sampler starts and stops inside the step it measures and keeps its summary. A guess from reading code isn't a limiter, and neither is the job that happened to end last.
- **Rule out what else it measured:** errors, retries, skipped or cached work replayed instead of run, code that never ran, a different input set, a cold versus warm cache, load on the machine, a different hour, a piece too small to matter. Rule out each with evidence.
- **Keep the count, the spread, the limiter and the threshold with the number,** wherever it goes.
- **Say observed or modelled.** A model, a replay or an estimate from code is labelled as one, and checked against real runs before it's believed. A static estimate is a guess, and overlapping fixes don't add up.

## Where this applies

- A CI baseline or a before/after: where the records are and the test-specific rules are in [measuring](../../../speed-up-tests/references/measuring.md), history from the API in [CI history data](../../../speed-up-tests/references/ci-history-data.md), and the check [measure CI before changing it](../checks/ci-measure-before-changing-it.md).
- A campaign's report: the [report template](../agent-knowledge/report.md) carries these fields.
- A spike or research result that decides what gets built: give it an experiment and a skeptic reviewer, as [`review-gate`](../../../review-gate/SKILL.md) says.
