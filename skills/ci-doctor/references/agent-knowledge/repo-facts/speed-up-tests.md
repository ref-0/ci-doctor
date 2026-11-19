<!--
What: the facts about one repo's tests that the speed-up-tests skill reads: its records and scripts, settings, holds, fakes and what past campaigns measured.
Where: copy to `.agents/repo/speed-up-tests.md` in your repo.
Configure: replace every <placeholder>. The commented "Example" blocks are the source repo's values; delete them once yours are in.
Reference implementation from a production monorepo; adapt to your repo.
-->

# <repo>'s slow tests

What the shared `speed-up-tests` skill reads about this repo: CI's records and the scripts that rank them, the settings, holds and fakes, and what past campaigns measured.

## Records and scripts

Collect CI's records, then rank them, or list every file past a time with hints of its waits, in batches by area:

```sh
<records-command> --since <YYYY-MM-DD> --out records.jsonl
node <scripts-dir>/ci-slow-files.ts records.jsonl
node <scripts-dir>/ci-wait-hints.ts records.jsonl --over 10 --out batches/
```

This kit's versions are in `<root>/scripts/records/`, the playbook's pinned copy. Records hold only what ran: a test the task cache replays isn't in them.

## Thresholds

- Triage cutoff: a file past `<10 s>` in CI gets reviewed.
- Its time: the median of `<the newest 5 passing runs>` that ran it, on the same runner label; `<or this repo's window>`.
- Re-review band: a decided file is reviewed again only when its time leaves `<±40%>` of its stored baseline, at like hours.

## Settings

A production period the tests inherit is read through `<config-module>`, with production's value in `<production-config>` and a shorter one in `<test-harness-config>`. When parallel pull requests add settings to a generated file, take main's copy and regenerate it on each rebase.

<!-- Example: the server's periods are read through its config module, with production's value in the
     deploy config and a shorter one in the test harness's settings: 100 ms in tests against 1 s in production.
     On Cloudflare Workers, see the ci-doctor hub's references/speed-up-tests/references/workers.md. -->

## Holds and fakes

- **Holds:** `<the test helpers that pause an operation until the test releases it>`. Search for one with `<symbol-search>` before adding another.
- **Fakes:** `<the services the tests answer from fakes, and where the fakes live>`.
- **Kept real:** `<what the tests run for real, and why>`.

<!-- Example:
- Holds: a test-only subclass's method that holds session opens, a fake store's `hold`, and a workflow step that
  waits for an event the test sends.
- Fakes: the server's tests answer the server's own outgoing requests to the source host, the error tracker, mail
  and model providers from fakes in `<app-dir>/src/testing/`, while the server's code runs as in production.
- Kept real: the server in a local copy of its production runtime, its embedded database, local Postgres, a
  pinned Git as the oracle, and the containers a container test is about.
-->

## Fixtures and timers

- ID factories: `<the helpers that make IDs, and whether they're deterministic>`.
- Job triggers and hooks: `<how a test starts a scheduled or queued job now, instead of waiting for it>`.
- Leases and timers: `<where lease periods and timers come from, and the test setting that shortens them>`.

## What campaigns measured

- `<date>`: `<what was found, in files and test-seconds, with the window, run count and the reviewed count reconciled against the verdicts>`.

<!-- Example:
- Week 1: the many files just past the threshold held more test time than the few far past it.
- Week 1, a day later: the wait-hints script listed 198 files from several hundred runs. Of those, 190 got a verdict: 119
  slow for a wrong reason, 47 real work and 24 needing measuring; eight had none, kept as unclassified.
- Lessons came from: a fetch library's bug behind `TypeError: terminated`, two layers of retries waiting out one
  outage, a fake clock outrunning Web Crypto, a retry that didn't start clean, and a file that never ran behind
  green checks.
-->
