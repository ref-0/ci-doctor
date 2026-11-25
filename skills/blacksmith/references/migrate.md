<!--
What: moving a repo's GitHub Actions from GitHub-hosted or self-hosted runners to Blacksmith, step by step.
Where: read by an agent planning or doing the move, after the user agreed to it.
Configure: your org (<org>) and each job's current runner.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Moving from GitHub-hosted or self-hosted runners

Part of the [`blacksmith`](../SKILL.md) skill. The move changes spend and the runner platform, so it needs the user's yes first, as a plan item with a monthly projection ([`ci-runners`' providers](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-runners/references/providers.md#choosing)). Blacksmith's own [quickstart](https://docs.blacksmith.sh/introduction/quickstart) has the current steps.

1. **Measure first:** median and p90 wall time, queue time, minutes by job, and each job's runner, from the plan's baseline ([the guide's collection](https://ci-doctor.ref0.dev/guide/docs/pages/13-records-evidence-of-what-ran.md#collecting-from-the-api-without-losing-runs)). [`ci-time.ts`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-workflows/references/tools.md#measuring-a-run) is a spot check, not the baseline.
2. **The user installs the Blacksmith GitHub app** on the organization and chooses its repos. It works for organizations, not personal accounts. An org with an IP allowlist adds Blacksmith's addresses.
3. **Set the spend limit and your watcher first** ([billing](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/blacksmith/references/billing.md)).
4. **Swap labels, job by job, at today's size:** `ubuntu-latest` becomes `blacksmith-2vcpu-ubuntu-2404`, a 4-core larger runner `blacksmith-4vcpu-ubuntu-2404`, and so on; the [templates' README](https://github.com/ref-0/ci-doctor/blob/v0.4.0/templates/github/README.md#runner-labels) has the map. Blacksmith's dashboard also has a migration wizard that edits the workflow files.
5. **Leave cache actions as they are.** `actions/cache` and `Swatinem/rust-cache` use Blacksmith's cache unchanged. For Docker builds, Blacksmith's own builder actions replace `docker/setup-buildx-action` and `docker/build-push-action`, without `cache-from` and `cache-to`.
6. **Compare like runs:** the same workflows over the same kinds of PRs, at like hours. Keep or revert on the agreed objective.
7. **Then resize from measurements,** only when three runs agree ([sizing](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-runners/references/sizing.md)), and choose a small runner for small selections.
8. **Move setup onto sticky disks** once the job graph is stable ([disks](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/blacksmith/references/disks.md)), keeping one job that installs with the lockfile check on.
