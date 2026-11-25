<!--
What: this skill's scripts, ci-time.ts and sweep-cadence.ts: what ci-time.ts measures, its settings, and how to run them.
Where: read by an agent before it measures a run with ci-time.ts, or runs either script.
Configure: `.agents/repo/ci-time.json`, from the agent-knowledge skill's templates/repo-facts/ci-time.json.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The tools

Part of the [`ci-workflows`](../SKILL.md) skill: what `ci-time.ts` measures and leaves out, and how to run it and `sweep-cadence.ts`. Read it before you measure a run with `ci-time.ts`, or run either script.

## Measuring a run

[`scripts/ci-time.ts`](../scripts/ci-time.ts) is a spot check of the newest runs' latest attempts, from GitHub's jobs API: started minutes and vCPU-minutes by job and by event, each run's checks span and time to the gate, the job that ended last, and the slowest file lines in the newest large run's shard logs. Its help says exactly what each number is and leaves out. The job that ended last isn't proof of the limiter, and its file times may come from a replay. It isn't a baseline or a spend audit: those page a closed window and read every attempt, as [CI history data](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/speed-up-tests/references/ci-history-data.md) says.

It estimates vCPU-minutes from runner labels, as the `runners` setting maps them, and money only when `prices` prices every label. With `--bill blacksmith`, on Blacksmith only, it takes billed minutes from [Blacksmith's adapter](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/blacksmith/scripts/blacksmith-bill.ts), found beside this skill or passed with `--adapter-dir`. Pass `--repo`, `--workflow` and a `--shard` for each sharded job, as ci.md names them, or set them in the repo's `.agents/repo/ci-time.json` ([template](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/agent-knowledge/templates/repo-facts/ci-time.json)). Its tests run with this skill installed alone: `node --test ci-time.test.ts`, from `scripts/`.

Where CI's records are and how to read them is `speed-up-tests`' [measuring](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/speed-up-tests/references/measuring.md). Judging what a number means is the [`prove-it`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/prove-it/SKILL.md) skill.

## Running them

`ci-time.ts`, `sweep-cadence.ts` and their tests are in this skill's `scripts/`, and run on Node 24 with nothing installed, logged in to `gh`: `node <skills-dir>/ci-workflows/scripts/ci-time.ts --help`. With `--bill blacksmith`, it looks for `blacksmith-bill.ts` among the installed skills; a skills-only install of this skill's folder doesn't carry it, so clone ci-doctor once, outside the user's repo, at the release this skill names in `metadata.version`, and point `--adapter-dir` at the adapter's folder:

```sh
git clone --depth 1 --branch v0.4.0 https://github.com/ref-0/ci-doctor.git <ci-doctor>
node <skills-dir>/ci-workflows/scripts/ci-time.ts --bill blacksmith --adapter-dir <ci-doctor>/skills/blacksmith/scripts
```
