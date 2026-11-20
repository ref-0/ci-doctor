[Guide](../README.md)

# 8. A cheaper test harness

**Applies when:** Tests boot a heavy server runtime per file (such as `workerd` under Vitest). **Skip when:** Runtime startup and bundling make up only a small share of each test file's time.

Our server ran on Cloudflare Workers, so its tests executed it in `workerd` under Vitest. The principles below apply to any heavy per-file server harness; Workers-specific details live in [`skills/ci-doctor/references/speed-up-tests/references/workers.md`](../../skills/ci-doctor/references/speed-up-tests/references/workers.md).

- **Bundle the server once per input state.** Produce a Wrangler dry-run bundle with a metafile and reuse it until its real inputs change, rebuilding under a file lock and publishing atomically. Every test file still gets its own isolated runtime. Locally, this eliminated most per-harness bundling CPU and ~50 MB of writes, while a generated one-line entry avoided reparsing a ~12 MB bundle. In CI, mean harness copy-and-start dropped to ~40% of its prior time.
- **One Postgres, many databases.** Run one embedded Postgres instance per test run to serve every task, giving each harness a fresh database copied from a lazily migrated template (which takes milliseconds). Configure it non-durable, assign each run a unique port and data directory, and reap only dead owners. Never import the embedded-Postgres package's exit hook—it can mask a failing Vitest run with exit code 0.
- **Patch harness faults instead of retrying around them:**
  - A pinned Miniflare patch forces fresh connections when a blocked Node process can't retire idle sockets that `workerd` expires after 5 s.
  - A pinned HTTP-client patch fixed false "terminated" errors thrown after all body bytes had arrived. What looked like memory-ceiling "flakes" were actually this transport bug.
- **Drain runtime output outside the test process** so a full stdio pipe can never stall startup.
- **Use external watchdogs.** An external watchdog kills a hung test thread after its timeout plus 10 s, because an in-process timer can't fire when the event loop is blocked. Container test files get a 10-minute file budget, and no single test may request more than half of it.
- **Keep the system real and fake only external boundaries:**
  - **Real:** the server runtime, its SQLite, Postgres, and the pinned Git oracle.
  - **Fake:** external services, returning immediately.
  - **Network guard:** a default guard fails any outbound request not answered by a fake.
