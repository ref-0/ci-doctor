[Guide](../README.md)

# 12. Budgets, health and spend

**Applies when:** The plan sets job or run budgets, a spend cap, or a health report, or a baseline compares spend across windows. **Skip when:** None of those is proposed or measured.

- **Budget every reachable job.** A script evaluates workflow expressions for a ready PR—including matrices and reusable workflow callers. Tests fail if any reachable job lacks a budget, if a budget exists for a removed job, or if a runner is oversized. Set each job's budget to **measured p95 + 15%, rounded up to 5 s**, citing its source runs.
  - Raise a budget only for legitimate added work, never to silence the report.
- **Target run budgets:** full PR run ≤ 5 min, small run ≤ 3 min, any ordinary shard test file ≤ 90 s (container files have their own 10-minute file timeout, section 8), and a shard p95 warning at 110 s—just below the 120 s billing step.
- **Roll out report-only first.** Run budget checks and the health report against existing runs with no failing checks and no issue writes. Record sample counts and any job legs lacking data, keeping "no budget" distinct from "over budget." Turn on enforcement only after a user-chosen minimum sample, and turn on CI failures, issue writes, and the daily schedule **each** with the user's explicit approval. On forks, the report lacks write permissions and remains read-only.
- **Publish a daily health report** covering the trailing 24 hours:
  - p95 duration per run class, job budget overruns, shard balance, slow files, retry recoveries, scheduled failures, and projected monthly spend;
  - PR runs ranked by selected test files per changed file alongside the most common selection reasons—treat a narrow change that selects most of the suite as a selector bug;
  - median and p90 queue time per runner label (job creation to start), linking to the longest waits;
  - one tracking issue while over budget, closed once limits hold;
  - require two observations plus the p95 breach before flagging an overrun so a single outlier doesn't page anyone;
  - report missing API data explicitly rather than treating it as healthy;
  - preserve an API-call reserve for other automation.
- **Enforce a spend cap—don't just report it.** Start with your provider's native budget. On GitHub-hosted runners, configure a GitHub Actions budget with alerts and its stop-usage option wherever your billing scope supports it ([GitHub's budgets](https://docs.github.com/en/billing/how-tos/set-up-budgets)); record its scope, who can edit it, and what stopping does. Because we ran on Blacksmith, we built an external watcher—approve one separately, since it can halt every workflow including releases and recovery:
  - a small service polls Blacksmith's month-to-date list-price spend every minute (other providers need their own spend reader);
  - it alerts at a warning threshold, and when reported spend reaches the cap it **tries to stop CI: it disables workflows, cancels queued and running jobs, and verifies they stayed disabled** (leave headroom because billing lag, failed reads, or slow cancellations can still let spend overshoot);
  - before enabling it, define an explicit allowlist of stoppable workflows, run it report-only first, drill both stopping and recovery, and document the human override;
  - it records exactly which workflows it disabled so recovery re-enables only those;
  - a maintainer can raise the cap via an issue command;
  - keep the provider's own spend limit *above* your watcher's cap so provider limits don't strand jobs silently in queues;
  - route alerts through a tiny workflow in another repo posting as the Actions bot, because GitHub suppresses notifications for comments posted under your own account.
- **Gate paid model API calls in CI.** Jobs calling paid model APIs route through a proxy that holds the real keys, reserves each request's *maximum* possible cost before forwarding, rejects unbounded request shapes, and settles against monthly per-provider allowances. Track amounts in integer nano-dollars, counting any unsettled reservation at its full maximum.
- **Price every change as a monthly projection** using measured run frequency at list price before discounts—per-run pennies obscure the monthly total.
- **Audit spend over comparable windows:**
  - use equal, complete UTC windows; label any partial window as partial and don't claim growth from it;
  - reconcile job renames and splits across windows;
  - for each logical category, report job and run counts, runner size, average rounded duration, and platform price. Price GitHub-hosted runs by each job's actual runner SKU at its verified per-minute rate across all attempts. Attribute only measured jobs to categories, track cache storage and other approved costs separately, and take actual spend from authorized billing reports rather than estimates;
  - keep raw compute minutes distinct from price-normalized units;
  - read the authorized cap from the watcher's config (`cap` and optional `warn`) or the approved change that set it, and fix any stale doc that disagrees. Because the health report's projection copies only `cap`, name who keeps the watcher config and health report in sync. An audit never authorizes raising the cap;
  - keep first-attempt latency and all-attempt spend as separate populations.
