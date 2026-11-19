[Guide](../README.md)

# 9. Workspace tooling

The workspace checks run on every agent's machine many times an hour, and in every CI run. So the unit of optimization became one project, one lint pass or one parsed file, and each is reused independently. Our stack is TypeScript 7 (native), [tsrs](https://www.npmjs.com/package/tsrs) (a Rust port of the native checker), Oxlint, Vite+ and pnpm. We also use Effect: what was specific to it is in [If you use Effect](#if-you-use-effect), at the end of this section, and the rest reads without it. Take the ideas, not necessarily the tools. Most timings in this section are **local** measurements.

**Start from what the repo has.** On a plain TypeScript repo, keep the existing `tsc`, project graph and task-runner ordering, and its compiler, lint and generation steps as they are. Change one only when a named duplicate pass or a measured bottleneck justifies it, and adopt the commands below one at a time. The Oxlint, tsrs and Vite+ material is conditional: it applies only if you use those tools.

The type driver and its cache, symbol search and the copy check, the export guard and the split lint config are ported in [`tools/workspace/`](../../tools/workspace/), with their tests and the type checker injectable: stock `tsc` by default, or any checker that keeps the contract in its README (for Effect, see [below](#if-you-use-effect)). Its README also gives the setup, the root scripts, and a command/input/output contract for each tool not ported (custom lint rules, the lint-backend adapter, the generation driver).

## The commands

| Command | What it does | Reuse |
|---|---|---|
| `prepare` (on install) | Patches the compiler integration, generates bundles and schemas, sets the git hooks path | Generation writes only changed files |
| `check:types` | One authoritative type check over the root project-reference graph, with framework diagnostics | Each project's passing result is reused, across worktrees |
| `check` | Types; format and untyped lint everywhere; **type-aware lint on changed files only**. (Plain `vp check` is only format and lint; the root script adds the rest.) | Unchanged lint passes replay from the task cache |
| `check:static` | Everything CI's static job checks except the build: migration rules, generated-contract freshness, peer deps, package exports, type coverage, duplicate code, doc budgets | Timed per step, stops at first failure. Run once, *after committing*: its range checks only see commits |
| `build` | Cached build tasks across the workspace | Local + remote task cache |
| `test:cached` | Generate, then the tests near the diff as cached tasks | Section 6 |
| `symbols:find` / `symbols:check` (`node tools/workspace/src/bin.ts symbols …`) | Search existing code before writing a function / refuse new exact copies. From [`tools/workspace/`](../../tools/workspace/), not from any CLI in README's setup list | Per-file parse cache |

## One type check, no duplicate passes

- **One type pass.** Run any framework's diagnostics inside the authoritative type check, using the editor's diagnostic policy from the same `tsconfig`, so a separate framework-only compiler pass is unnecessary. Folding them in removed a separate `tsc` pass that had cost 10–15 s locally ([If you use Effect](#if-you-use-effect) has ours).
- **Type-aware lint gets a faster backend.** Oxlint gets its type-aware rules from tsrs-lint. Vite+ expects a `tsgolint` binary and has no backend switch yet, so a pnpm override links that package name to a tiny local adapter package whose only export is a symlink to tsrs-lint. The whole adapter, for a layout with it at `lint/tsgolint/`:

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

  The adapter exports only the binary on purpose: with nothing else exported, the framework patcher doesn't go looking for the replaced tsgolint. Use your native checker; a framework's patcher, if you have one, runs in `prepare` ([If you use Effect](#if-you-use-effect)). Check the tool versions together after any upgrade; the override alone doesn't prove they fit.

  In one quiet local run, types took 6.6 s and 3.1 GiB, type-aware lint 13.4 s and 4.5 GiB, and the lint found the same 37 warnings as before. Together that was 105 CPU-seconds, against 169 CPU-seconds and 7.8 GiB for the older setup measured locally on another day. Remove an adapter like this once the tool supports choosing a backend.
- **The type driver runs one native check per project,** largest first, four at a time, and attributes diagnostics to the project that owns the file (`tools/workspace/src/types/`).

## Every file in a project, enforced

- **One root `tsconfig.json`** with no files, referencing every app, library, script and tooling project. Strict base options, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- **A type-coverage guard** lists tracked `.ts` files and fails if any isn't in a project the root reaches, or if lint ignores a hand-written one. Without it, one consolidated check is unsafe: adding missing coverage exposed 44 hidden errors in one program, and lint ignoring the custom-rule folder had hidden 57.

## Type results follow content across worktrees

- **Cache successful projects, not verdicts.** The key covers the contents of every file the previous program listed (`--listFiles`), compiler args, the lockfile, workspace settings, manifests and tsconfigs, and the project's included paths. Paths are relative and hashing uses contents, not mtimes.
- **One machine-wide cache keeps up to 32 versions per project,** so branches sit side by side. Writes are atomic, nothing is saved if inputs changed during the check, and a broken install can't spread its errors to other worktrees.
- **Own the diagnostics, then cache.** Filter diagnostics by the project that owns each file, but keep global and unowned findings, and deduplicate them. Cache a project only when it has no retained diagnostics of its own and the compiler didn't fail. An imported diagnostic owned by another project being checked doesn't by itself forbid reuse.
- **Know what the key assumes.** Installed package bytes aren't hashed; the lockfile stands in for them. So the cache doesn't notice a new module-resolution winner outside every project's includes, such as a hand-made package in an ignored folder. Reinstall or clear the cache after any installation change the lockfile doesn't describe. Before turning on replay, check that adding and renaming a file invalidates, and that an edit and its revert in two worktrees each get the right result.
- **In CI** the cache lives in the checkout and is restored and saved through the Actions cache.
- **Result (local):**

  | Case | Time | Projects replayed |
  |---|---|---|
  | Fresh worktree, before | 17–20 s | 0 of 23 |
  | Fresh worktree, after | 0.4 s | 23 of 23 |
  | After a one-line library edit | 10.8 s | 20 of 23 |
  | After reverting that edit | 0.5 s | 23 of 23 |

- **Put the cache inside the driver, not the task runner.** As separate runner tasks, the first failure stopped its siblings and lost their diagnostics.

## Type-aware lint where it pays

- **Locally: types, then untyped lint everywhere, then type-aware lint on changed files** since the merge base, including uncommitted edits. This is lighter on memory when many agents check at once: the local check took ~11 s and 2.3 GiB, against ~8 GB for full type-aware lint.
- **CI runs type-aware lint on every file,** because a type change can produce a finding in an untouched consumer.
- **Settings for the two passes,** with Oxlint:
  - keep `typeCheck: false` in both, because the types command owns complete checking;
  - in the workspace-wide untyped pass, set `typeAware: false` and turn off unused-disable-directive reporting, since directives for typed rules would otherwise look unused;
  - in the changed-files pass, set `typeAware: true` and turn that reporting back on;
  - choose the pass with one mode variable, and key it in cached lint tasks;
  - run fix passes fresh, never from the cache, and collect every local phase's outcome even after one fails.

  [`tools/workspace/`](../../tools/workspace/) has the split config.
- **Make custom rules cheap.** They skip files that can't trigger them, and cache import closures until a file changes. Compare findings on seeded violations before and after any lint speedup.
- **Shrink the program before adding threads.** Reduce what each program loads: per-icon imports took one program from 4,638 files to 1,663, and an explicit return type stopped repeated inference. This applies to any backend.
- **History, for the earlier Go backend only.** Before tsrs-lint we used Go tsgolint and tuned it. More checker threads replicated types in memory (local: 1 thread took 15.9 s and 3.4 GB, 4 took 11.0 s and 7.1 GB, 8 took 12.6 s and 10.2 GB). A Go memory limit slowed checking 50–80% to save under 2 GB, and its work-stealing scheduler used about 15% less CPU. Go scheduler and memory settings don't apply to tsrs; don't add them there.

## Keep lint config out of the test config

- **Tests load a dedicated test config.** The root config imports it and loads lint settings dynamically, and the lint module may set only `fmt`, `lint` and `run`, anything else fails. Otherwise a lint-rule edit invalidates every Vitest transform and every cached test key: one lint edit had rewritten 452 transforms.
- **Invoke the tool by a stable relative path** (`node node_modules/vite-plus/bin/vp`), because the task runner keyed its own absolute executable path.

## Custom lint rules that guard the shortcuts

- **Complete build inputs.** Production and staging build tasks must list transitive workspace source, manifests and tsconfigs. Before this rule, a deliberately broken dependency source *replayed a successful build*. We use explicit inputs because automatic read tracking hit `spawn EBUSY` on our dev platform.
- **Seeded property tests.** Property tests must use the shared seeded options, so PR runs reproduce, while the sweep picks fresh seeds.
- **Boundaries:** no undeclared package access, no forbidden layer imports, each sandbox or isolate entry's transitive import closure restricted to what that runtime permits, and environment access only at entry points. Find your restricted runtime entry points before applying the isolate rule; for us it covers code that runs inside a sandboxed isolate, not all Worker code.
- **Hygiene:** re-export-only `index.ts` barrels, explicit entry re-exports, reasons on unsafe assertions, and no quadratic accumulator copies.
- **Shared rules live in a published tool** that each repo consumes, with the repo's own domain rules on top. Its tests install the *packed tarball* into a temp consumer, which checks what users actually get.

## No build before checking or testing

Each package exports **source first** under a custom condition, then built types and JS:

```json
"exports": { "./example": {
  "workspace-source": "./src/entries/example.ts",
  "types": "./dist/example.d.mts",
  "import": "./dist/example.mjs"
} }
```

- **Where the condition applies:** TypeScript picks it up through `customConditions`, and Vite, Vitest and the Worker test bundler resolve it too.
- **Publishing** swaps to built-only exports.
- **A guard** requires an exports map and a tracked source target under the first condition of each built entry. Other targets must be tracked files or outputs the package's pack config declares. It refuses generated-source exports, checks declaration entries get built, and checks published exports name only distributable targets (no source condition in `publishConfig.exports`). [`tools/workspace/`](../../tools/workspace/) has it (`node tools/workspace/src/bin.ts package-exports`; its default condition is `workspace-source`, the name used above).
- **Generation reads workspace source** through Vite's runner, never `dist`. Plain Node resolution had read stale or half-rewritten `dist` while a parallel build ran.
- **Dropped:** type-checking against built declarations took 17.8–18.3 s locally, against 6.2–10.4 s from source.

## Generated files

- **Generate in dependency order and write only on change,** so downstream caches stay warm. An unchanged run takes ~0.5 s locally. We tried caching generation and removed it: the replay cost 1–2 s.
- **List every generated artifact:** its source inputs, whether it's tracked, and the command that proves it's fresh. Check tracked outputs against their source, and check ignored bundles with a source-equivalence test.
- **Call generation explicitly** after editing a generator or dependencies, and before its consumers, such as cached tests and the builds and deploys that need it. Hooks only supplement those callers: they miss editor changes, and an install that's already current doesn't rerun preparation.
- **Git hooks** (`core.hooksPath`, set once per clone so every worktree gets them) regenerate after checkout, merge and rebase. They skip revisions that have no dependencies or no generator, print the repair command on failure, and never fail the git operation.
- **Test with a truly fresh checkout.** Initial preparation must succeed with no generated outputs present. Local "cold" runs kept old generated files and hid a bootstrap import bug.

## Find existing code before writing more

Agents duplicate code readily, so we gave them two tools:

- **`symbols find <words>`** (`node tools/workspace/src/bin.ts symbols find`, or `pnpm symbols:find` with the root scripts from [`tools/workspace/`](../../tools/workspace/README.md#set-it-up)) parses top-level declarations with Oxc and ranks matches by name, then doc comment, signature and path. It returns ten matches with signatures and locations. `AGENTS.md` tells agents to run it before writing a function. A local lookup took about 5.4 s before caching, 6.7 s with the new cache cold, and 0.5 s warm: a warm local benefit, not a measured CI one.
- **`symbols check`** (`node tools/workspace/src/bin.ts symbols check <base> HEAD`) fails a new **exact** copy (parameters and locals normalized) and warns on near copies (≥ 85% alike). It ignores tests, types and bodies under 40 syntax nodes, and a `CLONE` comment with a reason allows an intentional copy.
- **The cache holds parsed facts per file,** keyed by content plus the parser and extractor identity. File listing and comparisons always run fresh. Its first cleanup consolidated 12 of 15 exact-copy groups.

## Pin everything, share the tool

- **Exact versions from pnpm's `catalog:`,** with overrides keeping Vite, Vitest and Node types aligned.
- **Node pinned** in `.node-version`, `devEngines` (which can download it) and `engines`; pnpm pinned by `packageManager`.
- **`verifyDepsBeforeRun: false`** (section 14).
- **A reusable static workflow** in the shared repo runs each supplied command, format, lint, types and doc budget, **even if an earlier one failed**, so one run reports every finding.

## If you use Effect

Skip this subsection if your stack doesn't use [Effect](https://effect.website). With it, we did three things:

- **Effect's diagnostics in the one type check.** `effect-tsgo patch --typescript` runs in `prepare`, and the type driver calls `effect-tsgo tsrs`, with the diagnostic policy in `tsconfig`. That folded the language service's rules into the authoritative pass and removed the separate `tsc` pass above. In [`tools/workspace/`](../../tools/workspace/README.md), set the injectable compiler to `["node_modules/.bin/effect-tsgo", "tsrs"]`.
- **The lint adapter alongside it.** The tsgolint adapter above exports only its binary so the Effect patcher doesn't go looking for the replaced tsgolint. Check `effect-tsgo`, tsrs and Oxlint's versions together after any upgrade.
- **Tests that run their Effects,** fake clocks that leave Effect's scheduler alone, and property generators from Schema: [`skills/ci-doctor/references/speed-up-tests/references/effect.md`](../../skills/ci-doctor/references/speed-up-tests/references/effect.md) has those, for agents.
