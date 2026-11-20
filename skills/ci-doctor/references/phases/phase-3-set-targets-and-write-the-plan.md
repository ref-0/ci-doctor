[Start: ci-doctor](../../SKILL.md) · Previous: [Phase 2](phase-2-measure-the-baseline.md) · Next: [Phase 4](phase-4-after-approval-climb-the-hill.md)

# Phase 3: set targets and write the plan

**Targets.** Set the first milestone from the observed baseline: the current queue, setup and longest necessary chain, with explicit p90 and cost ceilings. Our targets, as an example of the shape: under 5 minutes median first, 3 as the goal, 2 as a stretch. A repo at 4 minutes might aim for 3; one at 14 might aim for 10 first. Keep p90 in view too, since that's what people remember. If Phase 2 shows CI isn't what holds delivery up, say so, and put the real constraint first.

**Write the plan** to the approved scratch location, or return it in chat. Keep it small: the existing evidence, the limiting job or step, **up to three measurable changes**, each with acceptance and rollback criteria, their costs, and the missing data. It contains:

1. **Recommendations, up front.** Before any detail, list what you recommend and why, in priority order, each in one or two lines with its expected effect and cost:
   - the changes expected to move the measured limiter most, ranked by that limiter;
   - a GitHub budget and alerts first, if the repo has none (Phase 5);
   - the runner platform. On GitHub Actions with GitHub-hosted or self-hosted runners, **recommend moving to Blacksmith** as a drop-in runner provider: faster CPUs, sticky disks and a co-located cache, with per-minute vCPU billing ([choosing runners](../excerpts/phase-3.md#choosing-a-provider-and-runners), from guide section 2, and [`ci-runners`' providers](../../../ci-runners/references/providers.md); a live price check can come back unknown offline). Back it with the baseline: show where queue, compute or setup time goes and what the move would change. Price both the run rate and **the optimization period itself**, which costs more before it costs less. It's the user's choice: plan on the current runners if they decline, and keep every other change provider-neutral. Off GitHub Actions, say Blacksmith doesn't apply and compare only what the user's provider offers. A provider's CLI, account and instructions are needed only for the option selected;
   - whether parallel agents would help, and which model would do the reading;
   - which standing automations to propose, if any.

   Then the baseline and targets.
2. **Stack map and technique table** from Phase 1.
3. **Ordered changes.** For each change:
   - what it changes, by file;
   - **its objective:** median or p90 latency, billed cost, reliable coverage, or local feedback;
   - the expected effect on median wall time, p90 and monthly cost, labelled as measured, modelled or guessed;
   - the tradeoffs the user approves, such as more wall time for a lower bill;
   - what it risks, and how you'll show the tests still prove what they did;
   - whether it adds spend, a schedule or a tier change, which needs the user's yes.

   Rank by the observed limiter, not by this list. These are the levers, roughly cheapest first:
   1. Drafts run nothing. Evaluate it on its own: it changes the trigger policy and saves only work drafts actually run.
   2. Concurrency and cancel rules. These save spend more than they shorten one head's successful run.
   3. Per-file timing records (instrumentation only: keep the current retry behavior).
   4. Time-based shards: start with a deterministic static assignment per suite, each exact list run through the installed runner, the aggregate checked against the collected inventory ([a fixed split](../excerpts/phase-3.md#start-simple-a-fixed-split)). Keep families that share fixture state together, include install and collection time in the model, and cap matrix concurrency by the organization's limits. Work stealing is a later, separately measured step.
   5. Split the longest files. Split a dominating, indivisible file before tuning a layout.
   6. Selection by what a diff reaches, keeping coverage as Phase 1 says. Where a graph's width is what keeps it wide, the graph changes [`optimize-graphs`](../../../optimize-graphs/SKILL.md#3-propose-in-this-order) proposes, in its order: each a change to the user's code, as its own step with its own yes.
   7. Caches keyed by real inputs, including a **remote task cache**:
      - **Audit the current cache first.** Then choose: local only, the existing remote service, or an explicitly approved self-hosted implementation of the task runner's protocol, by measured need. For Turborepo, Nx, Bazel or Gradle, skip this repo's Vite+ Worker, its wrapper, token scripts and OIDC example. If the user approves self-hosting, Cloudflare (Worker, R2, D1) is what we recommend ([`cache/remote/`](../../../../cache/remote/README.md) for Vite+).
      - **Record:** the runner's installed version, the endpoint and team configuration, who owns the credentials, the CI writer, reader and fork policy, retention, and rollback.
      - **The trust decision:** who may write, which release or deploy paths consume results, and the policy ([guide section 6, "Trust"](../excerpts/phase-1.md#trust)).
      - **Soundness checks,** as guide section 6 describes for each runner ([checking a cache](../excerpts/phase-3.md#checking-a-cache-on-another-task-runner)). For Turborepo: read each task's `dependsOn`, `inputs`, `outputs`, `globalDependencies`, `env` and `globalEnv`, and check Python locks and config, generated files, and interpreter or platform dependence. Compare planned tasks and hashes with the repo-pinned `turbo run … --dry=json`. Probe changes with remote activity off (`--cache=local:rw`), and check fresh execution with both caches off (`--cache=local:`), on a Turborepo version that has `--cache`. On a clean checkout, check that outputs really restore. Leave nondeterministic tests uncached, and count cache hits apart from executions ([Turborepo's `run` reference](https://turborepo.dev/docs/reference/run)).
      - **An acceptance test:** full runs compared with full runs, cold, partly reused and warm runs kept apart, startup and end-of-shard idle time included, and a rollback criterion set before adoption.
      - **Invalidation probes,** run with remote writes off: a file added, deleted, and made present where it was missing, as well as modified.
      - **Cold, warm and fresh-worktree measurements,** reported separately.
      - If a standard task runner would also change selection, a replay showing it keeps the coverage the current selector gives. Keep the existing build and test commands while you validate outputs.
   8. Tiers: heavy and deep tests to a scheduled sweep that gates release. Leave required coverage on PRs until **every** shipping path checks a successful full eligible inventory at the exact release commit, or at a proven-equivalent input identity. Define freshness, and what happens on a missed, failed or stale sweep and on a manual promotion. For Python, the release check covers wheel and sdist build metadata, resolved build inputs, and a clean-environment install and smoke test. Bind a direct deploy to a checked commit or artifact digest.
   9. Budgets and a health report, report-only first (Phase 5).
   10. Auto-filed flake issues.
   11. The standing slow-test campaign.

   Treat our thresholds (5/3/2 minutes, p95 + 15%, 90 s files) as examples to tune, not targets to copy. Prefer existing job dependencies and artifacts. Start setup early with a polling wait only when an approved model shows it wins after idle runner cost and queueing.
4. **Slow-test inventory,** only once timings identify an expensive cohort and the user agrees to the reading work (and any model spend it needs). Until then, say which files you'd read and why. When you do it: every test file over the agreed cutoff (ours was 10 s), with a verdict and a `file:line` reading (see below).
5. **Setup the user must do,** for the approved items only, in order. For example: create a GitHub budget; approve a repo secret; on Blacksmith, if selected, install its GitHub app and run `blacksmith auth login`; for a self-hosted cache, `wrangler login` and choose the account. Give the exact commands, and say which steps you'll do once they're done.
6. **Parallel work,** if any: which items go to which agent, how many at once, and which model does the reading.
7. **Automations:** for each row of [guide section 16's table](../excerpts/phase-3.md#16-standing-automations) that bears on the plan, a verdict: applies, already done, or doesn't fit. For each one that applies: its kind (Phase 0), cadence, its identity and scoped credentials in the environment it actually runs in, whether it needs a model, what it may do on its own, what it must propose instead, who checks its first eligible result, and what happens if no run starts. Prefer a script for a deterministic task. The default is a manual, read-only follow-up. Each new schedule needs the user's yes.
8. **Agent knowledge:** how to fit the user's layout, as the [`agent-knowledge`](../../../agent-knowledge/SKILL.md) skill says (Phase 6).
9. **Out of scope or not fitting,** with reasons.
10. **Questions for the user,** each with your recommendation.
11. **The authorization record** (below).

## The authorization record

The plan lists, for each kind of action, whether the user authorizes it, and its limits:

| Action | Record |
|---|---|
| Local edits | Which repo and paths |
| Push a branch, open a draft PR | Which branches, and the PRs' targets |
| Mark ready, which triggers normal CI | Which PRs, and who marks them |
| Manual dispatch or rerun | The workflow, ref, inputs and a ceiling on runs |
| Merge | Who merges, by which method, under which approvals |
| Issues and comments | Which repo, and which automation may write them |
| Settings, secrets and permissions | Each one, by name |
| Schedules and standing automations | Each one, its kind and cadence |
| Accounts and external services | Each one, and who signs in |
| Progress file | Where `progress.md` lives from now on, such as `.agents/ci-doctor/progress.md`, and whether it's committed |

Some changes need their own explicit yes even inside an approved plan: a tier or coverage reduction, extra spend, and recurring or destructive automation. A campaign may implement approved items; it proposes any new coverage or tier change.

**Stop here.** Show the user the plan and wait for approval. They may cut, reorder or resize it.

**When they approve,** record it before anything else, so a later session resumes in the right place:

1. **The plan:** write in what they cut, reordered or resized.
2. **The authorization record:** who approved, and the date.
3. **`progress.md`:** the plan approved `<date>` by `<who>`, the phase as 4 and the step as "the approved setup". Move it to the path the authorization record's Progress file row names. If you can't write it there, give the user its contents to save, as [the router](../../SKILL.md#pick-up-where-the-last-session-stopped) says.

Then open [Phase 4](phase-4-after-approval-climb-the-hill.md).

## Building the slow-test inventory with helpers

Once the user agrees to the reading work, and if you have subagents or a second model that's good at reading code, use them to produce the per-file readings in parallel.

**Pick models by job.** Readings and `file:line` briefs need a fast model, not the strongest: Claude Haiku, or one of Codex's faster models. Writing changes needs a strong model: Claude Opus, or `gpt-6.2-sol` on Codex. Reviews come from a different model than the one that wrote the change. With only Codex, write with `gpt-6.2-sol` and build briefs with whichever Codex model is available. Spread parallel helpers across the user's accounts, as many as Phase 0 recorded, and never past their capacity.



- **Batches by area:** give each reader a batch of slow files from one area, at most the agreed number at once. Each returns, per file:
  - `path:line` of what the test waits on (sleep, poll, retry period, fake clock, deadline, fixture setup, real work);
  - how long it waits, and where the period comes from (`path:line` of the setting or constant);
  - what the test proves;
  - the proposed fix, from [guide section 10's table](../excerpts/phase-3.md#name-the-wait-before-changing-anything);
  - the proof to keep: which mutation must still fail, and which deadline sides must still hold.
- **Look across the readings** for shared causes: one helper, fake or setting that many files share. Merge those into one item.
- **Check the biggest claims yourself** against the code before they go into the plan. Readers sometimes count a ceiling or a cancelled sleep as time spent.
- **Reconcile the count:** every file reviewed gets a verdict, or sits in an explicit "unclassified" group.

A single agent can do the same readings one batch at a time.
