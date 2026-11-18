<!--
What: what was specific to testing a Cloudflare Workers server fast and honestly: workerd under Vitest,
Durable Objects, Wrangler's config and bundle, and the limits only the deployed platform shows.
Where: read by an agent speeding up or fixing tests of a Workers app. Skip it on other stacks.
Configure: your app's folder (<app-dir>), its Wrangler config and test harness, in `.agents/repo/speed-up-tests.md`.
Reference implementation from a production monorepo; adapt to your repo.
-->

# If your stack runs on Cloudflare Workers

Part of the [`speed-up-tests`](../SKILL.md) skill. The general rules are in [fixes](fixes.md), [fakes](fakes.md) and the check [test a platform's guarantee through its real boundary](../../../checks/test-the-real-boundary.md); this page says what they meant for a Workers server, tested in workerd through Vitest, with Durable Objects and Wrangler. [guide section 8](../../../docs/pages/08-a-cheaper-test-harness.md) has the harness and what it measured.

## The harness

- **Each test file gets its own workerd runtime,** so per-file state stays apart. A shared runtime across files saved little and broke isolation ([what not to build](fixes.md#what-not-to-build)).
- **Bundle the server once per input state:** a Wrangler dry-run bundle with a metafile, reused until its real inputs change, rebuilt under a file lock and published atomically. It cut most of each harness's bundling CPU.
- **Patch the harness's faults instead of retrying around them.** A blocked Node process couldn't retire idle sockets that workerd expires after 5 s, so a pinned Miniflare patch forces fresh connections. Drain the runtime's output outside the test process, so a full pipe can't stall start-up.
- **An outside watchdog** kills a blocked test after its timeout plus a margin, since a timer inside a blocked event loop can't fire.

## Settings, holds and fakes

- **A production period becomes a setting** read through the runtime's config, with production's value in `wrangler.jsonc` and a shorter one in the test harness's vars, such as 100 ms in tests against 1 s in production.
- **Holds** pause an operation until the test releases it: a test Durable Object's method that holds its session opens, a fake store's hold, and a Workflow's `waitForEvent` released with `sendEvent`.
- **Fakes answer the Worker's own outgoing requests** to the source host, the error tracker, mail and model providers, from fakes in `<app-dir>/src/testing/`, while the Worker's code runs as in production. A default guard fails any request no fake answers.
- **Kept real:** the Worker in workerd, Durable Objects' SQLite, a local Postgres (one per run, a database per harness copied from a migrated template), a pinned Git as the oracle, and the containers a container test is about.

## What only the deployed platform shows

Local workerd and CI's containers don't prove the platform's limits. In the source repo:

- 1.4 s of module start-up passed local CPU caps of 10, 100 and 5,000 ms, so a local cap didn't bind where the platform's would; a rule also ran past its 2 s deadline while its caller stayed alive. Watch start-up time from deploy logs, well before the platform's hard limit ([guide section 16](../../../docs/pages/16-standing-automations.md)).
- A 147 MiB Wasm check passed in fresh isolates, but most later checks, in warm ones, exceeded memory. A warm small container also lost the CPU speed its first seconds suggested.
- Probes on the platform found four networking differences local Docker hid, including servers crashing on a 64-character hostname.
- The deployed end-to-end run found five bugs that CI and probes had missed.
- The first real bill disproved three of four guessed container meter mappings.

So probe each limit on the deployed platform, on warm instances and at another hour, and run the whole path on staging before calling it done.
