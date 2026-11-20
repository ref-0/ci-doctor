[Guide](../README.md)

# 6. Reuse work by its real inputs

**Cache by real inputs.** A replayed result is only as trustworthy as its key: every file, setting, and environment value that can change the result belongs in the key, and nothing else does. Leave one out and a stale pass replays; let a stray value sneak in—an absolute path, a temp report, or an incidental directory listing—and nothing ever hits. Whatever runner executes your tasks, the same rules apply: key by content, keep run-specific values out, count only what actually ran, verify replays, and control who may write what `main` replays.

## Task runners and their remote caches

**Applies when:** The repo already uses a workspace task runner or caches task results. **Skip when:** You would adopt a runner solely for its cache and haven't done section 4's selection replay yet.

We used Vite+, but most workspace task runners support remote caching, and each technique in this section maps to an equivalent setting. Start with the runner your repo already has; adopting a new runner purely for its cache requires running section 4's selection replay first.

| Technique | Vite+ (`vp run`) | Turborepo | Nx | Bazel | Gradle |
|---|---|---|---|---|---|
| **Tests as cached tasks** | Test groups defined as tasks in `run.tasks` (ours: [`test-tasks.ts`](../../scripts/shards/test-tasks.ts)); tasks cache by default | A `test` task in `turbo.json`; tasks cache unless `cache: false` | A `test` target with `"cache": true`, usually in `targetDefaults` | Test targets cache by default (`--cache_test_results=auto`) | The built-in `Test` task is cacheable; custom tasks opt in with `@CacheableTask` |
| **Keying by real inputs** | Automatic: records file reads, missing-file probes, and directory listings. Narrow with `cache.input` globs and `!` exclusions | `inputs` globs per task (`$TURBO_DEFAULT$` plus exclusions); `globalDependencies` for workspace-wide files | `inputs` and `namedInputs` (`sharedGlobals` for workspace-wide files), plus `externalDependencies` and `dependentTasksOutputFiles` | Each action's declared sources, dependencies, and tools (tools outside the workspace aren't tracked) | Annotated task inputs with `@PathSensitive(PathSensitivity.RELATIVE)` so checkouts at different paths share keys |
| **Environment in the key, run-specific values out** | `cache.env` keys a variable; `cache.untrackedEnv` passes one without keying it | `env` / `globalEnv` key a variable; `passThroughEnv` / `globalPassThroughEnv` pass one unkeyed; `envMode: "strict"` hides the rest | `{ "env": "NAME" }` and `{ "runtime": "<command>" }` inputs; unlisted variables aren't keyed | `--action_env` keys a variable; `--incompatible_strict_action_env` (on by default) fixes `PATH` so machines share hits | Values declared with `inputs.property(…)` are keyed; undeclared env reads aren't, so declare every one that affects the result. Keep absolute paths out |
| **Outputs to restore** | Automatic write tracking, or `cache.output`; `output: []` replays a pass without restoring files | `outputs` globs; logs always replay, so `outputs: []` suits a test pass | `outputs` per target | Each action's declared outputs from the content-addressed store | Declared `@OutputFile` / `@OutputDirectory` |
| **PRs read; only `main`'s CI writes** | `VP_REMOTE_CACHE=read` on PRs, `read-write` on `main`. Not yet in Vite+'s public docs; [`cache/remote/`](../../cache/remote/README.md) documents our setup | `--cache=local:rw,remote:r` on PRs (or `TURBO_CACHE` with the same value) | No client switch for self-hosted servers: give PRs a read-only token the server rejects writes for (the spec's 403 for a read-only token). Nx Cloud supports read-only tokens | `--remote_upload_local_results=false` on PRs | Enable `push` on the remote `HttpBuildCache` only in `main`'s CI (Gradle's `isCiServer` example pushes from any CI—narrow it to `main`) |
| **Checking replays** (sampled uncached rerun vs. replay) | `vp run --no-cache` on a sample; ours is `test-lanes.ts --verify-hits <n>` | Rerun the sample with both caches off (`--cache=local:`); compare `--dry=json` hashes | `NX_SKIP_NX_CACHE=true` reruns cached tasks; add `NX_SKIP_REMOTE_CACHE=true` so the probe neither reads nor writes the remote | `--noremote_accept_cached --cache_test_results=no` with uploads off; compare `--execution_log_compact_file` logs | `--rerun-tasks --no-build-cache`; `-Dorg.gradle.caching.debug=true` prints each key |
| **Trust and signing** | No signing in the protocol. Our Worker uses token digests, read tokens for PRs, and OIDC writes from `main` | `remoteCache.signature: true` with `TURBO_REMOTE_CACHE_SIGNATURE_KEY` signs artifacts (HMAC-SHA256); bad signatures miss. Because the key is shared, a valid signature proves key possession, not which run wrote it | Self-hosted: bearer tokens, no signing. Nx Cloud offers end-to-end encryption (`NX_CLOUD_ENCRYPTION_KEY`) for privacy, not provenance | No signing. Blobs are content-addressed, but action-cache entries aren't signed; Bazel's docs suggest letting only CI write | No signing; HTTP Basic credentials. Gradle's docs recommend CI populates the cache and developers only read |

Sources, checked November 2026: Vite+ [task caching](https://viteplus.dev/guide/cache) and [run config](https://viteplus.dev/config/run); Turborepo [configuration](https://turborepo.dev/docs/reference/configuration), [`run` options](https://turborepo.dev/docs/reference/run), [environment variables](https://turborepo.dev/docs/reference/system-environment-variables), and [remote caching](https://turborepo.dev/docs/core-concepts/remote-caching); Nx [inputs](https://nx.dev/docs/reference/inputs), [caching](https://nx.dev/docs/concepts/how-caching-works), [environment variables](https://nx.dev/docs/reference/environment-variables), and [self-hosted caching](https://nx.dev/docs/kb/self-hosted-caching); Bazel [remote caching](https://bazel.build/remote/caching), [cache-hit debugging](https://bazel.build/remote/cache-remote), and [command-line reference](https://bazel.build/reference/command-line-reference); Gradle [build cache](https://docs.gradle.org/current/userguide/build_cache.html), [cache debugging](https://docs.gradle.org/current/userguide/build_cache_debugging.html), [incremental build](https://docs.gradle.org/current/userguide/incremental_build.html), and [command line](https://docs.gradle.org/current/userguide/command_line_interface.html).

**Self-hosting.** Turborepo servers implement its [Remote Cache API](https://turborepo.dev/docs/openapi) (community options include [one on Cloudflare Workers with R2](https://github.com/AdiRishi/turborepo-remote-cache-cloudflare)). Nx servers implement its [OpenAPI spec](https://nx.dev/docs/kb/self-hosted-caching#open-api-specification), configured via `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` and `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`. Bazel accepts an HTTP or gRPC cache such as [bazel-remote](https://github.com/buchgr/bazel-remote) via `--remote_cache`. Gradle accepts any HTTP server handling GET/PUT, or its own build cache node.

**The trust design carries over.** The architecture in [`cache/remote/`](../../cache/remote/README.md) works in front of any of these servers: store only SHA-256 digests of tokens so config holds no secrets, issue read-only tokens to PRs, and accept writes *only* from `main`'s CI, identified by GitHub's OIDC token (checking repository, event, and ref), so there is no write secret to leak. A self-hosted server for any runner can make the same checks before storing an entry. Regardless of runner, authentication proves who wrote an entry, not that the work was honest (see [Trust](#a-remote-task-cache-with-tests-as-tasks) below).

## Checking a cache on another task runner

**Applies when:** Replays come from a runner with declared inputs (Turborepo, Nx, Bazel, or Gradle). **Skip when:** The runner tracks actual file reads (like Vite+), or nothing is cached.

Our checks below originated with Vite+, which tracks what each task actually reads. A runner with *declared* inputs can replay a stale pass when an input is omitted, or fail to restore an undeclared output. Before trusting replays, verify each cached task:

1. **Audit its key.** For Turborepo, inspect `dependsOn`, `inputs`, `outputs`, `globalDependencies`, `env`, and `globalEnv` (for other runners, see the table above). Look for undeclared inputs: another language's lockfile or config (`pyproject.toml`, a Python lockfile, `conftest.py`), generated files, and the interpreter or platform.
2. **Compare planned hashes.** Using the repo's pinned runner, plan a base and a probe change without executing (`turbo run <task> --dry=json`) and compare tasks and hashes.
3. **Probe invalidation with remote activity off** (`--cache=local:rw` for Turborepo): add, delete, modify, and create a previously missing relevant file. Every probe must miss.
4. **Run fresh with both caches off** (`--cache=local:`) and compare against the replayed result.
5. **Restore on a clean checkout.** From a second clean checkout, read from the remote cache and verify restored outputs exist and work.
6. **Keep nondeterministic tests uncached,** and always count cache hits separately from real executions.

## A remote task cache, with tests as tasks

**Applies when:** Task results are shared through a remote cache (on Vite+ as written, or on other runners via the table above). **Skip when:** No task results are shared across machines.

We run Vite+'s task runner (`vp run`) backed by a **self-hosted remote cache**: a small Cloudflare Worker speaking its protocol, with D1 (Cloudflare's SQLite database) indexing results and R2 (object storage) storing blobs. CI authenticates with a GitHub OIDC token (a short-lived identity token naming the job's repository, event, and branch). The mechanics below are Vite+-specific, while the rules apply generally via the table above.

- **Tests as tasks.** Test files are grouped into stable tasks whose names hash their file lists: one server file per task, and up to 8 other files from the same folder. Because the useful artifact is *a pass*, no output files are restored.
  - **Build groups from the full suite, identically within an environment,** whether a PR shard or a sweep asks. Grouping only the selected subset would destroy cache reuse. Local runs use their own grouping (4 files, 2 workers).
  - **A high replay rate isn't automatically a net win.** Our initial adoption failed its own speed criterion: corrected full runs summed more test-seconds than before with a slower longest shard, and cold full runs were worse. Averaging across all runs had masked this by mixing tiny selections with full runs, and per-group startup turned out to be roughly twice our early estimate. Always compare full runs to full runs; separate cold, partly reused, and warm cohorts; include task-runner startup, test-runner startup, and end-of-shard idle time; and define a rollback criterion up front. Keep cached execution only where your actual run mix meets it. Later fixes recovered much of the loss, but we haven't measured a clean net saving since—so don't take one on trust.
- **Automatic input tracking.** The runner records every file a task's processes read.
  - **Keep unrelated files out of keys:** use a dedicated test config, exact-file discovery, and exclusions for tool caches, temp dirs, test-created build outputs, and incidental pnpm or directory listings.
  - **Before fixing this, 538 of 1,030 commits invalidated every test key.** A single flake report written into the repo root once busted the entire cache.
  - **A directory listing is separate from its files.** Exclude an incidental directory-listing read without excluding the files inside it, and keep explicit file or glob inputs that catch newly added relevant files—for example, exclude a package folder's listing (`!<package-folder>`) while keeping its direct files (`<package-folder>/*`) and automatic reads beneath it. Never replace that with a blanket subtree exclusion. Verify that adding a relevant file causes a miss while an incidental build or cache folder does not. This applies equally to cached lint and cached tests.
  - **Not every input is a successful read.** Account for semantic directory enumeration, missing-file lookups, relevant metadata, and symlink resolution—a newly created config or test file can alter behavior without modifying any file the previous run opened. Exclude only listings proven irrelevant, and test invalidation for additions, deletions, and missing-to-present transitions as well as edits (with remote writes off).
- **Keyed environment:** Key CI mode, retry policy, timezone, locale, Node options, seed, and run count. Mark run-specific paths as *untracked* env, and leave `PATH` and home unkeyed. A leaked per-lane cache-path variable once caused an entire sweep to miss every key.
- **Identical program paths everywhere.** Calling the tool directly in one job and via pnpm in another changed the program identity and caused misses on identical source. Absolute checkout paths in commands did the same: a fresh worktree hit 1 of 12 builds before the fix and 12 of 12 after.
- **Salt build and lint commands with a source digest.** Because the protocol stores **one result per task key**, branches kept overwriting each other's builds. Adding a source-content salt took a fresh worktree from 3 of 12 build hits to 12 of 12. Lookup identity and input validation are separate layers.
- **Cache only deterministic tests.** Maintain an explicit folder allowlist; root-script and lint-rule tests always run fresh. Any test depending on an installed browser or CLI, process identity, sibling directories, or unseeded randomness stays uncached.
- **Verify cache soundness continuously.** Each daily sweep reruns three replayed groups per shard fresh from a daily-rotating sample ([`scripts/shards/test-lanes.ts`](../../scripts/shards/test-lanes.ts) `--verify-hits <n>`; pass `--no-cache` to bypass caching entirely for full runs).
- **Trust:**
  - **Authentication isn't provenance.** Any cache writer can upload a forged pass or build output that `main` later consumes; OIDC proves *who* wrote an entry, not that the work was honest. Before sharing results, inventory every writer and every release or deploy consumer, then document your policy: shared writes from protected `main` only (with branches in isolated namespaces), equivalent independent verification, or no remote reuse for anything that ships. Fresh sampling catches some faults but does not establish provenance. Our own setup accepted broader writers as known development debt. The reference implementation in [`cache/remote/`](../../cache/remote/) ships the narrow policy instead—writes from `main` pushes only; widen it only as a recorded decision. [Its README](../../cache/remote/README.md#trust-decide-who-may-write-what-main-replays) holds the writer list, the consumer list, and the policy choice.
  - CI reads with a secret token and writes via GitHub OIDC. Our broad-debt policy lets `main` pushes, same-repo PRs, and branch manual runs write; the narrow policy we recommend (and ship in `cache/remote/`) writes only from `main` pushes while PRs and dispatches read. Forks always run fresh.
  - Developers read and write with personal credentials.
  - Read failures degrade to misses, and upload failures never fail a passing task.
- **Bound the server.** Authenticate before buffering, cap key/value/store sizes, and enforce one shared byte budget for concurrent buffers inside the isolate's memory limit. Server-side task metadata reached ~4 MB because entire dependency trees are recorded, which forced us to raise the value limit.
- **Replays never count as executions.** Never count a replayed result as a fresh run for timing stats or flake recovery.

## Setting up the remote task cache on Cloudflare, step by step

**Applies when:** The plan self-hosts Vite+'s remote cache on Cloudflare and the trust policy is already decided. **Skip when:** Using another runner's cache, a hosted cache, or the trust policy is still undecided.

Full instructions live in [`cache/remote/README.md`](../../cache/remote/README.md#set-it-up-step-by-step), the runbook for this playbook's port of VoidZero's [Cloudflare template](https://github.com/voidzero-dev/vite-plus-remote-cache-cloudflare) (which marks itself a work in progress). Copy our shipped Worker rather than raw upstream so you get the credential script, narrow write policy, and production fixes below. Decide your trust policy ([above](#a-remote-task-cache-with-tests-as-tasks)) before provisioning anything.

In outline:

- Provision one R2 bucket, one D1 database, and the Worker, plus an R2 lifecycle rule as a retention backstop behind the Worker.
- Deploy first with empty credential maps, then mint credentials with the script and deploy their digests before pointing any client at the Worker.
- Store CI's read token as a repository secret via `gh secret set` on stdin; CI writes via OIDC (`permissions: id-token: write`), requiring no write secret.
- Add the [`task-cache`](../../templates/github/actions/task-cache/action.yml) action to every job running `vp run`, *before* dependency installation so install-time tasks can hit too.
- For maintainers' machines (if your policy permits developer writes), install the `vp-run.ts` wrapper in the consuming workspace's root `scripts/` to load the machine's writer token.
- Verify from a second clean checkout: run a harmless task, confirm a fresh store, then confirm a remote hit.

Cloudflare storage and request costs bill separately from CI minutes; track them against your actual usage.

**Production fixes we had to make to the upstream template** (each found from real traffic):

- **Allow writes from private repos.** The template only trusted public repos (where forks never receive a write token).
- **Back off only after a *failed* GitHub OIDC key fetch.** Backing off after every fetch rejected concurrent valid stores with 503 (44 of ~29,000 in one day).
- **Allow manual runs on own branches to write** (if using a broader policy—anyone who can dispatch one can already push and open a PR).
- **Grow buffers dynamically as bytes arrive.** The template pre-allocated ~10 MiB per store regardless of size; ours averaged ~0.7 MB.
- **Admit concurrent requests by byte budget, not request count.** A fixed cap of 2 concurrent stores rejected uploads from a single full local test run; requests now lease from a 96 MiB budget inside the 128 MiB isolate.
- **Raise the value limit from 4 MiB to 8 MiB.** Vite+'s input record for a server test task reached 4.0 MB because it lists every file read. Stores over the limit are silently rejected—**Vite+ prints nothing**.

**Pitfalls that cost us the most:**

- **One result per task key.** Two branches building the same task overwrite each other unless build and lint commands are salted with a source digest.
- **Absolute checkout paths** in commands or plugin paths cause every new worktree to miss everything.
- **Directory listings, tool caches, temp report files, and per-lane env vars** leaking into inputs invalidate every key.
- **Duplicating the remote cache in the Actions cache** masks whether remote reuse is working at all. Remove the duplicate so real hits are visible.
- **Mutation probes with remote writes enabled** poison the cache and evict valid entries. Always run mutation probes with remote writes off.
- **Rotating the read token** produces 401s until the new digest deploys; those degrade to misses, so CI slows down but still passes.
- **Measuring only warm runs.** Our warm local gains came with cold-path overhead, and the two were observed under different loads. Benchmark cold, warm, and fresh-worktree runs separately before declaring a cache a win.

## Rust: reuse passes and binaries separately

**Applies when:** The stack includes Rust. **Skip when:** There is no Rust code.

For agents, [`skills/ci-doctor/references/ci-workflows/references/rust.md`](../../skills/ci-doctor/references/ci-workflows/references/rust.md) holds these rules.

- **Maintain two separate keys:**
  - a **pass key** hashing everything the checks read: sources, tests, fixtures, lockfile, toolchain, Cargo config above the crate, shared contract vectors, the build workflow and its pinned action, and the relevant CI job blocks;
  - a **binary key** that also includes the release version, since compiled binaries embed it.
  Keeping them separate lets the pass key **ignore version-only churn**. [`scripts/reuse/`](../../scripts/reuse/) provides both keys (`pass-key.ts`), merge promotion (`merge-pass.ts`), and `outside-reads.ts` (a test verifying the key covers every file a Rust component reads outside its folder).
- **Trust `main`, not branch caches.** A PR skips Rust tests, `rustfmt`, and Clippy when `main` passed the exact pass key within the last 30 hours. Passes are short-lived artifacts written only by verified `main` runs. The 30 h window tolerates a daily sweep arriving up to 6 h late; any sweep or merge refreshes a pass older than 20 h so a recent pass never suppresses renewal.
  - **Keep reuse off until the key is verified.** Enable pass and binary reuse only after configuring and testing [`pass-key.ts`](../../scripts/reuse/pass-key.ts): a modified Cargo manifest, an outside fixture, and an edited workflow command must each invalidate the right key. Use its computed `key` and `binary` outputs for every lookup and save—never a hand-maintained list.
  - **Verify pass provenance.** Accept a pass artifact only after verifying its producing run: the expected workflow, branch, event, and job success. Any merge lacking a current `main` pass or promotable PR pass runs the checks fresh.
- **Promote proven PR passes on merge.** The promotion script fetches the synthetic merge commit the PR tested, confirms its second parent matches the final PR head, recomputes both keys, and records a `main` pass only if they match. The workflow template leaves promotion as a TODO in the result job ([`templates/github/README.md`](../../templates/github/README.md#left-out-on-purpose)).
- **Result (modelled by replaying 425 past runs):** Pass availability rose from **23%** (sweeps only) to **58%** (with merge promotion) to **78%** (after dropping version churn), reaching 85% on the last day sampled. Version-only release merges had caused 98 of 177 misses.
- **Cache binaries by source hash.** On a miss, binaries build *in parallel with* tests, packaging waits only for the binary, and only a run whose builds all succeed promotes them. A pass artifact is not a binary cache: when a pass key skips checks, resolve binaries separately and transfer them to the packing runner explicitly (waiting on a job does not copy its files).
- **Check version-pairing contracts before reusing binaries.** Verify whether binaries embed their release version and whether runtime components must match versions. Our service only runs a worker of its exact release, so reusing an older macOS binary with identical source broke pairing—leading us to drop "rebuild macOS less often." To save there, either ship fewer releases or redesign the version contract intentionally, then test the installed pair.

## Setup caches on Blacksmith

**Applies when:** Dependency installs and toolchain setup take significant job time (via Blacksmith sticky disks, or the Actions cache fallback elsewhere). **Skip when:** Setup is not a meaningful share of job time.

Sticky disks are Blacksmith-specific, but the caching rules are not. Without Blacksmith, store the same snapshots in the Actions cache: our template actions accept `sticky-disk: 'false'` and document the `actions/cache` fallback ([`templates/github/README.md`](../../templates/github/README.md#without-blacksmith)).

- **Sticky dependency disk.** One disk per repo, OS, and architecture holds `main`'s latest **complete** install: toolchain (Vite+, Node, pnpm), package-store markers, and every workspace link—not just `node_modules`. Jobs with a matching manifest hash mount it as read-only overlay lower layers with per-job writable upper layers, verify manifests, and skip installation completely. Caching `node_modules` alone saved almost nothing because postinstalls still reran from external store markers (section 18). Keep at least one job running a frozen-lockfile install to catch lockfile drift.
- **Sticky toolchain disk** for Rust. Always configure a read timeout and fallback: a degraded disk once returned nothing until timeout.
- **apt by resolved package hashes.** Simulate the install, hash the exact `.deb` list plus OS and architecture, and delete restored archives whose hashes don't match (since `apt` checks only file size). Try installing before running `apt-get update`, which can take longer than the install itself. Install optional heavy packages only on the shards that need them.
- **Pinned test tools.** Our tests validate behavior against a pinned reference Git implementation (the *Git oracle*). Its ~19 MB build is keyed by build definition, OS, and architecture. In CI, building it took nearly twice as long on 2 vCPU as on 8.
- **Vitest transforms.** Key by OS, architecture, and lockfile, saved only by the sweep. Keep lint config out of test config—a lint edit once invalidated 452 transforms. *Note:* the transform cache saved less than expected, only 2–5% of shard time.
- **Node compile cache.** Cut roughly a quarter off loading the heavy runtime in each per-file process, compounding across hundreds of files.
- **Type and symbol caches.** Cache per-project incremental type results and parsed per-file declarations for duplicate-code checks: cache the *facts*, not the *verdict*.

## Not worth caching

**Applies when:** Someone proposes caching sub-second generation, npm tarballs, Rust `sccache` in CI, or another cache layer. **Skip when:** No new cache layer is being proposed.

- **Sub-second generation.** Replaying from cache took 2–4× as long as simply regenerating.
- **npm tarballs.** Restoring 352 MB cost more time than it saved ([section 18](18-tried-and-dropped.md)).
- **Rust `sccache` in CI.** Saved nothing on changed crates (locally, however, it's a big win).
- **Low-yield extra layers.** We declined an additional toolchain cache whose daily savings didn't justify its maintenance cost.
