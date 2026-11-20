[Guide](../README.md)

# 9. Workspace tooling

Workspace checks run on every agent's machine many times an hour, as well as on every CI run. To keep them fast, we made the unit of reuse granular—one project, one lint pass, or one parsed file—so each can be cached independently. Our stack is TypeScript 7 (native), [tsrs](https://www.npmjs.com/package/tsrs) (a Rust port of the native checker), Oxlint, Vite+, and pnpm. We also use Effect; everything Effect-specific is isolated in [If you use Effect](#if-you-use-effect) at the end of this section so the rest reads cleanly without it. Take the ideas, not necessarily the tools. Most timings in this section are **local** measurements.

**Start from what the repo already has.** On a plain TypeScript repo, keep the existing `tsc`, project graph, task-runner ordering, lint, and generation steps as they are. Change a piece only when a specific duplicate pass or measured bottleneck justifies it, and adopt the commands below one at a time. The Oxlint, `tsrs`, and Vite+ details apply only if you use those tools.

The type driver and its cache, symbol search and copy detection, the export guard, and the split lint config are ported in [`tools/workspace/`](../../tools/workspace/) with tests. The type checker is injectable—stock `tsc` by default, or any checker matching the README's contract (see [below](#if-you-use-effect) for Effect). That README also documents the setup, root scripts, and command/input/output contracts for the pieces not ported (custom lint rules, the lint-backend adapter, and the generation driver).

## The commands

**Applies when:** A TypeScript workspace adopting commands one at a time where a duplicate pass or measured bottleneck justifies it. **Skip when:** Existing commands show neither—keep them as they are.

