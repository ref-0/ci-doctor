# Budgets: time, health and spend

What CI may take and spend, a daily report against it, and a watcher that reports, or with approval stops, CI at a monthly cap. Why each rule exists: [guide section 12](../../docs/pages/12-budgets-health-and-spend.md). The records the report reads: [guide section 13](../../docs/pages/13-records-evidence-of-what-ran.md). Runner sizes and the billing minute: [guide section 7](../../docs/pages/07-shards-runners-and-billing.md).

## Files

| File | What it does | Where it runs |
| --- | --- | --- |
| `ci-jobs.ts` | Reads your workflows without dependencies. A small YAML parser and a GitHub Actions expression evaluator. It lists every job a ready pull request can reach, with each value its `runs-on`, matrix, `include` and called workflows can take. `runnerOf` reads a Blacksmith label (`blacksmith-<n>vcpu-<platform>`) or one you add. | Imported |
| `ci-budgets.ts` | The budgets. Each job gets a p95 per runner: the measured p95 plus 15%, rounded up to 5 s (`budgetSeconds`). Runs get budgets too: full 300 s, small 180 s (examples). Test files get 90 s. A shard warns at 110 s, before the 120 s billing minute. `minimumRuns` is the fewest runs judged against a budget. Prices: Blacksmith's labels per vCPU-minute, other labels per runner minute in `runnerMinutePrices`; an unpriced label shows minutes and no dollar total. `spendCeiling` is a copy of the cap. | Imported |
| `ci-budgets.test.ts` | Fails when a job a pull request can reach has no budget, when a budget names a job that's gone, or when `runs-on` asks for more vCPUs than its budget allows. Its real-workflows test skips while `budgets` is empty. | Your normal test run (`node --test`) |
| `ci-health.ts` | The daily report. It reads the day's runs and checks them against the budgets, then writes the run's summary. With `--report` it touches no issue: start there. Without it, it keeps one issue, `CI over its budgets`, open while anything is over, and closes it once all is under. Something is over only when its p95 is past the limit and at least two runs are, and a job with fewer than `minimumRuns` runs is "too few to judge", never over. No budgets set is reported as no budgets, not as an overrun. Data it couldn't read is listed, not assumed healthy. It keeps 200 of the hour's API calls in reserve and retries after 2, 4 and 8 s. It also closes quiet flake issues (see [`../flakes/`](../flakes/)). | A scheduled workflow, daily |
| `ci-health.test.ts` | Tests for the report, the two-observation rule, the retries and the flake tallies. | Anywhere |
| `github.ts`, `zip.ts` | Small `gh` helpers, and a stored and deflated zip reader for log archives. | Imported |
| `spend-watcher/ci-spend-watcher.ts` | **Blacksmith only.** Reads Blacksmith's month-to-date list-price spend each minute and warns at a ratio of the cap. In `report` mode, the default, it only warns and tells at the cap. In `stop` mode it disables only the workflows `stop_workflows` lists, cancels their queued and running runs, and checks the stop held, reading every page. It remembers what it disabled. While stopped it re-checks every 5 minutes. It turns CI back on below the cap, after a new month or a `/cap <usd>` comment from an approver. It refuses to run until a cap is set. | A maintainer's always-on machine |
| `spend-watcher/ci-spend-watcher.service` | The systemd user unit for `watch`. | Same machine |
| `spend-watcher/ci-budget-alert.yml` | The one copy of the alert workflow. It lives in a separate alerts repo, never the watched one. It posts the watcher's alerts as `github-actions[bot]`, so the @mention notifies the maintainer, and it's in another repo so it still runs while CI is disabled. | The alerts repo |
| `spend-watcher/config.example.json` | The watcher's config, with placeholders. | Copy to `~/.config/ci-spend-watcher/config.json` |
| `spend-watcher/ci-spend-watcher.test.ts` | Drives a month with Blacksmith and GitHub faked, with a synthetic cap and warning. Run it with `node --test spend-watcher/ci-spend-watcher.test.ts`. | Anywhere |

## Wire it in

