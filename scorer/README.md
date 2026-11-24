# @ref0/ci-doctor

Scores your repo's CI from 0 to 100, on your machine, and lists what to fix first, with a link to ci-doctor's guide for each fix. It also prints how to install ci-doctor's skills in your agent.

```sh
npx @ref0/ci-doctor               # score the repo this checkout belongs to
npx @ref0/ci-doctor agents skills # how to install ci-doctor's skills, per agent
```

It needs Node 24 or newer and the [GitHub CLI](https://cli.github.com), signed in with `gh auth login`. A private repo needs the `repo` scope (`gh auth refresh -s repo`).

## Which repo

Run it in a Git checkout. If the checkout's `package.json` pins a Node version in `devEngines` that isn't yours, npm refuses to run `npx` there (`EBADDEVENGINES`): run it from outside the checkout with `--repo owner/name`, or add `--force`. It scores the GitHub repo that `origin` points at. If `origin` isn't on github.com, it takes the only remote that is. If several remotes point at GitHub and none is `origin`, it stops and asks you to name one with `--repo owner/name`. `--repo` also works outside a checkout.

A checkout with no GitHub remote has no Actions history to read. It then lists what it finds in the checkout's tracked files, says "unscored" and gives the reason. A repo with no pull-request runs in the window, or fewer than 5 timed PR pushes, is unscored too, with its practices still listed. A PR push is timed from its first run's start to its last run's end. It isn't timed when a bot made it, and a failed run that took over an hour with no jobs is left out, since it never ran: GitHub failed it while it waited, such as a fork's run nobody approved. When bots made nearly every push, the reason says so.

A run that hit its time limit (`timed_out`) is a failed run: its push is red, and timed. The red, rerun and cancelled rates are shares of the pushes that ran something (`wait.ranHeads`), so a push whose runs were all skipped isn't in them. A rerun's first attempt is one call, and a report reads at most 25: past that, reruns count as green only on a rerun as often as the ones read did, and `wait.rerunsUnread` says how many. With none read, that rate is unknown. Rates a week, such as PR pushes and merged PRs, are over the days read: the whole window when every run in it was read, and from the oldest run read when GitHub had more than 1,000. `pull_request_target` runs are read back over the same days, and counted over them. Workflows are told apart by file, so two files with one name aren't one workflow. A workflow whose sampled runs ran no job adds no minutes, and when no workflow's did, the job minutes are unknown, not zero.

## What a score rests on

The score reads only GitHub Actions. So it's withheld, with the reason, when what Actions shows is too thin to stand for the repo's CI:

- **Another CI decides the wait.** On at least 2 of the 3 pushes read, a CI outside Actions, such as Azure Pipelines, CircleCI, Buildkite or Jenkins, ran longer than the Actions checks did.
- **The Actions checks are small and another CI's config is in the repo.** The p50 wait is under a tenth of what's typical for the repo's size, and the tree holds a file such as `azure-pipelines.yml` or `.circleci/config.yml`. If that file is a leftover, delete it.
- **A whole part went unmeasured.** None of the reliability measures, or none of the efficiency ones, could be made.

A scored report carries its confidence, in `evidence.confidence` and on a line under the score:

| Confidence | When |
| --- | --- |
| `high` | 20 or more pushes timed, every measure made, no other CI seen |
| `medium` | 10 to 19 pushes timed, a measure missing, reruns whose first attempt wasn't read, another CI seen running no longer than Actions, or the other checks unreadable with this sign-in |
| `low` | under 10 pushes timed, or under 80% of the score's weight measured |

`evidence.reasons` says which, `evidence.measured` is the share of the score's weight that was measured, `evidence.missing` names each measure that wasn't, and `evidence.outsideCi` holds the configs found and what ran on the pushes read. Shard balance counts only for a repo that has shards. Review bots, scanners, deploy previews and licence checks aren't CI, and a runner provider's jobs are Actions jobs.

The score doesn't see what the tests prove, what CI costs in money, or checks that run outside GitHub Actions. The report says so under every score.

## What it reads

It computes everything on your machine. Every GitHub read goes through `gh api`, with your own sign-in, so a private repo scores the same as a public one:

- the repo's metadata, languages, recent commits and weekly commit counts;
- pull-request and default-branch Actions runs from the last 7 days (`--days`), and the jobs of a few of them;
- the logs of up to 3 jobs, for test-file timings;
- the default branch's file tree, its workflow files and its `package.json`, `nx.json`, `.github/dependabot.yml` and Renovate config;
- for the stack, each package's manifest (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml` or `Gemfile`), up to 500, and the root's task files, such as a `Makefile` or `justfile`, 100 files to a GraphQL query;
- for the graphs, each npm package's entry files, from its `exports` (or `main` and `module`), the modules they re-export, and the task runners' configs (`turbo.json`, `nx.json`, `project.json`, Vite+'s `vite.config.*`), up to 1,000 files, in the same GraphQL batches;
- merged and opened PRs from the same days, through GitHub's search;
- the check runs and commit statuses on 3 of people's newest PR pushes, two calls each, to see whether another CI ran there.

Every call names `github.com`, whatever `GH_HOST` says, and turns `gh`'s own telemetry off (`GH_TELEMETRY=false`). Any `gh` version with `gh api` works.

This uses some of your account's hourly API limit: scoring `vitejs/vite` on 19 Nov 2026 took 79 calls, one of them the stack's GraphQL query. Each workflow file is one more call, up to 40. GraphQL queries count against GitHub's separate GraphQL limit. The job graph, which job waits on which and what sets the wait, comes from those workflow files and the sampled runs' jobs, so it adds none unless the repo has more than 40 workflow files: then the sampled workflow's own file, and each local reusable workflow it calls, is one call if it isn't among the 40 read. A read that fails there leaves that part of the graph unknown, with the reason, rather than stopping the run. The graphs read their files at the tree's blob ids, as the stack does, and reread no manifest: one query for the entry files and task configs, then one for each level of re-exports, 100 files to a query. On 19 Nov 2026 that added 1 to 4 calls a repo, median 3: `trpc/trpc` 4, `TanStack/query` 3, `honojs/hono` 3, `vitejs/vite` 2 and `ngrx/platform` 1. They stop at 1,000 files and 8 levels of re-exports, so they add at most 19. A file that fails to read leaves only the entries that reach it unknown.

**Unknown isn't absent.** When it couldn't check a practice, such as when GitHub cuts a big repo's file tree short or the repo has more than 40 workflow files, that practice shows as `unknown`, with the reason, and no fix is suggested for it. Statistics GitHub is still computing, such as the weekly commit counts, leave the pace unknown for that run. A read that fails for any other reason, such as a 5xx after one retry, a lost connection, a rate limit or a missing permission, stops the run with exit code 1, rather than scoring on partial data.

## What it writes and sends

By default it prints to the terminal and nothing else: no cache, no report files, no network requests besides `gh`'s.

- **Job logs** are read in memory, and only the derived test timings are kept, with test names that hold only name characters: nothing else from a log line is printed or saved. They're never written to disk, even with `--cache`.
- **`--cache`** keeps API answers for up to 24 hours and reuses them. **`--save`** writes the report as JSON. Both go to your user cache folder, never npm's cache: `$XDG_CACHE_HOME/ci-doctor` or `~/.cache/ci-doctor` on Linux, `~/Library/Caches/ci-doctor` on macOS, `%LOCALAPPDATA%\ci-doctor` on Windows, or `CI_DOCTOR_CACHE_DIR`. Each gh account gets its own folder, so one account never sees another's answers. The output says how many answers came from the cache and how old the oldest was.
- **`--standing`** is the only thing that ever sends anything. It sends a JSON body holding the score and the size class, `{"score":81,"size":"medium"}`, and nothing else: no repo name, account or measurements. It sends to the endpoint `--standing-url` or `CI_DOCTOR_STANDING_URL` names, over https, and refuses a URL with a query, fragment or credentials in it. ci-doctor.ref0.dev doesn't take standings yet, so there's no default. An unscored run sends nothing.

## Options

| Option | What it does |
| --- | --- |
| `--repo owner/name` | Score this GitHub repo instead of the checkout's remote |
| `--days <n>` | How many days of runs to read, 1 to 90. Default 7 |
| `--json` | Print the report as JSON |
| `--cache` | Reuse API answers up to 24 hours old, kept per gh account |
| `--save` | Save the report as JSON beside the cache |
| `--standing` | Send the score and size class, and nothing else |
| `--standing-url <url>` | The endpoint `--standing` sends to |

Exit codes: 0 for a report, scored or unscored. 1 when a read fails, or `gh` is missing or signed out. 2 for a usage error, such as an ambiguous remote.

## The stack

The report's `stack` says what the repo is built with, so repos can be compared by what they share: languages with their shares and packages by ecosystem, as the profile has them; the package managers and workspace tools, such as pnpm, Turborepo or a Cargo workspace; every test runner found; the lint and format tools; the 20 libraries the most packages depend on, leaving out the workspace's own packages and the tools named in the other fields; the sampled jobs by runner provider; and agent files such as `AGENTS.md` and `.cursor/rules`. Examples, fixtures, templates and vendored code don't count.

`stack.graph` is the workspace's package graph, from the same manifests: each package's edges to the workspace's other packages, of any dependency kind, and for an npm package its `exports` (how many entries, and whether one is the root `.`). Its packages are the ones each workspace declares: npm, Yarn and Bun's `workspaces`, pnpm-workspace.yaml's `packages` with its `!` exclusions, Cargo's `members` and `exclude` (and members' path dependencies), go.work's `use` and uv's workspace members; a manifest no workspace declares around stands alone, as its own package. An edge goes to the package of the same ecosystem by its real name, through npm aliases (`npm:`, `workspace:b@*`) and Cargo's `package =` renames and inherited `[workspace.dependencies]`, or to the member at a dependency's path (`file:`, `link:`, `path =`). For the repo it gives the package and edge counts, the cycles between packages (`{ ecosystem, packages }`), the longest chain of dependencies, and the 5 packages the most others depend on (`{ name, ecosystem, dependents }`). Those numbers are `null` unless every manifest, and every file that declares a workspace, was read and parsed. As with the practices, a field is `unknown` (`null` in the JSON) when nothing was found and some of what it reads couldn't be, and `stack.unknown` says why.

## The graphs

The report's `graphs` are four of [guide section 21](../docs/pages/21-optimize-all-of-your-graphs.md)'s five graphs, as far as they can be read without a checkout. Each is `{ count, nodes, edges, flags, flagCounts, unknown }`, in the shape [`scripts/graph/`](../scripts/graph/README.md#json)'s `--json` uses where they overlap, and every count has its denominator. Lists hold at most 300 nodes and edges, and 20 flags of a kind; `count` and `flagCounts` say how many there are.

- **`packages`** (1): the package graph above, with each package's dependencies, dependents and depth, and a `package-cycle` flag for each cycle.
- **`exports`** (2): each npm package's entries: every exact `exports` key resolved to its file by Node's rules (conditions in document order, the first tracked target, `dist/` mapped to `src/` by convention), each `*` pattern as one entry with the files it matches, and `.` from `main`, `module` or `source` without `exports`. For each it follows `export *` and `export { } from` through the package and into other workspace packages' entries, and counts the modules re-exported (`reexports`), the `export *` statements (`stars`), whether the file is a barrel, the packages that import it (`importedBy`) and those that depend on its package directly or not (`dependents`). An entry with `import` and `require` files counts both files' re-exports, and a cycle back to the entry doesn't count the entry. `importedBy.packages` is exact when `exports` gives the package one entry, or when every importer of the package was seen importing this one in the files read. Otherwise it's null, with `atLeast`, the packages seen importing this entry, and `atMost`, every package that imports the package by manifest. **Overload** is `reexports` × `importedBy.packages` (`overload`), or × `atLeast` and × `atMost` (`overloadAtLeast`, `overloadAtMost`). `overloaded-entry` flags an entry at 20 modules or more to 3 packages or more, exact or seen, never on `atMost` alone. `THRESHOLDS` in `graph-core.ts` says why. `root-barrel` flags a root entry of only re-exports, with `export *`, that another package is seen importing. `worst` is the entry with the most overload, exact or at least, and the share of packages behind it. An entry is unknown, with `unknown` saying why, when it resolves to no tracked file, when a file it reaches couldn't be read, when it re-exports a workspace file or entry that resolves to nothing, or when the walk's bound cut it, 8 re-exports deep from that entry or at 1,000 files (`reexportsAtLeast` has what it found).
- **`layers`** (3): nothing. It needs every file, so `scripts/graph/` measures it.
- **`tasks`** (4): the task graph from `turbo.json` (and packages' own), `nx.json` and `project.json`, Vite+'s `run` and package scripts: each task's runner, whether a cache keys it, its declared inputs and how many tracked files they cover, and `dependsOn`, `^task`, script-call and fan-out edges. A package's `pkg#task` replaces the generic task, as Turborepo has it, and `^task` passes through a package without the task to the packages behind it. Turborepo's `inputs: []` is its default inputs, every file of the package. Nx's target defaults apply by executor, then name, then glob, and `^named` inputs by each dependency's own named inputs. Flags: `no-inputs` (cached, with no inputs declared, so any change in the package misses, or Nx's or Vite+'s empty ones, so a source change hits), `wide-inputs` (cached, with inputs over half the repo's files), `deep-chain` (6 tasks or more in a row) and `task-cycle`. When GitHub cuts the tree listing short, the input counts are unknown and nothing is flagged wide. Nx's dependencies inferred from imports aren't seen.
- **`jobs`** (5): the job graph's jobs and `needs` edges from one sampled run, the chain that sets the wait, and the `top-blocker`, `setup-in-path` and `hidden-wait` flags behind its fixes.

The text report's "Graphs" block lists the flags first, one line a kind, then a line per graph, and the `<ci-report>` block takes up to three of graphs 1, 2 and 4's flags. Their fixes link section 21.

## From code

`scoreRepo` returns the report `--json` prints, so a script can score repos without the CLI:

```ts
import { scoreRepo } from '@ref0/ci-doctor';

const report = scoreRepo('vitejs/vite', { days: 7, token: process.env.GH_TOKEN });
console.log(report.score, report.stack.testRunners, report.read.calls);
```

It reads through `gh api` as the CLI does. `token` is passed to `gh` as `GH_TOKEN`, such as a GitHub App's installation token; without it, `gh`'s own sign-in reads. `cacheDir` keeps and reuses answers up to 24 hours old there. `scoreOf` and the other scoring functions are exported too, to re-score a stored report from its inputs.

## Windows

The CLI uses native paths throughout and finds `gh.exe` and `git.exe` on `PATH`. Two things rely on POSIX behaviour:

- Files written by `--cache` and `--save` are created readable only by you (mode 600, folders 700). Windows ignores these modes, so the files get your user folder's usual permissions.
- The tests' `gh` stub is a Node script with a shebang, found through POSIX `PATH` lookup, so `npm test` runs on Linux and macOS only.

## Developing

```sh
npm install
npm test        # builds dist/ with tsc, then runs node:test against it
npm run check   # type-checks the source and the tests
npm pack        # builds, then packs dist/ and this README
```

The tests put a `gh` stub first on `PATH` that serves canned API answers, so no test touches GitHub.
