# Scripts

Reference scripts, one folder per job. Each folder's README says what's in it, how to wire it in, and its placeholders. They need Node 24 or later (TypeScript runs without a build); none needs a workspace install.

Reference implementation from a production monorepo; adapt to your repo.

## Read-only, once, for a baseline

Usable during the survey, before the plan is approved ([PROMPT's read-only rule](../PROMPT.md#before-approval-read-only)), because they only read what already exists. Keep each read bounded, and leave an API-call reserve for everyone else on the login.

| Script | What it reads | Note |
| --- | --- | --- |
| [`records/ci-slow-files.ts`](records/README.md#5-reading-the-archive), [`records/ci-wait-hints.ts`](records/README.md#5-reading-the-archive) | An existing records archive, and the checkout | Only where a records archive already exists |
| [`records/ci-records.ts`](records/README.md) `--run <id>` | One run's logs, through `gh` | A one-run spot check. A backfill or the nightly timer is an install, below |
| [`budgets/ci-health.ts`](budgets/README.md#2-the-daily-report) `--report` | The last day's runs, through `gh` | Prints a report and touches no issue. Configure its job names first |
| [`docs/docs-budget.ts`](docs/README.md), [`docs/type-coverage.ts`](docs/README.md) | Tracked files | Static reads. `type-coverage.ts` calls the repo's installed `tsc`; skip it if nothing is installed |

The baseline itself comes from GitHub's API: the guide's [read-only collection recipe](../docs/pages/13-records-evidence-of-what-ran.md#collecting-from-the-api-without-losing-runs) says how. The `ci-time.ts` spot-check lives with the [`ci-workflows`](../skills/ci-workflows/SKILL.md) skill.

## Opt-in pieces, after approval

Each changes the repo, CI, a schedule or a machine. Install one only when the plan's [authorization record](../docs/prompts/phase-3-set-targets-and-write-the-plan.md#the-authorization-record) covers it.

| Folder | What it adds |
| --- | --- |
| [`budgets/`](budgets/README.md) | Job and run budgets, the daily health report (report-only first), and an external spend watcher |
| [`docs/`](docs/README.md) | CI checks for doc byte budgets and type coverage |
| [`flakes/`](flakes/README.md) | One issue per flaky test, filed from CI, closed after clean runs. Needs an approved retry policy |
| [`local/`](local/README.md) | Tests near a local change, a machine-wide test-slot pool, the task-cache wrapper, and housekeeping timers |
| [`records/`](records/README.md) | A Vitest reporter for per-file records, the nightly collector, and the rankings. Python's own reports are covered there too |
| [`reuse/`](reuse/README.md) | Content keys and merge promotion that let a compiled component's checks be skipped when its inputs didn't change |
| [`shards/`](shards/README.md) | Time-based shards, work stealing over Actions cache claims, independent lanes, container packing |
| [`sweeps/`](sweeps/README.md) | The sweep's bisect within a budget, the release gate on what a sweep checked, and the snapshot-pin guard |

The `*.test.ts` files are each script's own `node --test` tests.