| Command | What it does | Reuse |
|---|---|---|
| `prepare` (on install) | Patches compiler integration, generates bundles and schemas, sets `core.hooksPath` | Generation writes only changed files |
| `check:types` | One authoritative type check across the root project-reference graph, with framework diagnostics | Each project's passing result replays across worktrees |
| `check` | Types; formatting and untyped lint everywhere; **type-aware lint on changed files only**. (Plain `vp check` runs only format and lint; the root script adds the rest.) | Unchanged lint passes replay from the task cache |
| `check:static` | Everything CI's static job checks except the build: migration rules, generated-contract freshness, peer deps, package exports, type coverage, duplicate code, and doc budgets | Timed per step, stops on first failure. Run once *after committing* (range checks only inspect commits) |
| `build` | Cached build tasks across the workspace | Local + remote task cache |
| `test:cached` | Generates, then runs tests near the diff as cached tasks | Section 6 |
| `symbols:find` / `symbols:check` (`node tools/workspace/src/bin.ts symbols …`) | Search existing code before writing a new function / block new exact copies (from [`tools/workspace/`](../../tools/workspace/), not from any CLI in README's setup list) | Per-file parse cache |

## One type check, no duplicate passes

**Applies when:** Framework diagnostics or type-aware lint run as a separate compiler pass. **Skip when:** A single type pass already covers them.

- **One authoritative type pass.** Fold any framework diagnostics into the main type check, using the editor's diagnostic policy from the same `tsconfig`, so a second framework-only compiler pass isn't needed. Folding them in eliminated a separate `tsc` pass that had taken 10–15 s locally (see [If you use Effect](#if-you-use-effect) for ours).
- **Give type-aware lint a faster backend.** Oxlint gets its type-aware rules from `tsrs-lint`. Because Vite+ expects a `tsgolint` binary and has no backend switch yet, a pnpm override points that package name to a tiny local adapter package whose sole export is a symlink to `tsrs-lint`. Here is the complete adapter at `lint/tsgolint/`:

  ```yaml
  # pnpm-workspace.yaml (sketch)
  overrides:
    oxlint-tsgolint: link:./lint/tsgolint
  peerDependencyRules:
    allowedVersions:
      oxlint-tsgolint: "0.0.0"   # the adapter's own version
  ```

  ```jsonc
  // lint/tsgolint/package.json
  { "name": "oxlint-tsgolint", "version": "0.0.0", "private": true,
    "exports": { "./bin/tsgolint": "./bin/tsgolint" } }
  ```

  ```sh
  # add tsrs as a root devDependency, then, from lint/tsgolint/:
  mkdir -p bin && ln -s ../../../node_modules/tsrs/bin/tsrs-lint bin/tsgolint
  ```

  Exporting *only* the binary is intentional: with nothing else exported, a framework patcher won't try to inspect the replaced `tsgolint`. Run your native checker and any framework patcher in `prepare` ([If you use Effect](#if-you-use-effect)). Re-verify tool version compatibility after any upgrade—the override alone doesn't prove they match.

  In one quiet local run, types took 6.6 s (3.1 GiB) and type-aware lint took 13.4 s (4.5 GiB), reporting the same 37 warnings as before—105 CPU-seconds total, compared to 169 CPU-seconds and 7.8 GiB for the older setup measured locally on another day. Remove an adapter like this as soon as the tool supports selecting a backend natively.
- **Per-project native type driver.** Runs one native check per project—largest first, four at a time—and attributes each diagnostic to the project that owns the file (`tools/workspace/src/types/`).

## Every file in a project, enforced

**Applies when:** One consolidated type check covers the workspace via project references. **Skip when:** Each project is checked independently.

- **One root `tsconfig.json`** with no files of its own, referencing every app, library, script, and tooling project, built on strict base options including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- **A type-coverage guard** enumerates all tracked `.ts` files and fails if any file isn't covered by a project reachable from the root `tsconfig`, or if lint ignores a hand-written file. Without this guard, a consolidated check creates blind spots: turning it on exposed 44 hidden errors in one program, and an ignored custom-rules folder had hidden 57 more.

## Type results follow content across worktrees

**Applies when:** Several worktrees type-check the same projects on one machine. **Skip when:** Each machine has only one checkout.

- **Cache passing projects by content, not verdicts.** The key hashes the contents of every file listed by the previous program (`--listFiles`), compiler args, the lockfile, workspace settings, manifests, `tsconfig` files, and the project's included paths. All paths are relative and hashed by content, never mtime.
- **One machine-wide cache holds up to 32 versions per project,** allowing branches to coexist without evicting each other. Writes are atomic, nothing is stored if inputs changed mid-check, and a broken install cannot poison other worktrees.
- **Attribute diagnostics before caching.** Filter diagnostics to the project that owns each file while retaining global and unowned findings, then deduplicate. Cache a project only when it has zero retained diagnostics of its own and the compiler exited cleanly. An imported diagnostic owned by another project being checked doesn't block reuse of the importing project.
- **Know what the key assumes.** Installed package bytes aren't hashed—the lockfile stands in for them. As a result, the cache won't detect a new module-resolution winner outside every project's includes (such as a hand-crafted package in an ignored folder). Reinstall or clear the cache after any install change not reflected in the lockfile. Before enabling replay, verify that adding or renaming a file invalidates the key, and that an edit and its revert across two worktrees each return the right result.
- **In CI,** the cache lives inside the checkout and is restored and saved via the Actions cache.
- **Result (local):**

  | Case | Time | Projects replayed |
  |---|---|---|
  | Fresh worktree, before | 17–20 s | 0 of 23 |
  | Fresh worktree, after | 0.4 s | 23 of 23 |
  | After a one-line library edit | 10.8 s | 20 of 23 |
  | After reverting that edit | 0.5 s | 23 of 23 |

- **Keep the cache inside the driver, not the task runner.** Running projects as separate task-runner tasks stopped siblings on the first failure and hid their diagnostics.

## Type-aware lint where it pays

**Applies when:** The linter has type-aware rules and local checks run them across the whole repo while multiple agents check concurrently. **Skip when:** The linter has no type-aware rules.

- **Locally: types, then untyped lint everywhere, then type-aware lint on changed files** since the merge base (including uncommitted edits). This sharply cuts memory when several agents check at once: ~11 s and 2.3 GiB locally, versus ~8 GB for full type-aware lint.
- **In CI, run type-aware lint on every file,** because a type change can trigger a finding in an untouched consumer.
- **Two-pass Oxlint settings** (implemented in [`tools/workspace/`](../../tools/workspace/)):
  - keep `typeCheck: false` in both passes, since `check:types` owns full type checking;
  - in the workspace-wide untyped pass, set `typeAware: false` and disable unused-disable-directive reporting (otherwise directives for typed rules look unused);
  - in the changed-files pass, set `typeAware: true` and re-enable unused-disable-directive reporting;
  - select the pass via a single mode variable and include it in cached lint task keys;
  - always run `--fix` passes uncached, and collect every local phase's outcome even after an earlier phase fails.
- **Keep custom lint rules cheap.** Bail out early on files that can't trigger them, and cache import closures until a file changes. Verify findings against seeded violations before and after any lint speedup.
- **Shrink the program before adding threads.** Cut what each program loads: switching to per-icon imports shrank one program from 4,638 files to 1,663, and adding an explicit return type eliminated repeated inference. This helps regardless of backend.
- **Historical note (Go backend only):** Before `tsrs-lint`, we ran Go `tsgolint` and tuned it. Adding checker threads replicated type graphs in memory (local: 1 thread took 15.9 s / 3.4 GB, 4 took 11.0 s / 7.1 GB, 8 took 12.6 s / 10.2 GB). A Go memory limit slowed checking by 50–80% to save under 2 GB, while its work-stealing scheduler used ~15% less CPU. None of these Go scheduler or memory settings apply to `tsrs`—don't carry them over.

## Keep lint config out of the test config

**Applies when:** Lint settings live in the config tests load, causing lint edits to invalidate test transforms and cached test keys. **Skip when:** Tests already load a separate config.

- **Give tests a dedicated config file.** The root config imports it and loads lint settings dynamically; the lint module is restricted to `fmt`, `lint`, and `run` (anything else fails). Otherwise, every lint-rule edit invalidates Vitest transforms and cached test keys—one lint edit previously forced 452 transforms to rewrite.
- **Invoke the tool via a stable relative path** (`node node_modules/vite-plus/bin/vp`), since the task runner keyed its own absolute executable path.

## Custom lint rules that guard the shortcuts

**Applies when:** The repo relies on conventions that a lint rule can enforce: explicit build inputs, seeded property tests, restricted runtimes, or package boundaries. **Skip when:** None of those apply.

- **Complete build inputs.** Production and staging build tasks must declare transitive workspace source, manifests, and `tsconfig` files. Before this rule, a deliberately broken dependency source *replayed a green build*. We use explicit inputs for builds because automatic read tracking hit `spawn EBUSY` on our dev platform.
- **Seeded property tests.** Property tests must use the shared seeded options so PR runs reproduce deterministically while sweeps pick fresh seeds.
- **Boundaries:** forbid undeclared package access and cross-layer imports; restrict each sandbox or isolate entry's transitive import closure to what that runtime supports; and allow environment-variable reads only at entry points. Identify your restricted runtime entry points before enabling the isolate rule—for us it covers code executing inside a sandboxed isolate, not all Worker code.
- **Hygiene:** keep `index.ts` barrels re-export-only, require explicit entry re-exports, require justification comments on unsafe assertions, and forbid quadratic accumulator copies.
- **Publish shared rules as a package** consumed by each repo, with repo-specific domain rules layered on top. Test the shared package by installing its *packed tarball* into a temporary consumer so you verify what users actually receive.

## No build before checking or testing

**Applies when:** Workspace packages must be built before type checks or tests can import them. **Skip when:** Workspace packages already resolve directly to source.

Each package exports **source first** under a custom export condition, followed by built types and JS:

```json
"exports": { "./example": {
  "workspace-source": "./src/entries/example.ts",
  "types": "./dist/example.d.mts",
  "import": "./dist/example.mjs"
} }
```

- **Where it resolves:** TypeScript honors the condition via `customConditions`, and Vite, Vitest, and the Worker test bundler resolve it as well.
- **Publishing** swaps in built-only exports.
- **Export guard:** Requires an `exports` map with a tracked source target under the first condition of every built entry. All other targets must be tracked files or declared pack outputs. It rejects generated-source exports, verifies declaration files are built, and ensures `publishConfig.exports` contains only distributable targets (no source condition). Shipped in [`tools/workspace/`](../../tools/workspace/) (`node tools/workspace/src/bin.ts package-exports`; defaults to `workspace-source`).
- **Generation reads workspace source** via Vite's runner, never `dist`. Plain Node resolution previously read stale or half-written `dist` files during parallel builds.
- **Dropped alternative:** Type-checking against built `.d.ts` declarations took 17.8–18.3 s locally, compared to 6.2–10.4 s directly from source.

## Generated files

**Applies when:** Checks, tests, or builds depend on generated files. **Skip when:** Nothing is generated.

- **Generate in dependency order and write only on change** so downstream caches stay warm. A no-op run takes ~0.5 s locally. We tried caching generation and removed it—the cache replay took 1–2 s.
- **Inventory every generated artifact:** its source inputs, whether it is tracked in git, and the command that proves freshness. Verify tracked outputs against their source, and verify ignored bundles with a source-equivalence test.
- **Invoke generation explicitly** after editing a generator or dependencies, and before consumers such as cached tests, builds, and deploys. Git hooks only supplement explicit calls: they miss editor changes, and an already-current install won't rerun `prepare`.
- **Git hooks** (`core.hooksPath`, configured once per clone so every worktree inherits them) regenerate after checkout, merge, and rebase. They skip revisions lacking dependencies or the generator, print the repair command on failure, and never abort the git operation.
- **Test from a truly clean checkout.** Initial `prepare` must succeed with zero generated outputs present. Local "cold" runs often retain old generated files and hide bootstrap import bugs.

## Find existing code before writing more

**Applies when:** Agents write code in the repo (note: this is a warm local benefit, not a measured CI saving). **Skip when:** No agents write code here.

Agents duplicate code readily, so we gave them two tools:

- **`symbols find <words>`** (`node tools/workspace/src/bin.ts symbols find`, or `pnpm symbols:find` via [`tools/workspace/`](../../tools/workspace/README.md#set-it-up)) parses top-level declarations with Oxc and ranks matches by name, doc comment, signature, and path, returning the top ten with signatures and locations. `AGENTS.md` instructs agents to run it before writing a new function. Locally, lookup took ~5.4 s uncached, 6.7 s on a cold cache, and 0.5 s warm—a warm local speedup, not a measured CI saving.
- **`symbols check`** (`node tools/workspace/src/bin.ts symbols check <base> HEAD`) fails on new **exact** copies (with parameter and local names normalized) and warns on near copies (≥ 85% similar). It skips tests, types, and bodies under 40 syntax nodes, and allows intentional copies annotated with a `CLONE` comment explaining why.
- **Cache parsed facts per file,** keyed by file content plus parser and extractor identity; file listing and comparisons always run fresh. The initial cleanup consolidated 12 of 15 exact-copy groups.

## Pin everything, share the tool

**Applies when:** Node, pnpm, or shared tool versions float, or the static workflow stops at its first failure. **Skip when:** Versions are pinned and every static command reports its results.

- **Pin exact versions in pnpm's `catalog:`,** using overrides to keep Vite, Vitest, and `@types/node` aligned.
- **Pin Node and pnpm:** Node in `.node-version`, `devEngines` (which can download it), and `engines`; pnpm via `packageManager`.
- **Set `verifyDepsBeforeRun: false`** (section 14).
- **Run every static check before failing.** A reusable static workflow in the shared repo executes every supplied command—format, lint, types, and doc budget—**even if an earlier one fails**, so one run surfaces every issue.

## If you use Effect

**Applies when:** The stack uses Effect. **Skip when:** It doesn't.

Skip this subsection if your stack doesn't use [Effect](https://effect.website). With Effect, we did three things:

- **Fold Effect diagnostics into the single type check.** `prepare` runs `effect-tsgo patch --typescript`, and the type driver invokes `effect-tsgo tsrs` using the diagnostic policy in `tsconfig`. That brought the language service's rules into the authoritative pass and eliminated the separate `tsc` pass above. In [`tools/workspace/`](../../tools/workspace/README.md), configure the injectable compiler as `["node_modules/.bin/effect-tsgo", "tsrs"]`.
- **Pair it cleanly with the lint adapter.** Because the `tsgolint` adapter above exports only its binary, the Effect patcher won't go looking for the replaced `tsgolint`. Re-verify `effect-tsgo`, `tsrs`, and Oxlint versions together after any upgrade.
- **Effect-specific test patterns:** running Effects cleanly, fake clocks that leave Effect's scheduler alone, and property generators from Schema are documented for agents in [`skills/ci-doctor/references/speed-up-tests/references/effect.md`](../../skills/ci-doctor/references/speed-up-tests/references/effect.md).
