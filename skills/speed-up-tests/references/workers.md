<!--
What: what was specific to testing a Cloudflare Workers server fast and honestly: workerd under Vitest,
Durable Objects, Wrangler's config and bundle, and the limits only the deployed platform shows.
Where: read by an agent speeding up or fixing tests of a Workers app. Skip it on other stacks.
Configure: your app's folder (<app-dir>), its Wrangler config and test harness, in `.agents/repo/speed-up-tests.md`.
Reference implementation from a production monorepo; adapt to your repo.
-->

# If your stack runs on Cloudflare Workers

Part of the [`speed-up-tests`](../SKILL.md) skill. The general rules are in [fixes](fixes.md), [fakes](fakes.md) and the check [test a platform's guarantee through its real boundary](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/ci-doctor/references/checks/test-the-real-boundary.md); this page says what they meant for a Workers server, tested in workerd through Vitest, with Durable Objects and Wrangler. [guide section 8](https://ci-doctor.ref0.dev/guide/docs/pages/08-a-faster-test-harness.md) has the harness and what it measured.

## The harness

- **Each test file gets its own workerd runtime,** so per-file state stays apart. A shared runtime across files saved little and broke isolation ([what not to build](fixes.md#what-not-to-build)).
- **Bundle the server once per input state:** a Wrangler dry-run bundle with a metafile, reused until its real inputs change, rebuilt under a file lock and published atomically. It cut most of each harness's bundling CPU.
- **Time Miniflare's start by phase** with a temporary log: Wrangler's esbuild pass over the entry (it parses the whole entry only to guess its format, so start from a one-line entry that re-exports the bundle by name; Miniflare makes a named entry point only for the entry's exports), Miniflare's config serialization (its capnp arena grew one small segment at a time; a pinned patch makes it double), workerd's own start, and the database copy. Copy the database while workerd starts, since no request reaches the Worker before `listen()` returns, and return only once both are done. Together these took a harness's start to about 40% of its time in CI, each file still on its own workerd.
- **A cache restore rewrites the build in place.** When fixtures build another Worker, Vite empties its `dist/` on a miss and the task cache deletes and recreates each restored file on a hit, while another file's Miniflare still serves from it. Build under `flock`, copy the whole `dist/` to a folder named by its content, and point Wrangler's config at the copy, which nothing writes again. Write a shared bundle config as `config.json.<pid>` and rename it onto `config.json`.
- **Patch the harness's faults instead of retrying around them.** A blocked Node process couldn't retire idle sockets that workerd expires after 5 s, so a pinned Miniflare patch forces fresh connections. Drain the runtime's output outside the test process, so a full pipe can't stall start-up.
- **An outside watchdog** kills a blocked test after its timeout plus a margin, since a timer inside a blocked event loop can't fire.

## Settings, holds and fakes

- **A production period becomes a setting** read through the runtime's config, with production's value in `wrangler.jsonc` and a shorter one in the test harness's vars, such as 100 ms in tests against 1 s in production.
- **Holds** pause an operation until the test releases it: a test Durable Object's method that holds its session opens, a fake store's hold, and a Workflow's `waitForEvent` released with `sendEvent`.
- **Fakes answer the Worker's own outgoing requests** to the source host, the error tracker, mail and model providers, from fakes in `<app-dir>/src/testing/`, while the Worker's code runs as in production. A default guard fails any request no fake answers.
- **A persisted wait reruns on replay.** A Workflow restarted from a step's sleep sleeps again. To prove what the replay does, make the first pass's sleep long (10 minutes) and the replay's short (1 second), so only a replay can finish within the test; wait until the sleep is in the run's history before asking for the restart (Workflows refuses a restart from a step it hasn't recorded); then assert the end. Prove it with a mutation: with the restart made a no-op, the test must miss its deadline. Keep the three apart: the condition that interrupts the run, what the replay needs first, and the final assertion.
- **Kept real:** the Worker in workerd, Durable Objects' SQLite, a local Postgres (one per run, a database per harness copied from a migrated template), a pinned Git as the oracle, and the containers a container test is about.

## Startup at module load

Every test file's workerd, every `wrangler dev` and every cold isolate pays the Worker's top-level work.

- **Profile the import alone,** in workerd: CPU, bytes allocated by the top level, and errors constructed. An import of two names from a module that pulled in a whole schema library cost several MiB; moving the names to a file of their own removed it.
- **Hold `Error.stackTraceLimit` low while modules load,** and restore it before the first request, if a library probes stacks at load: each probe made V8 re-parse a large top level. Locally that cut start CPU by about 30%. Test that the probes answer the same, and that stacks are full afterwards.
- **Move derivation to first use:** codecs, schemas and errors made at load that only a request needs. The first request in an isolate pays it once; Durable Objects and cron that never call it never do. Watch for esbuild's `keepNames` wrapping each named function in `__name` at load.
- **Gate on allocation, not CPU.** Bytes allocated at load repeat exactly from run to run; CPU on CI's runners doesn't. We set the allocation budget 15% over the measured value, for each deploy bundle, with CPU only as a gross ceiling.
- **Measure the platform's start apart from workerd's.** A version uploaded to a scratch Worker with no bindings, never deployed, reports Cloudflare's own startup time; alternate base and change for several rounds, since single readings swing widely. Then read the deploys' startup after the merge ([what only the deployed platform shows](#what-only-the-deployed-platform-shows)).

## A refused upload through the local proxy

Miniflare's proxy sends a stream from Node to workerd as the body of one HTTP request, and the answer comes back on the same exchange. If the Worker refuses and cancels the stream unread, workerd can reset the connection while undici still sends the last bytes: `EPIPE` on the write or `ECONNRESET` on the read, and `fetch failed` instead of the refusal. Workers RPC carries the stream and the answer separately, so production doesn't race; check that inside workerd before deciding where to fix. The fix is in the fake: read the whole body, then answer, and keep the test's refusal assertion. To reproduce it, stall the stream after its first chunk, as a loaded runner does ([section 11](https://ci-doctor.ref0.dev/guide/docs/pages/11-flakes.md#cause-symptom-fix)).

## What only the deployed platform shows

Local workerd and CI's containers don't prove the platform's limits. In the source repo:

- 1.4 s of module start-up passed local CPU caps of 10, 100 and 5,000 ms, so a local cap didn't bind where the platform's would; a rule also ran past its 2 s deadline while its caller stayed alive. Watch start-up time from deploy logs, well before the platform's hard limit ([guide section 16](https://ci-doctor.ref0.dev/guide/docs/pages/16-standing-automations.md)).
- A 147 MiB Wasm check passed in fresh isolates, but most later checks, in warm ones, exceeded memory. A warm small container also lost the CPU speed its first seconds suggested.
- Probes on the platform found four networking differences local Docker hid, including servers crashing on a 64-character hostname.
- The deployed end-to-end run found five bugs that CI and probes had missed.
- The first real bill disproved three of four guessed container meter mappings.

So probe each limit on the deployed platform, on warm instances and at another hour, and run the whole path on staging before calling it done.
