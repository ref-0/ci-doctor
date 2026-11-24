---
name: prove-it
description: "Checks whether the evidence for a claim holds: that a change made something faster, cost less or fixed. Use when someone claims a speed-up, a saving or a fix, or quotes a benchmark, a before and after or a few runs. Not for why a CI run failed (ci-doctor); whether a test is worth keeping (test-audit)."
metadata:
  version: "0.3.0"
---

# prove-it

A claim that something got faster, smaller, cost less or was fixed is only as good as the evidence under it. This skill judges that evidence before the claim goes into a PR, a plan, a report or a decision. It works the same for a function's benchmark, a page's load time, a query, a build, a CI run, a cloud bill or a bug fix.

Use it before you quote a number, call work done, accept someone else's result, or decide what to build from a spike. This skill reviews the evidence for a claim. Diagnosing a CI run, why it failed or what made it slow, is the `ci-doctor` skill's, and whether a test is worth keeping is `test-audit`'s.

## Rules

- **Decide before you measure.** Write down the result that would change what you do, and the noise floor, before the first run. A threshold chosen after seeing the result isn't one.
- **Check the real thing,** not a proxy for it: the value, the output, the log of what ran. A green check, a modification time, a cached result or an agent's own report is a proxy.
- **Like for like:** the same command, input, machine, field and conditions on both sides, with only the change between them.
- **Every number carries its count, spread, limiter, threshold and label** (measured, replayed, modelled or guessed), wherever it goes.
- **Report the honest outcome,** raw before adjusted, and what's still open beside what's done.

## 1. Before you measure

- **Say which kind of evidence it is.** A *retrospective* baseline reads only the history that exists. A *causal experiment* runs the thing on purpose: paired runs, a benchmark, an added probe. An experiment that costs money, machines or people's time is priced and approved first. [Numbers](references/numbers.md#two-kinds-of-evidence) says what each can and can't show.
- **Write the decision:** "if p50 drops by more than X, we ship it; if not, we drop it". Name the field: wall time, CPU time, p50 or p90, bytes, requests, billed units. Say which one you expect to move.
- **Measure the noise floor:** the same thing, unchanged, run several times. Its spread is the smallest effect you can claim.
- **Plan enough runs to see past it.** If the run-to-run spread is larger than the effect you expect, more runs or a quieter setup come first. If you can't get there, stop and say so.

## 2. Compare like for like

Hold everything but the change: the command, the input set, the machine and its load, the hour, a warm or cold cache, the build mode, the versions. Compare a thing with its own history, not with a neighbour. [Numbers](references/numbers.md#like-for-like) lists what most often differs without anyone noticing.

## 3. Interleave, and keep a control

- **Interleave** before and after: before, after, before, after, at like load, and say the load. A baseline taken at one load and an after at another shows a gain that isn't there.
- **Keep a control:** something the change didn't touch, measured over the same window. If it moved too, part of your change isn't yours.
- **Report the unadjusted comparison** always. Subtract the control's drift only when the control is independent of the change and you can say why the two compare; otherwise give the raw change and the drift side by side.

[Numbers](references/numbers.md#interleaving-and-controls) has the schedules and the cases where a control misleads.

## 4. Explain the result

- **Name the limiter.** Ask why the result isn't double or half: name the resource or code path that bounds it, from a profile, counters or CPU taken during the run. A guess from reading code isn't a limiter, and neither is whatever happened to end last.
- **Rule out what else it measured:** errors, retries, skipped or cached work replayed instead of run, code that never ran, a different input, a cold versus warm cache, load, a different hour, a piece too small to matter. Rule out each with evidence, as [numbers](references/numbers.md#what-else-it-measured) says.
- **Say observed or modelled.** A model, a replay or an estimate from code is labelled as one and checked against real runs before it's believed. A static estimate is a guess, and overlapping fixes don't add up.

## 5. Report it

Give each claim in the shape [the report](references/report.md) has: the claim, the decision and threshold written first, the noise floor, the runs on each side, the raw change, the control, the limiter, what was ruled out, and the label. Keep the count, spread, limiter and threshold with the number when it's quoted elsewhere. A saving is split into observed, merged but modelled, and in flight, each labelled, and never added together.

## A claim that something works or is fixed

Check the artifact itself: run the feature, read the actual value, inspect the diff, read the log for what ran. When a check fails, suspect how you observed it before you suspect the system. To show a test catches what it guards, break the code on purpose and watch it fail for the intended reason. [Outputs](references/outputs.md) has the proxies to distrust, how to script the check, and the rules for a deliberate mutation.

## Where this applies in CI

CI's records and the rules particular to them are in the `ci-doctor` plugin's hub. Links go to the [ci-doctor repo](https://github.com/ref-0/ci-doctor/tree/v0.3.0) at this skill's release:

- A CI baseline or a before and after: [measuring](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/speed-up-tests/references/measuring.md) for where the records are and the test-specific rules, [CI history data](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/speed-up-tests/references/ci-history-data.md) for history from the API, and the check [measure CI before changing it](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/ci-doctor/references/checks/ci-measure-before-changing-it.md).
- A cost: [budget CI at list price](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/ci-doctor/references/checks/budget-ci-at-list-price.md), as a monthly projection from measured frequency.
- A slow-test campaign's report: its template carries [the report](references/report.md)'s fields for each headline number.
- A spike or research result that decides what gets built: an experiment and a skeptic reviewer, as [`review-gate`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/review-gate/SKILL.md) says.

## Not here

- Why a CI run failed or what made it slow: the `ci-doctor` skill. Making a slow test faster: `speed-up-tests`; a flaky one: `fix-flaky-test`. How far an edit reaches through a workspace: `optimize-graphs`.
- Whether a test is worth keeping, or what it covers: `test-audit`.

## Outside this skill

Every link out of this folder is a full URL into the [ci-doctor repo](https://github.com/ref-0/ci-doctor/tree/v0.3.0) at the tag `v<version>`, where the version is this file's `metadata.version`.
