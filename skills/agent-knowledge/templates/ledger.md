<!--
What: the ledger of a standing slow-test campaign: what's open, owned, queued and decided, so no run reviews the same file twice.
Where: one file the campaign's coordinator reads at the start of each run and rewrites at its end; keep it outside the repo or in your agent docs.
Configure: the <epic> issue and the baseline. The triage cutoff, its window and the re-review band come from `.agents/repo/speed-up-tests.md`'s Thresholds (10 s, newest five passing runs and ±40% here).
Reference implementation from a production monorepo; adapt to your repo.
-->

# Slow tests: the ledger

Rules for this file:

- Keep it under about 120 lines. History goes in each run's report, `report-<date>.md`, linked from that run's line, not here.
- One line per run under Runs. Each run belongs to `<epic>`.
- Move a file between sections; never list it twice.
- A file in "Decided" with a timed verdict keeps its baseline: the value, the window it came from and the date. It isn't reviewed again unless its CI time leaves the re-review band around that baseline.

## Runs

<!-- One line per run: date, base SHA, files reviewed, PRs opened, test-seconds before → after, its report. -->
- `<date>` · base `<main-sha>` · reviewed `<n>` · PRs `<pr>, <pr>` · `<s>` → `<s>` test-seconds · `<report-file>`

## Baseline

- Test-seconds past `<threshold>` s: `<s>`, from `<n>` runs between `<date>` and `<date>`.
- Compare at like hours: CI's times vary with the runners' load.

<!-- Example: shards on a busy afternoon ran much slower than at night, so a baseline from night runs made the
     next morning's fixes look worse. -->

## Owned now

| File | CI s (newest 5) | Owner | PR | Since |
| --- | --- | --- | --- | --- |
| `<file>` | `<s>` | `<engineer>` | `<pr>` | `<date>` |

## Open, not owned

| File | CI s | Cause | Next step |
| --- | --- | --- | --- |
| `<file>` | `<s>` | `<what it waits for, at path:line>` | `<fix, measure or tier move>` |

## Queued

1. `<file or shared cause>`: `<why it's next>`.

## Owned by another plan

- `<file>`: `<the plan or issue that owns it>`.

## Decided, don't reopen

- `<decision>`, `<date>`: `<the reason, in a line>`. For a timed verdict: baseline `<s>` over `<window>`, taken `<date>`.

<!-- Example decisions from the source repo:
- A tests reviewer reads every PR that changes tests; its round cap holds.
- No shared runtime, watch mode or resident bundler across test files: each broke isolation or held memory.
- No separate fast test command: make the default fast.
- No release-only tier: a release already waits for the sweep.
- Re-review a "real work" file only when its time leaves the band around its stored baseline (±40% at like hours).
- Leave as real work: <files whose time is the work they prove>.
- Tier moves agreed: <file → sweep>, with the paths that still select it on a PR.
- Test periods are settings: a short one in tests, production's own in production.
- CI evidence: the PR's ready run once, under ci.md's flake policy. A further CI repeat needs a specific question and the coordinator's yes.
- Two PRs on one shared helper can cross; check overlap before each push.
-->

## Proposals waiting on a person

- `<proposal>`: `<what it saves, what it costs, what it risks>`.
