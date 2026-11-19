[Guide](../README.md)

# 8. A cheaper test harness

**Applies when:** A server with a heavy runtime per test file, such as workerd under Vitest. **Skip when:** The runtime's startup and bundling are a small share of each test file's time.

Our server ran on Cloudflare Workers, so its tests ran it in workerd under Vitest. The ideas apply to any server with a heavy runtime per test file; what was specific to Workers is in [`skills/ci-doctor/references/speed-up-tests/references/workers.md`](../../skills/ci-doctor/references/speed-up-tests/references/workers.md), if your stack runs on them.

- **Bundle the server once per input state.** Build a Wrangler dry-run bundle with a metafile and reuse it until its real inputs change, rebuilding under a file lock and publishing atomically. Each file still gets its own runtime. Locally this cut most of each harness's bundling CPU and about 50 MB of writes, and a generated one-line entry avoided reparsing a ~12 MB bundle. In CI, mean harness copy-and-start fell to about 40% of its old time.
- **One Postgres, many databases.** One embedded Postgres per run serves every task, and each harness gets a database copied from a lazily migrated template, which takes milliseconds. Run it non-durable, give each run a unique port and directory, and reap only dead owners. Don't import the embedded-Postgres package's exit hook: it could turn a failed Vitest into exit 0.
- **Patch harness faults instead of retrying around them.**
  - A pinned Miniflare patch forces fresh connections where a blocked Node process can't retire idle sockets that workerd expires after 5 s.
  - A pinned HTTP-client patch fixed false "terminated" errors after all body bytes had arrived. The memory-ceiling "flakes" were really this transport bug.
- **Drain runtime output outside the test process,** so a full pipe can't stall startup.
- **Watchdogs.** An external watchdog kills a blocked test thread after its timeout plus 10 s, because an in-process timer can't fire while the event loop is blocked. Container files get a 10-minute file budget, and no single test may ask for more than half of it.
- **Keep the system real and fake only the outside:**
  - **Real:** the runtime, its SQLite, Postgres and the pinned Git oracle.
  - **Fake:** external services, which answer at once.
  - **Network guard:** a default guard fails any request no fake answers.
