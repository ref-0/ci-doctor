[Guide](../README.md)

# 6. Reuse work by its real inputs

**Cache by real inputs.** A replayed result is only as good as its key: every file, setting and environment value that could change the result belongs in it, and nothing else does. Leave one out and a stale pass replays; put a stray one in, such as an absolute path, a temp report or a directory listing, and nothing ever replays. Whatever runs the tasks, the rules below hold: key by contents, keep run-specific values out, count only what ran, verify replays, and decide who may write what main replays.

## Task runners and their remote caches

We used Vite+. Most workspace task runners have a remote cache, and each technique in this section has an equivalent setting in them. Start from the runner your repo already has; adopting one only for its cache needs the selection replay in section 4 first.

| Technique | Vite+ (`vp run`) | Turborepo | Nx | Bazel | Gradle |
|---|---|---|---|---|---|
| **Tests as cached tasks** | Test groups defined as tasks in `run.tasks` (ours: [`test-tasks.ts`](../../scripts/shards/test-tasks.ts)); tasks cache by default | A `test` task in `turbo.json`; tasks cache unless `cache: false` | A `test` target with `"cache": true`, usually in `targetDefaults` | Test targets cache by default (`--cache_test_results=auto`) | The built-in `Test` task is cacheable; a custom task opts in with `@CacheableTask` |
| **Keying by real inputs** | Automatic: it records file reads, missing-file probes and directory listings. Narrow with `cache.input` globs and `!` exclusions | `inputs` globs per task (`$TURBO_DEFAULT$` plus exclusions); `globalDependencies` for files every task reads | `inputs` and `namedInputs` (`sharedGlobals` for workspace-wide files), plus `externalDependencies` and `dependentTasksOutputFiles` | Each action's declared sources, dependencies and tools. Tools outside the workspace aren't tracked | Annotated task inputs, with `@PathSensitive(PathSensitivity.RELATIVE)` so checkouts at other paths share keys |
| **Environment in the key, run-specific values out** | `cache.env` keys a variable; `cache.untrackedEnv` passes one without keying it | `env` / `globalEnv` key a variable; `passThroughEnv` / `globalPassThroughEnv` pass one unkeyed; `envMode: "strict"` hides the rest | `{ "env": "NAME" }` and `{ "runtime": "<command>" }` inputs; variables not listed aren't keyed | `--action_env` keys a variable; `--incompatible_strict_action_env` (on by default) fixes `PATH`, so machines share hits | A value declared with `inputs.property(…)` is keyed; an environment read the task doesn't declare isn't, so declare every one that changes the result. Keep absolute paths out of inputs |
| **Outputs to restore** | Automatic write tracking, or `cache.output`; `output: []` replays a pass without restoring files | `outputs` globs; logs always replay, so `outputs: []` suits a test pass | `outputs` per target | Each action's declared outputs, from the content-addressed store | Declared `@OutputFile` / `@OutputDirectory` |
| **PRs read; only main's CI writes** | `VP_REMOTE_CACHE=read` on PRs, `read-write` on main. The remote mode isn't in Vite+'s public docs yet; [`cache/remote/`](../../cache/remote/README.md) documents what we run | `--cache=local:rw,remote:r` on PRs (or `TURBO_CACHE` with the same value) | No client switch for a self-hosted server: give PRs a token the server refuses writes for (the spec's 403 for a read-only token). Nx Cloud has read-only tokens | `--remote_upload_local_results=false` on PRs | `push` on the remote `HttpBuildCache` set only in main's CI. Gradle's example pushes from any CI (`isCiServer`); narrow it to main |
| **Checking replays** (a sampled uncached rerun compared with the replay) | `vp run --no-cache` on a sample; ours is `test-lanes.ts --verify-hits <n>` | Rerun the sample with both caches off (`--cache=local:`); compare `--dry=json` hashes | `NX_SKIP_NX_CACHE=true` reruns cached tasks; add `NX_SKIP_REMOTE_CACHE=true` so the probe neither reads nor writes the remote | `--noremote_accept_cached --cache_test_results=no`, with uploads off; compare two runs' `--execution_log_compact_file` logs | `--rerun-tasks --no-build-cache`; `-Dorg.gradle.caching.debug=true` prints each key |
| **Trust and signing** | No signing in the protocol. Our Worker: token digests, read tokens for PRs, OIDC writes from main | `remoteCache.signature: true` with `TURBO_REMOTE_CACHE_SIGNATURE_KEY` signs artifacts (HMAC-SHA256), and an artifact that fails the check is a miss. The key is shared, so a valid signature says who holds the key, not which run wrote it | Self-hosted: bearer tokens, no signing. Nx Cloud offers end-to-end encryption (`NX_CLOUD_ENCRYPTION_KEY`): privacy, not provenance | No signing. Blobs are addressed by their digest, but action-cache entries aren't signed; Bazel's docs suggest letting only CI write | No signing; HTTP Basic credentials. Gradle's docs recommend that CI populates the cache and developers only load from it |

