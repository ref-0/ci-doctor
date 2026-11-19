[Guide](../README.md)

# 12. Budgets, health and spend

**Applies when:** The plan sets job or run budgets, a spend cap or a health report, or a baseline compares spend across windows. **Skip when:** None of those is proposed or measured.

- **A budget for every reachable job.** A script evaluates the workflow's expressions for a ready PR, matrices and reusable callers included. Tests fail on a reachable job with no budget, a budget for a removed job, or an oversized runner. Budgets are **measured p95 + 15%, rounded up to 5 s**, citing their source runs.
  - Raise a budget for useful work, never to silence the report.
- **Run budgets:** full PR run ≤ 5 min, small run ≤ 3 min, any ordinary shard test file ≤ 90 s (container files have their own 10-minute file timeout, section 8), and a shard p95 warning at 110 s before the 120 s billing step.
- **Start report-only.** Run the budgets and the health report against existing runs first, with no failing check and no issue writes. Record the sample count and the job legs with no data, and keep "no budget" apart from "over budget". Enforce only after a minimum sample the user picks, and turn on CI failures, issue writes and the daily schedule each with the user's yes. On forks, the report has no write permission: it reports and writes nothing.
- **A daily health report** covers the last 24 h:
  - p95 per run class, job budget overruns, shard balance, slow files, retry recoveries, scheduled failures and projected monthly spend;
  - PR runs ranked by selected test files per changed file, with the most common selection reasons. Treat a narrow change that selects most of the suite as a selector bug to investigate.
  - median and p90 queue time per runner label, from each job's creation to its start, with links to the longest waits.
  - one issue while over budget, closed when limits hold;
  - an overrun needs two observations as well as the p95, so one outlier doesn't page anyone;
  - missing API data is reported, not assumed healthy;
  - it leaves an API-call reserve for other work.
- **A spend cap, enforced, not just reported.** Start with the provider's own budget. On GitHub-hosted runners that's a GitHub Actions budget with alerts, and its stop-usage option, wherever your billing scope supports it ([GitHub's budgets](https://docs.github.com/en/billing/how-tos/set-up-budgets)). Record its scope, who can change it and what stopping does. Ours was an external watcher, because we ran on Blacksmith; it's a separate approval, since it can stop every workflow, release and recovery ones included:
  - A small service polls Blacksmith's month-to-date list-price spend every minute. On another provider it needs a spend reader of its own.
  - It warns at a threshold. When reported spend reaches the cap it **tries to stop CI: it disables workflows, cancels queued and running jobs, and checks they stayed disabled**. Billing lag, a failed usage read or a slow cancellation can leave spend past the cap, so leave headroom.
  - Before enabling one, give it an explicit allowlist of the workflows it may stop, a report-only first run, a drill of the stop and the recovery, and a documented human override.
  - It remembers which ones it disabled, so recovery re-enables exactly those.
  - A maintainer raises the cap with an issue command.
  - Keep the provider's own limit above this cap: a provider-side limit can strand jobs in queues with no explanation.
  - Alerts go through a tiny workflow in another repo posting as the Actions bot, because GitHub won't notify you about comments made with your own login.
- **Paid API calls in CI are admitted, not trusted.** Jobs that call paid model APIs go through a proxy that holds the real keys, reserves each request's *maximum* cost before forwarding it, rejects request shapes it can't bound, and settles against monthly per-provider allowances. Money is integer nano-dollars, and an unsettled reservation counts in full.
- **Price changes as a monthly projection** from measured frequency, at list price, before any discount. Per-run pennies hide the total.
- **Audit spend over comparable windows.**
  - Use equal, complete UTC windows. Label a partial window as partial, and don't claim growth from it.
  - Reconcile job renames and splits across the windows.
  - For each logical category, report job and run counts, runner size, average rounded duration and the platform's price. Price GitHub-hosted runs by each job's actual runner SKU at its verified per-minute rate, and include every attempt. Attribute only measured jobs to categories, count cache storage and other approved costs separately, and take actual spend from authorized billing reports, not the estimate.
  - Keep raw compute minutes apart from price-normalized units.
  - Read the authorized cap from the watcher's configuration (its `cap` and optional `warn`) or the approved change that set it, and fix stale docs that disagree. The health report's projection copies only the cap; name who keeps the two in sync. An audit never authorizes raising it.
  - Keep first-attempt latency and all-attempt spend as separate populations.
