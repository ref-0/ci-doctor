<!--
What: one run's report of a slow-test campaign: the headline numbers with their evidence, what was reviewed, merged and left, the reconciliation against the original findings, and proposals for a person.
Where: written by the campaign's coordinator at the end of each run, next to the ledger, and linked from the run's line there.
Configure: where reports are kept, as `report-<date>.md`. The threshold and window come from `.agents/repo/speed-up-tests.md`'s Thresholds (10 s here).
Reference implementation from a production monorepo; adapt to your repo.
-->

# Slow tests: run of `<date>`

## Headline

- Test-seconds: `<s>` → `<s>`; past `<threshold>` s: `<s>` → `<s>`.
- Objective: `<what the campaign set out to move>`; decision threshold, written before measuring: `<value>`; noise floor: `<spread of repeated runs>`.
- Main: `<green / the failing sweep and its issue>`.

### Evidence

| | Before | After |
| --- | --- | --- |
| Window (UTC, complete days) | `<from–to>` | `<from–to>` |
| Collected at (UTC), and by what | `<timestamp, collector>` | `<timestamp, collector>` |
| Estimator (median of file times, sum of p50s, …) | `<…>` | `<…>` |
| Runs eligible / read / unread | `<n / n / n>` | `<n / n / n>` |
| Files selected / executed / replayed from a cache | `<n / n / n>` | `<n / n / n>` |
| Runs failed / unfinished (left out of the times) | `<n / n>` | `<n / n>` |
| Cohort: cold / partly reused / warm | `<n / n / n>` | `<n / n / n>` |
| Files in both periods (common cohort) | `<n>` | `<n>` |
| Observations per file: median, and files under 3 | `<n>, <n>` | `<n>, <n>` |
| New or split files | — | `<n>` |
| Spread of the headline number | `<range>` | `<range>` |
| Limiter (what bounds it, from a profile or counters) | `<…>` | `<…>` |

- Raw change: `<before → after, unadjusted>`. Untouched files over the same window moved by `<factor>`. Adjust for that drift only with an independent, comparable control (`<which files, and why they compare>`); otherwise report the raw change and the drift side by side.
- Saving: observed after merge `<s>`; modelled, merged but not yet observed `<s>`; in flight, modelled `<s>`. Label each; never add them.
- Full selection: `<how the "full" runs were shown to select every eligible file, or "large by shard count only">`.

## Delivery and contention

- First-ready → final green: `<p50, p90>`; final green → merge: `<p50, p90>`; merge → deploy: `<p50>`; runs per PR: `<median>`, PRs with none: `<n>`.
- Evidenced waits: CI `<share>`, local contention `<share>`, review `<share>`, approval `<share>`, release holds `<share>`; missing evidence for `<n>` PRs.
- Local slot waits: `<sum>` over `<denominator: all active time / covered work only>`; ambiguous, unmatched or incomplete records `<n>`; parallel waits overlap, so this isn't lost time.

## Reviewed

| Verdict | Files |
| --- | --- |
| Slow for a wrong reason | `<n>` |
| Real work | `<n>` |
| Needs measuring | `<n>` |
| Moved to a later tier | `<n>` |
| Unclassified | `<n>` |
| **Reviewed (must equal the sum)** | `<n>` |

## Reconciliation

Every actionable item from the original review, until each has a final disposition.

| Item | Disposition | Owner or next action |
| --- | --- | --- |
| `<file or cause>` | `<fixed in <pr> · owned elsewhere · still open · reclassified (evidence) · deferred on purpose · unclassified>` | `<who, or what next>` |

- Finish line: `<the epic's original completion test>`: `<met / not met, and why>`. The epic stays open until it and its child issues are met.

## Merged

| PR | Files | Before → after (CI s) | Observed or modelled |
| --- | --- | --- | --- |
| `<pr>` | `<file>` | `<s>` → `<s>` | `<observed in <n> post-merge runs / not yet observed>` |

## In flight

- `<pr>`: `<state, and what it waits on>`.

## Flakes

- `<Flaky: file › test>`: `<sightings, and who owns it>`.

## Tier moves

- `<file>` → `<tier>`: `<what still selects it on a PR, and the delay a fault can now sit on main>`.

## Proposals

- `<proposal>`: `<the saving, the cost a month at list price, the risk>`. Waiting on a person.

## Notes

- `<what got in the way, and what changes for the next run>`.

## Each file

| File | CI s (newest 5 passing) | Runs | Class | Reading | Verdict | PR |
| --- | --- | --- | --- | --- | --- | --- |
| `<file>` | `<s, s, s, s, s>` | `<n>` | `<wait kind>` | `<path:line of what it waits for>` | `<verdict>` | `<pr>` |