Sources, checked November 2026: Vite+ [task caching](https://viteplus.dev/guide/cache) and [run config](https://viteplus.dev/config/run); Turborepo [configuration](https://turborepo.dev/docs/reference/configuration), [`run` options](https://turborepo.dev/docs/reference/run), [environment variables](https://turborepo.dev/docs/reference/system-environment-variables) and [remote caching](https://turborepo.dev/docs/core-concepts/remote-caching); Nx [inputs](https://nx.dev/docs/reference/inputs), [caching](https://nx.dev/docs/concepts/how-caching-works), [environment variables](https://nx.dev/docs/reference/environment-variables) and [self-hosted caching](https://nx.dev/docs/kb/self-hosted-caching); Bazel [remote caching](https://bazel.build/remote/caching), [cache-hit debugging](https://bazel.build/remote/cache-remote) and the [command-line reference](https://bazel.build/reference/command-line-reference); Gradle [build cache](https://docs.gradle.org/current/userguide/build_cache.html), [cache debugging](https://docs.gradle.org/current/userguide/build_cache_debugging.html), [incremental build](https://docs.gradle.org/current/userguide/incremental_build.html) and the [command line](https://docs.gradle.org/current/userguide/command_line_interface.html).

**Self-hosting.** Turborepo's server implements its [Remote Cache API](https://turborepo.dev/docs/openapi); community servers include [one on Cloudflare Workers with R2](https://github.com/AdiRishi/turborepo-remote-cache-cloudflare). Nx's implements its [OpenAPI spec](https://nx.dev/docs/kb/self-hosted-caching#open-api-specification), set with `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` and `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`. Bazel takes an HTTP or gRPC cache, such as [bazel-remote](https://github.com/buchgr/bazel-remote), set with `--remote_cache`. Gradle takes any HTTP server that answers GET and PUT, or Gradle's build cache node.

**The trust design carries over.** [`cache/remote/`](../../cache/remote/README.md)'s design works in front of any of these servers. The server stores only each token's SHA-256 digest, so its config holds no secret. PRs get a read token. Writes come only from main's CI, identified by GitHub's OIDC token (its repository, event and ref), so there's no write secret to leak. A self-hosted server for any runner can make the same checks before it stores an entry. Whichever you use, authentication says who wrote an entry, not that the work was honest ("Trust", below).

## Checking a cache on another task runner

Our checks below come from Vite+, which tracks what each task reads. A runner with declared inputs can replay a pass with an input left out, or fail to restore an output it was never told about. Before you rely on its replays, for each cached task:

1. **Read its key.** For Turborepo, the task's `dependsOn`, `inputs`, `outputs`, `globalDependencies`, `env` and `globalEnv`; for the others, the rows above. Check what the declarations miss: another language's lockfile and config (`pyproject.toml`, a Python lockfile, `conftest.py`), generated files, and the interpreter or platform.
2. **Compare planned hashes.** With the repo's pinned runner, plan a base and a probe change without running anything (`turbo run <task> --dry=json`), and compare the tasks and hashes.
3. **Probe invalidation with remote activity off** (`--cache=local:rw` for Turborepo): add, delete, modify, and make present a missing relevant file. Each must miss.
4. **Run fresh with both caches off** (`--cache=local:`) and compare with the replay.
5. **Restore on a clean checkout.** From a second clean checkout, read the remote and check that the restored outputs exist and work.
6. **Keep nondeterministic tests uncached,** and count hits apart from executions.

## A remote task cache, with tests as tasks

We run Vite+'s task runner (`vp run`) with a **self-hosted remote cache**: a small Cloudflare Worker (a serverless function) that speaks its protocol, with D1 (Cloudflare's SQLite database) as the index of results and R2 (its object storage) for the blobs. CI proves who it is with an OIDC token: a short-lived identity token GitHub issues to a job, naming its repository, event and branch. This subsection is Vite+-specific; the rules carry over through the table above.

- **Tests are tasks.** Test files are grouped into stable tasks whose name hashes their file list: one server file per task, up to 8 other files from one folder. The useful cached artifact is *a pass*, so no outputs are restored.
  - **Groups are formed from every file, the same way within an environment,** whether a shard or the sweep asks. Building them from only the requested subset would destroy reuse. Local runs use their own grouping (4 files, 2 workers).
  - **A high replay rate isn't a net win.** Our first adoption failed its own agreed speed criterion: corrected full runs summed more test-seconds than before, with a slower longest shard, and cold full runs were worse. A mean over all runs had hidden this by mixing tiny selections with full ones, and per-group startup turned out about twice the early estimate. Compare full runs with full runs; keep cold, partly reused and warm cohorts apart; include task-runner and test-runner startup and end-of-shard idle time; and set a rollback criterion before adopting. Keep cached execution only where your observed mix of runs meets it. Later fixes (below) recovered much of the loss, but we haven't measured a clean net saving since, so don't take one on trust.
- **Inputs are tracked automatically.** The runner records every file a task's processes actually read.
  - **Keep unrelated files out of keys:** a dedicated test config, exact-file discovery, and exclusions for tool caches, temp dirs, build outputs the test makes itself, and incidental pnpm/directory listings.
  - **Before this, 538 of 1,030 commits moved every test key.** A flake report written into the repo root once invalidated everything.
  - **A listing isn't its files.** Exclude an incidental directory-listing read separately from the file reads under it, and keep explicit file or glob inputs that notice a new relevant file there. For example, exclude a package folder's listing (`!<package-folder>`) while including its direct files (`<package-folder>/*`) and keeping automatic reads beneath it. Don't swap that for a blanket subtree exclusion. Show that a new relevant file misses and an incidental build or cache folder doesn't. This applies to cached lint as much as to tests.
  - **Not every input is a successful read.** Track semantic directory enumeration, lookups of paths that don't exist, relevant metadata and symlink resolution. A newly created config or test file can change a task's behaviour without touching any file the last run opened. Exclude only listings you've shown are irrelevant to the task, and test invalidation for additions, deletions and missing-to-present transitions as well as edits, with remote writes off.
- **Keyed environment:** CI mode, retry policy, timezone, locale, Node options, seed and run count. Run-specific paths are *untracked* env, and `PATH`/home aren't keyed. A per-lane cache-path variable once leaked into keys and made a whole sweep replay nothing.
- **Same program path everywhere.** Invoking the tool directly in one job and through pnpm in another changed the "program" identity and caused misses on identical source. Absolute checkout paths in commands did the same: a fresh worktree hit 1 of 12 builds before the fix and 12 of 12 after.
- **Salt build and lint commands with a source digest.** The protocol keeps **one result per task key**, so branches kept overwriting each other's build. With a source-content salt, one new worktree went from 3 of 12 build hits to 12 of 12. Lookup identity and input validation are separate layers.
- **Cache only deterministic tests.** An explicit folder allowlist; root-script and lint-rule tests always run. Tests that depend on an installed browser or CLI, process identity, sibling directories or unseeded randomness stay uncached.
- **Check the cache is sound.** Each daily sweep reruns three replayed groups per shard fresh, from a sample that changes daily ([`scripts/shards/test-lanes.ts`](../../scripts/shards/test-lanes.ts) `--verify-hits <n>`; `--no-cache` runs everything with no cache, for full runs).
- **Trust:**
  - **Authentication isn't provenance.** A cache writer can supply a forged pass or build output for inputs main reads. OIDC proves who wrote an entry, not that the computation was honest. Before sharing results, list every writer and every release or deploy path that consumes them, then pick and document a policy: shared writes from protected main only, with branches in isolated namespaces; equivalent independent verification; or no remote reuse for anything that ships. Sampling hits fresh (below) catches some faults but doesn't establish provenance. Our own setup accepted broad writers as known development debt. The example in [`cache/remote/`](../../cache/remote/) ships the narrow policy instead, writes only from main's pushes; widen it only as a recorded decision: [its README](../../cache/remote/README.md#trust-decide-who-may-write-what-main-replays) holds the writer list, the consumer list and the policy choice.
  - CI reads with a secret and writes with a GitHub OIDC token. Our policy lets main pushes, same-repo PRs and branch manual runs write: the broad debt above. The narrow policy we recommend, and the one `cache/remote/` ships, writes only from main's pushes, with every PR and dispatch reading. Forks run fresh.
  - Developers read and write with personal credentials.
  - Read failures are misses, and upload failures don't fail a passed task.
- **Bound the server.** Auth before buffering, size limits on keys, values and stores, and one shared byte budget for concurrent buffers within the isolate's memory. Server-side task metadata reached ~4 MB because whole dependency trees are recorded; that's why the value limit had to rise.
- **Replays don't count as runs.** Replayed results are never counted as fresh executions for timing or flake recovery.

## Setting up the remote task cache on Cloudflare, step by step

The steps live in one place: [`cache/remote/README.md`](../../cache/remote/README.md#set-it-up-step-by-step), the runbook for this playbook's port of VoidZero's [Cloudflare template](https://github.com/voidzero-dev/vite-plus-remote-cache-cloudflare) (which marks itself a work in progress). Copy the shipped Worker rather than starting from raw upstream: the credential script, the write policy and the fixes below are this port's. Decide the trust policy ("Trust", above) before you create anything. In outline:

- one R2 bucket, one D1 database and the Worker, with an R2 lifecycle rule as a backstop behind the Worker's own retention;
- a first deploy with empty credential maps, then credentials minted by the script and their digests deployed, before any client points at it;
- CI's read token as a repository secret, set through `gh secret set`'s standard input; CI writes through OIDC (`permissions: id-token: write`), so there's no write secret;
- the [`task-cache`](../../templates/github/actions/task-cache/action.yml) action in each job that runs `vp run`, before the dependency install, so tasks the install runs can hit too;
- for maintainers' machines, if your policy allows them to write, a wrapper (`vp-run.ts`, copied into the consuming workspace's root `scripts/`) that reads the machine's writer token;
- a post-deploy check from a second clean checkout: a harmless task, a known fresh store, then an observed remote hit.

Storage and requests bill separately from CI minutes; check them against your own usage.

**What we had to change in the template,** each found from real traffic:

- **Allow writes from a private repo.** The template only trusts public repos, where forks never get a writing token.
- **Back off only after a *failed* fetch of GitHub's OIDC keys.** Backing off after any fetch refused concurrent valid stores with 503: 44 of ~29,000 in one day.
- **Let manual runs on your own branches write.** Anyone who can start one can already push and open a PR.
- **Grow buffers as bytes arrive.** The template allocated ~10 MiB per store however small it was. Ours average ~0.7 MB.
- **Admit requests by bytes, not by count.** A fixed count of 2 concurrent stores refused uploads from one full local test run. Each request now leases from a 96 MiB budget inside the 128 MiB isolate.
- **Raise the value limit from 4 to 8 MiB.** Vite+'s record of a server test task's inputs reached 4.0 MB, because it lists every file the task read. A store past the limit is refused, and **Vite+ says nothing**.

**Pitfalls that cost us the most** (the bullets above have the detail):

- **One result per task key.** Two branches building the same task keep replacing each other. Salt build and lint commands with a source digest.
- **Absolute checkout paths** in task commands or plugin paths. Each worktree misses everything.
- **Directory listings, tool caches, temp report files and per-lane env vars** in the inputs. Every key moves.
- **Duplicating the remote cache in the Actions cache.** We did this at first, and it hid whether remote reuse worked at all. Remove the duplicate to see real hits.
- **Mutation probes write their altered state** and evict useful entries. Run them with remote writes off.
- **Rotating the read token** gives 401s until the new digest deploys. Those are misses, so CI is slower but still passes.
- **Measuring only warm runs.** Our warm local gains came with cold-path overhead, and the two were observed under different loads. Measure cold, warm and fresh-worktree runs separately before you call a cache a win.

## Rust: reuse passes and binaries separately

For agents, [`skills/ci-workflows/references/rust.md`](../../skills/ci-doctor/references/ci-workflows/references/rust.md) holds these rules, if your stack uses Rust.

- **Two keys:**
  - a **pass key** over everything the checks read: sources, tests, fixtures, lockfile, toolchain, Cargo config found above the crate, shared contract vectors, the build workflow and its pinned action, and the relevant CI job blocks;
  - a **binary key** that includes the release version, since binaries embed it.
  The pass key **drops version-only churn**. [`scripts/reuse/`](../../scripts/reuse/) has both keys (`pass-key.ts`), the merge promotion (`merge-pass.ts`), and `outside-reads.ts`, a test that the key holds every file a Rust component reads outside its folder.
- **Trust main, not branch caches.** A PR skips Rust tests, rustfmt and Clippy if main passed the exact key within 30 hours. Passes are short-lived artifacts that only verified main runs write. The 30 h window lets a daily run arrive up to 6 h late; a sweep or merge renews a pass older than 20 h, so a recent pass doesn't suppress the refresh.
  - **Leave reuse off until the key is complete.** Turn on pass and binary reuse only after [`pass-key.ts`](../../scripts/reuse/pass-key.ts) is configured for your component and verified: a changed Cargo manifest, an outside fixture and a changed workflow command must each move the right key. Use its computed `key` and `binary` outputs at every lookup and save, never a hand-written list.
  - **A pass needs provenance.** Accept one only from an artifact whose producing run you've checked: the right workflow, branch and event, and the producing job's success. A merge with neither a current main pass nor a promotable PR pass runs the checks.
- **A merge promotes its PR's proven pass.** The script fetches the synthetic merge commit the PR tested, checks its second parent is the final head, recomputes both keys, and records a main pass only if they match. The workflow template leaves promotion as a TODO in its result job ([`templates/github/README.md`](../../templates/github/README.md#left-out-on-purpose)).
- **Result (modelled by replaying 425 past runs):** pass availability went from **23%** (sweeps only) to **58%** (with merge promotion) to **78%** (without version churn), and reached 85% on the last day sampled. Version-only release merges had caused 98 of 177 misses.
- **Binaries:** cached by source hash. On a miss they build *beside* tests, packing waits only for the binary, and only a run whose builds all pass promotes them. A pass artifact isn't a binary cache: when a pass key skips the checks, resolve the binaries separately, and move them to the packing runner explicitly (a wait doesn't copy files).
- **Versions pair, so unchanged source isn't enough.** Find each binary's embedded version and any runtime rule that components must match versions before reusing one. Our service only runs a worker of its own release, so an older macOS binary with identical source broke the pairing, and rebuilding macOS less often for releases was dropped. To save there, ship fewer releases or redesign the version contract on purpose, then verify the installed pair.