Each part is its own approved change, set up after the user approves the plan ([ci-doctor, "Before approval"](../../skills/ci-doctor/SKILL.md#before-approval-read-only)). Start every part in report-only mode against existing runs.

### 1. Budgets

1. Copy `ci-jobs.ts` and `ci-budgets.ts`, and set `CONFIG` in `ci-budgets.ts`: your workflow's path, its job names, the matrix and reusable callers.
2. Set the runner prices: `runnerMinutePrices` for each GitHub-hosted or self-hosted label you use, from the provider's pricing page with the date. `otherRunners` maps labels that aren't Blacksmith's to their vCPUs and platform.
3. Run `ci-budgets.test.ts` with `budgets` empty. Its fixture tests pass, and its real-workflows test skips.
4. Run the daily report with `--report` for a while. It lists each job leg it found, with its sample count. Pick the sample you'll trust as `minimumRuns`, and wait until each leg you'll budget has it.
5. Fill `budgets` from those runs. `exampleBudgets` shows the shape. Measure each leg as the file header says (GitHub's API, or `blacksmith jobs aggregate` on Blacksmith), and note in a comment which runs it came from. Once `budgets` holds one entry, the real-workflows test requires a budget for **every** job a ready PR can reach, so measure them all first, including legs that rarely run.
6. The real-workflows test reads `../../.github/workflows/`, so change that path if you move the folder.

### 2. The daily report

Copy [`templates/github/workflows/ci-health.yml`](../../templates/github/workflows/ci-health.yml). Its shape:

```yaml
# .github/workflows/ci-health.yml (sketch)
name: CI health
on:
  schedule:
    - cron: '17 7 * * *'
  workflow_dispatch:
permissions:
  actions: read
  contents: read
  issues: write # used only once CI_HEALTH_ISSUES is true
jobs:
  health:
    runs-on: <runner-label>
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          # setup-node turns pnpm caching on when package.json names pnpm, then fails without it.
          package-manager-cache: false
      - run: node scripts/budgets/ci-health.ts ${{ vars.CI_HEALTH_ISSUES != 'true' && '--report' || '' }}
        env:
          GH_TOKEN: ${{ github.token }}
```

Set `CONFIG` in `ci-health.ts` to match your workflow: its path, the plan and shard job names, the shard log names, and your sweep and slice run titles. These are display names and run titles, so a renamed job or title silently drops its category: before you turn on issue writes, read one `--report` summary and check every category you expect has runs. To try the issue path locally, run `GITHUB_REPOSITORY=<org>/<repo> node scripts/budgets/ci-health.ts --report --scale 0.5`. `--report` touches no issue. `--times <results.json>` adds a local Vitest results file to the file budget.

Ask the user before you set `CI_HEALTH_ISSUES` to `true` (issue writes and closes), before any budget fails CI, and before the daily schedule starts. On a fork, or any run whose token can't write issues, keep `--report`.

### 3. The spend watcher

**First, use your provider's own budget.** On GitHub-hosted runners, set a GitHub Actions budget with its alerts wherever your billing scope supports it ([GitHub's budgets](https://docs.github.com/en/billing/how-tos/set-up-budgets)), and record its scope, who can change it, and what "stop usage" does to running work. That needs no machine, no second repo and no write rights.

The watcher here reads Blacksmith's spend. On another provider it needs a spend reader for that provider's billing API first. It's a separate approval, and it starts in `report` mode, which only warns and tells at the cap. `stop` mode disables workflows, so it can stop release, security or recovery work: turn it on only with the user's yes, an explicit `stop_workflows` list that leaves those out, a drill (set a cap under this month's spend, see the stop and the alert, then raise the cap and see CI come back), and a documented human override (`ci-spend-watcher enable`, or re-enabling a workflow by hand).

**What the cap guarantees.** The watcher tries to stop CI when the reported spend reaches the approved cap. Billing lag, a failed usage read and cancelling all take time, so spend can end above the cap: leave headroom between the cap and what you can afford. The authoritative cap and warning live in the watcher's `config.json`. Copy only the cap into `spendCeiling` in `ci-budgets.ts`, for the daily projection; whoever changes one changes the other.

It needs Linux (or another Unix), Node 24, and a systemd user manager. On another OS, run `watch` under its own scheduler. The unit finds `node` on its own `PATH`, `~/.local/bin:/usr/local/bin:/usr/bin:/bin`: if yours comes from a version manager, add its directory to the unit's `Environment=PATH`.

1. **Logins, done by the maintainer, never by an agent.** On the machine:
   - Install Blacksmith's CLI (`curl -fsSL https://get.blacksmith.sh | sh`, or see [Blacksmith's docs](https://docs.blacksmith.sh/blacksmith-cli/overview)), log in with `blacksmith auth login`, and check that `blacksmith auth status` and `blacksmith usage` show the org.
   - `gh auth login` as a maintainer, then `gh auth status`. For `report` mode the account needs issue write and workflow dispatch on the alerts repo. For `stop` mode it also needs Actions write on every watched repo, to disable workflows and cancel runs.
2. Put `ci-budget-alert.yml` in `<org>/<alerts-repo>`'s `.github/workflows/`, and set its `runs-on`. This folder holds its only copy. Uploading a workflow file over HTTPS with a classic token needs its `workflow` scope.
3. Copy `config.example.json` to `~/.config/ci-spend-watcher/config.json`. Fill in the repos, approvers, `cap` and `warn` as numbers (`warn` defaults to 85% of `cap`). Keep `mode: "report"`. For `stop`, list the workflow files to stop in `stop_workflows`.
4. Run `node ci-spend-watcher.ts install`. It makes the script executable, links it as `~/.local/bin/ci-spend-watcher`, checks that `node` is on the unit's `PATH`, installs and starts the unit, enables lingering, and fails unless the link is executable and the service is active. Then run `ci-spend-watcher check`. Keep the script's executable bit (mode 755) when you commit it.
5. Set Blacksmith's own spend limit a little above `cap`. Past that limit every job queues with no runner and nothing says why, so this watcher should stop CI cleanly first.

The watcher never reads a token itself. It uses the CLIs' own logins.

## Placeholders

| Placeholder | Where | What to put |
| --- | --- | --- |
| `<org>`, `<repo>` | `config.example.json`, commands above | Your GitHub owner and the repo CI runs in |
| `<alerts-repo>` | `config.example.json`, `ci-budget-alert.yml` | A second repo that holds the alert workflow and the budget issue |
| `<workflow-file-to-stop>` | `config.example.json` `stop_workflows` | The workflow files `stop` mode may disable, e.g. `ci.yml`. Never release, security or recovery workflows |
| `<maintainer-login>` | `config.example.json` | Who may approve a new cap with `/cap <usd>` and gets the @mention |
| `<monthly-cap>`, `<monthly-warning>` | `config.example.json` (authoritative); the cap alone copied to `spendCeiling` in `ci-budgets.ts` | The user's monthly cap and warning in USD, as numbers. There is no default. |
| `<runner-label>` | `ci-budget-alert.yml`, the health workflow | Any runner your org allows; the smallest is enough |
| `pricePerMinute`, `runnerMinutePrices` | `ci-budgets.ts` | Blacksmith's list price per vCPU-minute when this was written, and your other labels' per-runner prices. Check the current prices. |
| `exampleBudgets` | `ci-budgets.ts` | Illustrative numbers that show the shape. Replace them with your own measurements. |
