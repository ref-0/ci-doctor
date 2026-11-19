<!--
What: a check that CI's spend is budgeted at list price, and that a spend watcher, where the user approved one, really stops CI at the cap.
Where: read by whoever plans work that runs CI, and by an agent checking the watcher.
Configure: <monthly-cap>, a warning below it, and the Spend watcher section of `.agents/repo/ci.md`: its deployment, watched repos and workflows, spend source and units, freshness cutoff, status command (<budget-watcher>) and the person who stops and recovers.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Budget CI at list price, and prove the guard stops it

**Moment:** running the work · **Concern:** cost

## Check

- [ ] The plan budgets ready-PR runs, runs by hand and `main`'s scheduled sweeps.
- [ ] The month's spend and the budget are compared with `<monthly-cap>` at list price, before free minutes.
- [ ] The provider's own budget and alerts are set where its billing supports them. An external watcher that disables workflows runs only once the user approved it, with an allowlist of the workflows it may stop and a report-only first period.
- [ ] The spend reader includes every page and refuses a missing or incomplete reading.
- [ ] The watcher's service is alive and its last spend reading is newer than the freshness cutoff ci.md names.
- [ ] A reported stop has disabled every allowlisted workflow, read across every page of the workflow list, and no run is left queued, in progress, waiting, pending or requested, read across every page of each status; failed stops are retried.

## How

- Run the status command ci.md's Spend watcher section names (`<budget-watcher> check`) and read its service's state and last reading. Set a warning below `<monthly-cap>`. Keep the CI provider's own spend limit above the watcher's cap, so an alert can still run. The watcher acts on reported spend: billing lag, a failed read and cancellation delay can carry spend past the cap, so leave headroom.
- After a stop, confirm every allowlisted workflow reads disabled with `gh workflow list --repo <org>/<repo> --all --limit 1000`, and that no run is left: `gh run list --repo <org>/<repo> --status <status> --limit 1000` for each of `queued`, `in_progress`, `waiting`, `pending` and `requested`, every watched repo. Never re-enable a workflow it disabled: the person ci.md names authorizes a cap change and the recovery.
- Check a watcher is alive by its own heartbeat or service manager, never with `pgrep -f <name>`, which can match itself.
- Pricing a run, and measuring a change to runners, shards or job layout, is the check [measure CI before changing it](ci-measure-before-changing-it.md). Record each plan's budget and actual spend.

## Why

In the source repo:

- Early on, four status updates claimed a dead watcher was running, because `pgrep -f` matched itself.
- Days later, two plans' budgets omitted `main`'s runs, while a spend script read net prices about a fifth under the provider's list price.
- A restart then removed the spend script, and its guard carried on with an empty value. The rebuilt reader took only the first page of runs and printed well under the real spend.
- That afternoon, the watcher logged a stop at the cap without disabling anything, and spend went past the cap before its next check, much later.

## Pointed at from

- [`ci-runners`](../ci-runners/references/billing.md#the-spend-cap), the spend cap, and [`blacksmith`](../blacksmith/references/billing.md) if you run on Blacksmith.
- The repo's `.agents/repo/ci.md`, its Spend watcher section.
- [Measure CI before changing it](ci-measure-before-changing-it.md).