## Setup caches on Blacksmith

The disks are Blacksmith's; the rules aren't. Without Blacksmith, the same snapshots live in the Actions cache: the template actions take `sticky-disk: 'false'` and document the `actions/cache` fallback ([`templates/github/README.md`](../../templates/github/README.md#without-blacksmith)).

- **Sticky dependency disk.** One disk per repo, OS and architecture holds main's last **complete** install: the toolchain (Vite+, Node, pnpm), the package-store markers and every project's links, not just `node_modules`. Jobs with a matching manifest hash mount it as read-only overlay lower layers with per-job writable upper layers, and skip the install after checking the manifests. A matching snapshot avoids reinstalling dependencies at all. A disk of `node_modules` alone saved almost nothing, because postinstalls reran from markers that lived outside it (section 18). At least one job still runs a frozen-lockfile install to validate the lockfile.
- **Sticky toolchain disk** for Rust. Add a read timeout and a fallback: a bad disk once read nothing before the timeout.
- **apt by resolved package hashes.** Simulate the install, hash the exact `.deb` set plus OS and architecture, and delete restored archives whose hashes don't match, since apt trusts size. Try install before `apt-get update`, which can take longer than the install. Install optional heavy packages only on the shard that needs them.
- **Pinned test tools.** Our tests compare results against a pinned reference Git implementation, the *Git oracle*. Its build (~19 MB) is keyed by its build definition, OS and architecture. In CI, building the same definition took nearly twice as long on 2 vCPU as on 8.
- **Vitest transforms.** Keyed by OS, architecture and the installed lockfile, and saved only by the sweep. Keep lint config out of the test config: a lint edit had rewritten 452 transforms. Gotcha: the transform cache was smaller than expected, 2–5% of shard time.
- **Node compile cache.** It cut about a quarter off loading the heavy runtime in each file process, which multiplies across hundreds of files.
- **Type and symbol caches.** Per-project incremental types, and parsed per-file declarations for the duplicate-code check: cache the facts, not the verdict.

## Not worth caching

- **Sub-second generation.** A cache replay took two to four times as long as regenerating.
- **npm tarballs.** The 352 MB restore cost more than it saved ([section 18](18-tried-and-dropped.md) has the row).
- **Rust sccache in CI.** It saved nothing on changed crates. Locally it's great.
- **More layers.** We declined an extra toolchain cache whose total daily saving was trivial next to its upkeep.
