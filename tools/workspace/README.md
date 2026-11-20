# Workspace tools: one type check, reuse across worktrees, no copied code

The workspace checks behind [guide section 9](../../docs/pages/09-workspace-tooling.md) and [section 21](../../docs/pages/21-optimize-all-of-your-graphs.md)'s package graph, as one small package you copy into your repo. It runs on Node 24 or later with no build: Node runs the TypeScript directly.

| Command | What it does |
| --- | --- |
| `types` | Checks every project the root `tsconfig.json` reaches, one checker run per project, the largest first, four at a time. Each error prints once, in the project that owns its file. Each passing project's result is kept for every worktree on the machine and replayed while nothing it read changed. The checker is yours: stock `tsc`, a native port, or a framework's wrapper. |
| `symbols find <words...>` | The ten best matches for the words among the repo's top-level functions, classes, consts and types, before you write one again. |
| `symbols check <base> [<head>]` | Fails a change that adds an exact copy of a declaration the repo has, and warns on a near copy. `--all` lists every copy already there. |
| `package-exports` | The export guard: each package's `exports` names source first under your source condition, and only files it tracks or its build declares. |
| `package-graph [--unused \| --generate]` | Holds every import across packages to the declared graph in `package-graph.json`, and each layered folder's imports to its layers. `--generate` prints the graph the imports draw today, for a first declaration; `--unused` lists what it allows that nothing uses. |
| `check [--fix]` | The split local check: your steps before lint (the types), untyped lint over every file, then type-aware lint on the files changed since the base. Every step runs. |

`src/lint/config.ts` is the split lint config both passes share.

## Files

| Path | What it is |
| --- | --- |
| `src/bin.ts` | The command. Run it as `node tools/workspace/src/bin.ts <command>`. |
| `src/config.ts` | Reads `workspace-tools.json` at your root. `config.example.json` shows every key. |
| `src/types/` | The type driver (`types.ts`), its cache (`cache.ts`, `inputs.ts`) and project discovery (`projects.ts`) |
| `src/symbols/` | The index (`symbols.ts`), `find.ts`, `check.ts`, and the parser adapter (`parser.ts`) |
| `src/package-exports.ts` | The export guard |
| `src/graph/` | The package graph and layers: the checks (`graph.ts`), the import reader (`imports.ts`) and the command (`command.ts`). `package-graph.example.json` shows the file it reads. |
| `src/lint/config.ts`, `src/lint/check.ts` | The split lint config and the local check |
| `test/` | `node:test` tests. `fixtures/fake-tsc.mjs` is a stand-in checker that keeps the contract below. |

## Set it up

