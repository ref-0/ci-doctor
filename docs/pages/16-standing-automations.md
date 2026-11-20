[Guide](../README.md)

# 16. Standing automations

Choose which repeated follow-ups run on a schedule, whether CI, an agent or a machine runs each, and what each may do.

**Applies when:** A repeated, read-only or deterministic follow-up would otherwise be done by hand, and the user says yes to its schedule. **Skip when:** The user hasn't said yes: a manual, read-only follow-up is the default.

Each row says how it runs, because these are four different things: *CI* is a script-only GitHub Actions cron or dispatch, with no model; *agent* is a scheduled agent task in a harness, a cloud job or a session loop, which spends model usage as well as any runner minutes; *machine* is a timer or service on a host. Prefer a script for anything deterministic. Every schedule is opt-in and needs the user's yes; until then, a manual read-only follow-up is the default. For each one, name who checks its first eligible result and what happens if no run starts.

| Cadence | Job | What it does |
|---|---|---|
| Daily (CI) | Health report | Budgets, shard balance, slow files, retries and spend projection, kept in one issue |
| Daily or weekly (agent) | **Runner review** | Each job's CPU and memory over its runs since the last review, against its runner's size. Proposes a smaller runner for a job that stays well under its CPU, a bigger one for a job near its memory limit or CPU-bound on the critical path, and a shard-count change when the runner changes. Daily when PRs land often enough that each job has a fair sample every day; weekly otherwise. It only proposes: a resize needs the user's yes. [`ci-runners`' sizing](../../skills/ci-runners/references/sizing.md#reviewing-sizes-on-a-schedule) |
| Daily (CI) | Main sweep + 3 server runs | Section 5. Merges make up for late cron. |
| Daily (CI) | Latest external tools | The newest versions of external tools we integrate with, run against our latest release, without packing a snapshot. One compatibility issue. |
| Daily (CI) | Infra drift | Read-only diff of production resources against applied state. One issue per stage, closed only when all are in sync. |
| Every 2 h (CI) | Startup watch | Worker startup time from build logs, warning well before the platform's hard limit |
| Weekly (CI) | Load baseline | Runs only if the deployed server changed since the last passing baseline |
| Three times a week (agent) | **Slow tests and flakes** | The campaign in section 15, end to end. Its guardrails are below. |
| Every 2 weeks (agent) | **Docs drift sweep** | Section 17 |
| Weekly (agent) | PR-time re-measure | Where engineers' PR time actually goes, using Phase 2's delivery-interval fields. CI waits were a small share of PR-hours; questions and approvals were far larger, so we optimize the real constraint. |
| Weekly (agent) | Review-value check-in | Review escapes ("Caused by #n" PRs) and whether the cut-down review still catches enough |
| Weekly (agent) | Skills/memories review | Agent memories get folded into skills or deleted |
| Nightly (machine timer) | CI-records collector | Section 13 |
| Weekly / every 6 h (machine timers) | Rust target sweep, temp sweep | Section 14 |
| Always on (machine service) | Spend watcher | Section 12 |
| One-off, at merge (agent) | Follow-up check | Every change that only main can exercise (a new cron, a sweep-only proof, a cache) gets a check scheduled for the time of its first run, to read the result |
| Daily, optional (agent) | Agent-spend audit | Coding and review model usage, tracked separately from CI-provider spend |
| Monthly, optional (agent) | Merged-PR throughput | Merged PRs per day, compared over matched reporting windows |

We also ran a **weekly CI audit** for a while. It covered spend by job against last week, shard files over 90 s, runner CPU over 3+ runs, which PR runs selected everything and why, sweep failures the PR run should have caught, failed-then-passed tests, and monthly co-change pairs. It's paused now that the health report, the campaign and the runner review cover it.

**The slow-tests run's guardrails:**

- *May,* within the plan the user approved: speed up tests, split files, turn test-only waits into settings, fix flakes and the bugs they reveal, carry out tier and selection changes the user already approved, update the skills and file issues.
- *Never, but propose:* new tier or coverage changes (moving a test to covered-only or the sweep, narrowing selection), new recurring CI spend or scheduled jobs, enabling macOS, re-enabling a workflow the spend watcher disabled, deleting data, touching production or tokens, widening a production API for a test. Stop at the first action outside the approved scope.
- *Never at all:* retries, timeout-only fixes or skipped tests. No Docker or full local CI.
