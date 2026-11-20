[Guide](../README.md)

# 16. Standing automations

**Applies when:** A recurring read-only or deterministic follow-up would otherwise be run by hand, and the user approves its schedule. **Skip when:** The user hasn't approved a schedule—a manual, read-only follow-up is the default.

Each row below labels how it runs, because these are distinct mechanisms:
- **CI:** a script-only GitHub Actions cron or dispatch (no model usage);
- **agent:** a scheduled agent task in a harness, cloud job, or session loop (spends model usage plus any runner minutes);
- **machine:** a timer or service running on a host.

Prefer a plain script for anything deterministic. Every schedule is opt-in and requires user approval; until then, default to manual read-only checks. For every scheduled job you enable, name who reviews its first eligible result and what happens if it fails to start.

| Cadence | Job | What it does |
|---|---|---|
| Daily (CI) | Health report | Budgets, shard balance, slow files, retries, and spend projection, updated in a single issue |
| Daily or weekly (agent) | **Runner review** | Compares each job's CPU and memory since the last review against its runner size. Proposes downsizing jobs that stay well under their CPU, upsizing jobs near memory limits or CPU-bound on the critical path, and adjusting shard counts when runner sizes change. Run daily when PR volume yields a fair sample each day; weekly otherwise. Proposes only—every resize needs user approval ([`ci-runners` sizing](../../skills/ci-doctor/references/ci-runners/references/sizing.md#reviewing-sizes-on-a-schedule)). |
| Daily (CI) | Main sweep + 3 server runs | Section 5. Merges make up for late cron runs. |
| Daily (CI) | Latest external tools | Tests the newest versions of integrated external tools against our latest release without packing a snapshot, tracked in one compatibility issue |
| Daily (CI) | Infra drift | Read-only diff of production resources against applied state; one issue per stage, closed only when all are in sync |
| Every 2 h (CI) | Startup watch | Reads Worker startup time from build logs and warns well before the platform's hard limit |
| Weekly (CI) | Load baseline | Runs only when the deployed server changed since the last passing baseline |
| Three times a week (agent) | **Slow tests and flakes** | Runs the end-to-end campaign from section 15, within the guardrails below |
| Every 2 weeks (agent) | **Docs drift sweep** | Section 17 |
| Weekly (agent) | PR-time re-measure | Tracks where engineers' PR time actually goes using Phase 2's delivery-interval fields. CI waits were a small share of PR-hours—questions and approvals were far larger—so this keeps us optimizing the real bottleneck. |
| Weekly (agent) | Review-value check-in | Audits review escapes ("Caused by #n" PRs) to verify the streamlined review still catches enough |
| Weekly (agent) | Skills/memories review | Folds useful agent memories into skills and deletes stale ones |
| Nightly (machine timer) | CI-records collector | Section 13 |
| Weekly / every 6 h (machine timers) | Rust target sweep, temp sweep | Section 14 |
| Always on (machine service) | Spend watcher | Section 12 |
| One-off, at merge (agent) | Follow-up check | Any change exercised only on `main` (new cron, sweep-only proof, cache) gets a one-off check scheduled at its first run to inspect the result |
| Daily, optional (agent) | Agent-spend audit | Tracks coding and review model spend separately from CI-provider spend |
| Monthly, optional (agent) | Merged-PR throughput | Tracks merged PRs per day across matched reporting windows |

We also ran a **weekly CI audit** for a while—covering spend by job vs. the prior week, shard files over 90 s, runner CPU across 3+ runs, PR runs that selected everything and why, sweep failures PRs should have caught, failed-then-passed tests, and monthly co-change pairs. It is paused now that the health report, slow-tests campaign, and runner review cover the same ground.

**Guardrails for the slow-tests agent:**

- **May (within the user-approved plan):** speed up tests, split files, turn test-only waits into settings, fix flakes and the bugs they expose, execute already-approved tier and selection changes, update skills, and file issues.
- **Never do—only propose:** new tier or coverage changes (moving tests to covered-only or sweeps, narrowing selection), new recurring CI spend or scheduled jobs, enabling macOS, re-enabling a workflow disabled by the spend watcher, deleting data, touching production or tokens, or widening a production API for a test. Stop immediately at the first action outside approved scope.
- **Never at all:** add retries, apply timeout-only fixes, skip tests, or run Docker or full local CI.
