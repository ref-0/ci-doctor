<!--
What: a template for one engineer's brief in a slow-test or flake campaign, with two worked examples.
Where: written by the campaign's coordinator, one per engineer; each carries the shared rules in briefs-README.md.
Configure: the brief's finish line, files, times and proof; keep it next to briefs-README.md, under that name, so the link below resolves.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Brief: `<one finish line>`

Read the [shared rules](briefs-README.md) first; they hold for every brief.

- **Epic:** `<epic>` · **Base:** `<main-sha>`
- **Done:** `<the one finish line, measurable: a time, a count, a proof>`.
- **Files and CI's times:** `<file>`: `<s, s, s, s, s>` (newest 5).
- **What it waits for:** `<path:line>`, `<the reader's verdict>`.
- **The proof to keep:** `<what the test proves, which must still fail when the code breaks>`.
- **Measure:** before and after, locally, `<n>` runs each, at like load, with the decision threshold written first; keep the raw numbers beside any adjustment.
- **Objective:** `<what this change must improve: median or p90 latency, billed cost, coverage, reliability or local feedback>`.
- **Report:** at most 10 lines: the draft PR, its head SHA, before → after, what you found outside scope (as issues).

## Example: a file's waits

> **Done:** `<file>` under 10 s locally, its proofs unchanged.
>
> The file takes `<s>` in CI. The reader found four waits: a production poll period, a job's wake floor, a helper polling every second, and a fake's fixed delay. Take one lever at a time. Measure each alone, before and after. Open one draft PR per lever, so each saving is visible and each can be reverted alone. End your report with a "Done:" line giving each lever's saving.

## Example: one flake

> **Done:** `Flaky: <file> › <test>` closed by a fix proved locally `<n>` runs in a row with no retry.
>
> Read the issue's sightings first. The failing assertion is at `<file>:<line>`. Find the race it loses, and hold the step it turns on, in the test's fake, until the other side is in place. Prove the fix locally with `<n>` runs in a row, no retry, noting the machine's load average, and with a mutation that reopens the race and fails the test. The PR's ready run is the CI evidence, under the repo's flake policy in `.agents/repo/ci.md`; ask before any other run by hand. If it won't reproduce, add diagnostics that name the race next time instead of guessing.