Nothing here is installed before the user approves the plan ([ci-doctor, "Before approval"](../../skills/ci-doctor/SKILL.md#before-approval-read-only)). Each command is its own recipe: take only the ones that fit, and keep what your repo already does well. A plain TypeScript repo with a task runner such as Turborepo starts from its existing `tsc`, its project graph and the runner's ordering. Change those only for a named duplicate pass or a measured bottleneck, and skip the Effect notes entirely.

### Types, symbols and exports

1. Copy this folder to `tools/workspace/` in your repo. Add `tools/workspace/tsconfig.json` to your root `tsconfig.json`'s `references`, so your own type check covers it. It needs `@types/node` where that project can resolve it: in the root's devDependencies, or in this folder's own install.
2. Install, at the root, what the commands you take need:
   - `types`: the checker, `typescript` or whatever your `types.compiler` runs.
   - `symbols`: one parser, `oxc-parser`, or nothing if you already have `rolldown` (Vite 8) or `vite-plus`. `parser.ts` takes the first it finds.
   - `package-exports`: nothing more.
   - `package-graph`: the same parser as `symbols`.
3. Copy `config.example.json` to `workspace-tools.json` at the root and edit it. Every key has a default, so you can leave out what fits. It has no `lint` block: `check` exits 2 with a message until `workspace-tools.json` has one. Add it when you take the split lint command below; `config.lint-vite-plus.example.json` has Vite+'s.
4. Add the root scripts for the commands you took:

   ```json
   {
     "scripts": {
       "check:types": "node tools/workspace/src/bin.ts types",
       "check:exports": "node tools/workspace/src/bin.ts package-exports",
       "check:graph": "node tools/workspace/src/bin.ts package-graph",
       "symbols:find": "node tools/workspace/src/bin.ts symbols find",
       "symbols:check": "node tools/workspace/src/bin.ts symbols check origin/main"
     }
   }
   ```

5. In CI: run `check:types` in the types step with `WORKSPACE_TYPES_CACHE` set to the folder the Actions cache restores and saves. [`templates/github/workflows/ci.yml`](../../templates/github/workflows/ci.yml) already does this; put `pnpm run check:types` (or your package manager's equivalent) in its `<types-command>`. In the static job, run `check:exports`, `check:graph`, and `symbols check <base-ref> HEAD` with history back to the merge base (`HEAD^1 HEAD` when the job checks out the pull request's merge commit). If your repo already runs a type check, replace it with `types`; don't add a second pass.
6. Run the tests below. Then prove the cache on your own checker before you trust its replays (see [Prove it](#prove-it-before-you-trust-replays)).

### The split lint command

Only if type-aware lint is a measured cost. `check` runs four lint commands from `workspace-tools.json`'s `lint` block.

1. Either wire Vite+ with Oxlint, as [Split lint](#split-lint) shows, including the `lint:workspace` and `lint:files` tasks and your list of package folders; or set all four of `workspace`, `workspaceFix`, `changed` and `changedFix` to your own linter's commands.
2. Set `lint.before` to what should run first, for example `[["node", "tools/workspace/src/bin.ts", "types"]]`. It's empty by default, so `check` runs no types unless you say so.
3. Then add the root scripts:

   ```json
   {
     "scripts": {
       "check": "node tools/workspace/src/bin.ts check",
       "check:fix": "node tools/workspace/src/bin.ts check --fix"
     }
   }
   ```

## The type driver

### The checker's contract

Any program works as `types.compiler` when it does these two things. Stock `tsc` does both.

| Call | It must |
| --- | --- |
| `<compiler> --project <config> --showConfig` | Print the resolved config as JSON, with `files` (each included file, relative to the config's folder) and `references` (`[{ "path": … }]`). |
| `<compiler> --project <config> --noEmit --composite false --declaration false --pretty false --listFiles` | Print each diagnostic as `path(line,col): error …` (path from the working folder), or `error …` for a global one, with any continuation lines indented. Print every file the program read as an absolute path, one per line. Exit 0 with no errors, 1 or 2 with errors. Any other exit, or a nonzero exit with no diagnostics, counts as the checker failing. |

How `types.compiler` is read: a word ending in `.js`, `.cjs`, `.mjs` or `.ts` runs under the same Node; a path with a `/` runs from the root; a bare name runs from `PATH`. Give it as an array when a word has a space. `--compiler <command>` overrides it for one run. Unset, it's the root's `typescript/bin/tsc`.

- **Plain TypeScript.** Leave it unset.
- **If you use Effect.** Run `effect-tsgo patch --typescript` in your install's `prepare` script, set `"compiler": ["node_modules/.bin/effect-tsgo", "tsrs"]`, and set the diagnostic policy in your tsconfig's language-service plugin. Effect's rules then come back as type errors from the one pass, so you need no separate framework pass and no lint rule for them.
- **Another stack.** If your checker can't print its files, it can't feed this cache. Use its own incremental mode, and keep only the per-project attribution idea.

### What it keeps, and what it assumes

- A project's key hashes every file its program read (from `--listFiles`), the lockfiles, every `package.json` and `tsconfig*.json` and what their `extends` names, every project's included paths, and the checker's arguments. Paths are relative and contents are hashed, so worktrees at the same contents share keys.
- Only a pass is kept: no error of the project's own, and the checker didn't fail. An error in a file another checked project owns doesn't stop the keep, since that project reports it. Global and unowned errors are reported, never dropped, and each prints once.
- Nothing is kept if a file it read, or a shared input, changed while the checker ran. Writes are atomic renames. Each project keeps its 32 most recently used results.
- **It assumes installed packages match the lockfile.** Files under `node_modules/` stay out of the key, and the lockfile stands for them. Reinstall, or empty the cache folder, after any install the lockfile doesn't describe.
- **It can't see a new module-resolution winner** outside every project's includes, such as a hand-made package in an ignored `node_modules`.
- The folder is `$WORKSPACE_TYPES_CACHE`, else `$XDG_CACHE_HOME/workspace-types/`, else `~/.cache/workspace-types/`.

### Prove it before you trust replays

The tests prove these with the stand-in checker. Do them once with yours, by hand or with the tests' real-`tsc` group:

1. Run twice: the second run replays every project.
2. Add a file to a project, then rename it: every project checks again.
3. With two worktrees at the same commit, run in one, then in the other: the second replays. Edit a library file in the second and run: the projects that read it check again, the rest replay. Revert and run: all replay again.

## Symbols

```sh
node tools/workspace/src/bin.ts symbols find join bytes
```

```text
joined  function, exported  src/bytes.ts:12
  (chunks: ReadonlyArray<Uint8Array>) =>
  The chunks, as one run of bytes.
```

A word in the name counts most, then one in the doc comment, then the signature or path. A match for every word ranks higher, and test files rank lower.

```sh
node tools/workspace/src/bin.ts symbols check origin/main
```

```text
copy: src/upload.ts:30 sendChunks has the same body as writeChunks at src/files.ts:41
near copy: src/loader.ts:44 cachedVersion is storedVersion at src/store.ts:118 with other names in it
```

- It compares the declarations a change adds or changes against every other declaration at the head. A function moved to another file isn't a copy, and copies already on the base are left alone.
- An exact copy fails, and a near copy (85% alike) warns. Under GitHub Actions each copy is an annotation on its line.
- To keep a copy on purpose, put `// CLONE: <why>` directly above it.
- It leaves out tests, types and bodies under 40 nodes, plus declarations, `*.gen.ts`, `dist/`, `node_modules/`, agents' folders and whatever `symbols.skip` names.
- Each file's declarations are kept in `node_modules/.cache/workspace-symbols/`, keyed by path, text, this code and the parser's install. File listing and comparison run fresh every time. Locally, a warm lookup was about a tenth of the time of one before caching, while a cold one cost a little more. That's a local measurement, not a CI one.

**Limits.** It compares whole top-level declarations, so it misses a block copied inside a function. Two bodies with the same shape that call different things are still exact copies; mark them. A body that's mostly one repeated pattern is never a near copy.

**Tuning.** The thresholds are the constants at the top of `check.ts`. Before changing one, replay your last 30 merges and read every copy it reports:

```sh
for merge in $(git log --first-parent --merges -30 --format=%h origin/main); do
  node tools/workspace/src/bin.ts symbols check "$merge^1" "$merge"
done
```

## The export guard

Each package exports **source first**, under your source condition (`workspace-source` unless you set another), then built types and JS. TypeScript reads the condition through `customConditions`; Vite, Vitest and any Worker bundler need it in their resolve conditions too. Publishing swaps to built-only exports.

The guard holds each package in `packageExports.packages` to these rules:

- It has an `exports` map. One nothing imports is `{}`.
- Each built entry gives a tracked source file under the source condition, first.
- Every other target is a tracked file, or an output the package's build declares (`dist/<entry>.mjs`, and `dist/<entry>.d.mts` when it builds types). Built targets needn't be tracked. A `*` pattern matches at least one tracked file.
- No target is generated source (`*.gen.ts`).
- Each entry with a `types` target is built.
- `publishConfig.exports`, what's published, names no source.

Where it reads the build: `vite.config.ts`'s `pack` by default (Vite+). For tsdown, set `"packConfig": "tsdown.config.ts", "packKey": "."`. For another bundler, import `problems()` from `src/package-exports.ts` and pass each package's builds as `{ entry, dts }`.

## The package graph

`package-graph.json`, at the root, declares what each package and app may import of the others, and how each layered folder stacks. Guide [section 21](../../docs/pages/21-optimize-all-of-your-graphs.md) says why; `package-graph.example.json` has every key.

```json
{
  "graph": {
    "@pip/contracts": {},
    "@pip/model": { "@pip/contracts": { "values": ["core"], "tests": ["testing/vectors"] } },
    "@pip/compiler": { "@pip/contracts": { "types": ["checks"] } },
    "@pip/web": { "@pip/model": { "values": ["queue"] }, "@pip/contracts": { "tests": ["core"] } }
  },
  "nodeFiles": { "@pip/compiler": ["src/generate.ts"] },
  "layers": { "packages/cli/src": [["base"], ["terminal", "client"], ["commands"], ["main"]] },
  "layerExceptions": { "packages/cli/src": { "terminal/output.ts": ["commands/help"] } }
}
```

- **`graph`** names every workspace package and app, each with its edges. An edge's entries are `exports` keys without their `./`: `.` for the root, `core` for `./core`, a pattern's folder (`testing/vectors` for `./testing/vectors/*.json`). `values` allows any import; `types` only `import type` and `export type`, since `import { type X }` still loads the module; `tests` any import, from tests and `testing/` modules only.
- **`nodeFiles`** lists, by package, files that run only in Node, which take values on a `types` edge. Tests do too.
- **`layers`** gives a source folder's places from the bottom: a top folder, or a top file without its extension. A file imports its own place and places below; tests import anything.
- **`layerExceptions`** lists, by source, file and module, the imports allowed against the layers. One no import needs fails, so the list only shrinks.

It fails, one line each with the file and line, on: a package missing from the graph; an edge to an app, an entry the target doesn't export, or a package the importer's manifest doesn't list; an import with no edge, through an unlisted entry, of a `tests` entry outside test code, or of a value on a `types` edge; a relative path out of a package; and an import beside or above in a layered folder. Under GitHub Actions each is an annotation too.

```text
packages/compiler/src/runs.ts:3: @pip/compiler doesn't import @pip/model: package-graph.json has no such edge.
apps/web/src/page.tsx:1: @pip/web doesn't import @pip/model/access: its edge to @pip/model lists `queue`. To import another entry point, add it to that edge.
packages/cli/src/base/quote.ts:2: base sits below commands in packages/cli/src, so it imports nothing of it. Move what it needs down, to where both can import it.
```

`packageGraph` in `workspace-tools.json` sets the package folders (`packages/*` and `apps/*` by default), which of them are apps (`apps/*`), and the file. It reads tracked `.ts`, `.tsx`, `.js` and `.jsx` files, leaving out `dist/`, `node_modules/` and `.d.ts`. To adopt it, run `--generate` into `package-graph.json`, fix what it can't declare (an import of an app, a relative path out of a package), turn the check on, then tighten with `--unused`.

**Limits.** It reads imports, so it misses a package reached by a file read from disk or a name in a string; the selector's coverage declarations ([section 4](../../docs/pages/04-run-only-what-a-change-can-reach.md)) hold those. `require()` isn't read. Layers are checked only through relative imports inside the folder.

## Split lint

### The config

`src/lint/config.ts` returns Oxlint settings for one of two passes, picked by `WORKSPACE_LINT_TYPES`:

| Pass | `typeAware` | `reportUnusedDisableDirectives` | `typeCheck` |
| --- | --- | --- | --- |
| Untyped, every file (`WORKSPACE_LINT_TYPES=none`) | `false` | `off`: a directive for a typed rule otherwise reads as unused | `false` |
| Typed, changed files | `true` | `error` | `false`: the type driver owns the type check |

Merge your own rules and plugins over it, and key the mode variable in every cached lint task. If you use Vite+ with Oxlint:

```ts
// lint/config.ts, which vite.config.ts spreads in
import { base, merge, modeVariable } from '../tools/workspace/src/lint/config.ts';

const shared = base();

// Your package folders, e.g. from pnpm-workspace.yaml's globs.
const packageFolders = ['packages/lib', 'apps/web'];

// Exclude only each package folder's listing (which differs between checkouts), and keep its
// direct files as inputs, so a new relevant file still misses the cache.
const lintInputs = [{ auto: true }, ...packageFolders.flatMap((folder) => [`!${folder}`, `${folder}/*`]), '!**/dist/**', '!node_modules/.cache/**'];

export const checkConfig = {
  run: {
    tasks: {
      'lint:workspace': { command: 'vp check', cache: { env: [modeVariable], input: lintInputs } },
      'lint:files': { command: 'vp lint --no-error-on-unmatched-pattern', cache: { env: [modeVariable], input: lintInputs } },
    },
  },
  fmt: merge(shared.fmt, { ignorePatterns: ['vendor/**'] }),
  lint: merge(shared.lint, { jsPlugins: [/* yours */], rules: {/* yours */} }),
};
```

`vp check` is format and lint only. It doesn't check types here: `typeCheck` is off, and the type driver does that. Before you rely on the input exclusions, show that a new source file in a package folder misses the cache and that a new `dist/` or cache folder doesn't.

### The check

`check` runs `lint.before` (the types, say), then `lint.workspace` with `WORKSPACE_LINT_TYPES=none`, then `lint.changed` with the changed files appended: committed since the merge base with `lint.base`, uncommitted, and new untracked files. `--fix` runs `workspaceFix` and `changedFix` instead, fresh, never a cached task, since they write files. Every step runs and is reported; the check fails if any did.

CI lints every file with types, because a type change can trip a rule in a file nobody touched.

## Not ported: what to supply

Each of these is your repo's to write, or is ported elsewhere in this playbook. The contract says what it must do.

| Tool | Command | Input | Output |
| --- | --- | --- | --- |
| Type coverage | `node scripts/docs/type-coverage.ts` ([ported](../../scripts/docs/)) | Root tsconfig, tracked files, your linter's file list | Nonzero, naming each tracked `.ts` no project includes or lint skips |
| Docs budget | `node scripts/docs/docs-budget.ts` ([ported](../../scripts/docs/)) | Tracked Markdown agents load | Nonzero, naming each file over budget |
| Complete build inputs (a lint rule) | your linter | Each production build task's declared inputs, and the workspace packages it imports | A finding when a task's inputs miss a transitive workspace source, manifest or tsconfig. Without it a broken dependency can replay a green build. |
| Isolate imports (a lint rule) | your linter | Each restricted runtime's entry files (sandbox, isolate), and the modules they import | A finding for any import in an entry's transitive closure that the runtime can't run. Name your restricted entries first. |
| Environment at entry points (a lint rule) | your linter | Each module | A finding for environment access (`process.env`) outside declared entry points |
| Seeded properties (a lint rule) | your linter | Test files | A finding for a property test not using the shared seeded options, so a pull request's failure reproduces |
| Barrels and entry re-exports (lint rules) | your linter | `index.ts` files; each file a package's `exports` names | A finding for an `index.ts` that does more than re-export, and for any `export *` or `export * as` in an entry file: an entry re-exports by name only what other packages import ([section 21](../../docs/pages/21-optimize-all-of-your-graphs.md#export-paths-what-an-edit-triggers)) |
| Layers in another language | `<layers-command>`, in the static job | The module tree outside tests, each module's in-crate paths (`crate::` in Rust), and the same layers as `package-graph.json` | Nonzero, naming each import beside or above its place by file and line, and each cycle between modules by its modules |
| Graph measurement | [`scripts/graph/`](../../scripts/graph/README.md) (`node scripts/graph/graph.ts`), which measures where `package-graph` enforces | The workspace's imports, `exports`, layers and task config | Each graph's width, read-only and locally: what one edit selects by package edges, by entries and by the import graph |
| Generation driver | `<generate-command>`, from install's `prepare` and before tests, builds and deploys | Each generator's source inputs, in dependency order | Each generated file written only when it changed; tracked outputs checked fresh in CI (`<generate-check-command>`); ignored bundles checked against their source by tests. It must succeed on a checkout with no generated files. Git hooks may run it too: they skip revisions without the generator and print the repair command on failure. |

## Tests

```sh
cd tools/workspace && npm install    # typescript and @types/node; add oxc-parser for symbols
node --test test/
```

- The type driver's tests use the stand-in checker and need nothing installed. Its real-`tsc` group runs when `typescript` is in this package's `node_modules`, or in the folder `WORKSPACE_TOOLS_NODE_MODULES` names, and skips otherwise.
- The symbol tests, and the package-graph command's, need a parser (`oxc-parser`, `rolldown` or `vite-plus`), and skip with a message without one. The graph's own checks need nothing.
- `npm run typecheck` checks this package with `tsc`.

## Placeholders

| Placeholder | Where | What to put |
| --- | --- | --- |
| `<generated-dir>` | `config.example.json` | A folder of generated code to leave out of `symbols` |
| `<generate-command>`, `<generate-check-command>` | The table above | Your generation driver, and the check that tracked outputs are fresh |
| `<layers-command>` | The table above | Your layer check for a language the linter doesn't read |

Everything else is a default in `workspace-tools.json`, ready to change. The source condition defaults to `workspace-source`, the name the guide uses.
