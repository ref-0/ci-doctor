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

**A repo that checks pull requests in its merge queue is timed there.** When fewer than 5 PR pushes can be timed, the scorer reads the `merge_group` runs of the same days: each group's build is then a push, timed and counted as one, beside the pull requests' own. With 5 or more timed that way the repo is scored, `wait.from` is `merge-queue` instead of `pull-requests`, and the report says "Merge-queue wait". The wait is a group's build, from its first run's start to its last run's end. It leaves out the time a pull request spent in the queue behind other groups, so it's a floor. A repo whose PR pushes can be timed is scored on them alone, and its `merge_group` runs aren't read.

A run that hit its time limit (`timed_out`) is a failed run: its push is red, and timed. The red, rerun and cancelled rates are shares of the pushes that ran something (`wait.ranHeads`), so a push whose runs were all skipped isn't in them. A rerun's first attempt is one call, and a report reads at most 25: past that, reruns count as green only on a rerun as often as the ones read did, and `wait.rerunsUnread` says how many. With none read, that rate is unknown. Rates a week, such as PR pushes and merged PRs, are over the days read: the whole window when every run in it was read, and from the oldest run read when GitHub had more than 1,000. `pull_request_target` runs are read back over the same days, and counted over them. Workflows are told apart by file, so two files with one name aren't one workflow. A workflow whose sampled runs ran no job adds no minutes, and when no workflow's did, the job minutes are unknown, not zero.

## What a score rests on

The score reads only GitHub Actions. So it's withheld, with the reason, when what Actions shows is too thin to stand for the repo's CI:

- **Another CI decides the wait.** On at least 2 of the 3 pushes read, a CI outside Actions, such as Azure Pipelines, CircleCI, Buildkite or Jenkins, was still at work more than a minute after the Actions checks finished. What counts is when each ends after the push, not how long each ran.
- **The Actions checks are small and another CI's config is in the repo.** The p50 wait is under a tenth of what's typical for the repo's size, and the tree holds a file such as `azure-pipelines.yml` or `.circleci/config.yml`, where that CI reads it: a fixture or a page about one doesn't count. If that file is a leftover, delete it.
- **A whole part went unmeasured.** None of the reliability measures, or none of the efficiency ones, could be made. Shard balance and the package and task graphs alone don't carry efficiency.

A scored report carries its confidence, in `evidence.confidence` and on a line under the score:

| Confidence | When |
| --- | --- |
| `high` | 20 or more pushes timed, every measure made, no other CI seen, at least half the job minutes on runners of a known size |
| `medium` | 10 to 19 pushes timed, a measure missing, reruns whose first attempt wasn't read, another CI seen that didn't finish after Actions, the other checks unreadable on any push read, a file tree GitHub cut short under Actions checks small for the repo's size, or under half the job minutes on runners of a known size |
| `low` | under 10 pushes timed, or under 80% of the score's weight measured |

`evidence.reasons` says which, `evidence.measured` is the share of the score's weight that was measured, `evidence.missing` names each measure that wasn't, and `evidence.outsideCi` holds the pushes asked about (`sampled`), those GitHub answered in full (`read`), the configs found and each push another CI was on. Shard balance counts only for a repo that has shards. Review bots, scanners, deploy previews and licence checks aren't CI, and a runner provider's jobs are Actions jobs.

Another CI's minutes on a push run from the push to the latest end known of its work there, so they're a floor. Its work is a check run, or a status context from its first mark after the push to the first that isn't pending. Work counts for the push when it starts within 30 minutes of it, or within 10 minutes of that CI's earlier work ending, as a later stage does: anything later came from another event, such as a rerun or a second pull request on the same commit. Work with no end counts as going until now on a push under a day old, and as unknown on an older one. A push is read only when both its answers came, and one whose check runs go past 300 isn't. The pushes read are people's 3 newest whose runs all finished on the first attempt, across `pull_request` and `pull_request_target`, since only those have an Actions wait to compare. A report with too few timed pushes, or a part already unmeasured, asks for none.

The score doesn't see what the tests prove, what CI costs in money, or checks that run outside GitHub Actions. The report says so under every score.

## How the score is made

Three parts, each 0 to 100 from the measures of it that could be made, weighed into one score:

| Part | Weight | Measures, by their weight inside the part |
| --- | --- | --- |
| Speed | 60 | The p50 wait (20), the p50 wait for the repo's size and main language (15), the p90 wait (5) |
| Reliability | 20 | Pushes green only on a rerun (14), the default branch's red rate (10) |
| Efficiency | 20 | vCPU-minutes for each merged PR, for the repo's size (6); runs for each merged PR (4); setup minutes a job (4); queue time (3); how the jobs are wired (3); shard balance (3) and the package and task graphs (3), each only for a repo that has them |

- **How the jobs are wired** takes a third off for each kind of flag the job graph raises: a job that holds the rest, setup on the path that sets the wait, and a wait no job shows. With no flag, it's unknown, not clean, when no sampled run fits today's workflows or part of the job graph couldn't be read.
- **The package and task graphs** take a quarter off for each kind of flag: a package cycle, an overloaded entry, a root barrel, a cached task with no inputs or with inputs over half the repo, a deep task chain, a task cycle. A repo with one package and no cached task has nothing for them to flag, and isn't measured on it unless a flag is found. A graph that came back partly unknown with no flag is unknown, not clean; so is one with an entry that importers in files not read could still flag, which `graphs.exports.count.undecided` counts.
- **The wait for the size** compares the p50 wait with what's typical for a repo of that many lines, moved by the main language: `LANGUAGE_WAIT` holds each language's factor, such as 1.64 for C and 0.67 for PHP, and a language not listed is 1. The factors are each language's median wait against the size curve across the scored public repos of 23 Nov 2026, pulled toward 1 where a language has few repos.

`detail` gives each measure's own 0 to 100, and null where it wasn't made.

## What efficiency is measured in

- **vCPU-minutes for each merged PR.** A job's minutes times its runner's vCPUs, so a job that finishes in a quarter of the time on a runner four times the size has used the same. The size comes from the job's labels: one named in a label, such as `-16core`, or GitHub's own runners by their documented sizes: its standard ones, 4 on a public repo and 2 on a private one, and its larger macOS ones, 12 and 5. So a private repo's job on a standard runner counts half a public repo's. A runner whose size the labels don't say, such as a self-hosted one, counts as a standard runner's 4, which reads a bigger one too kindly and a smaller one too harshly. `efficiency.sizedShare` is the share of job minutes whose size was known, each workflow's counted by its runs: under half, the report says the score is less sure. `efficiency.jobMinutesPerMergedPr` still gives the plain job minutes.
- **Setup minutes a job.** The time a job spends in setup steps, such as checkout, installs and cache restores, as the mean across a run's jobs: `jobs.setupMinPerJob`. 30 seconds is full marks and 4 minutes is none. `jobs.setupShare`, setup as a share of job time, is still reported, and no longer scored: a fast job with little else to do has a high share and nothing to fix. The setup fix shows over a minute a job, unless that's under 5% of job time.

## What it reads

It computes everything on your machine. Every GitHub read goes through `gh api`, with your own sign-in, so a private repo is read as a public one is:

- the repo's metadata, languages, recent commits and weekly commit counts;
- pull-request and default-branch Actions runs from the last 7 days (`--days`), and the jobs of a few of them;
- the logs of up to 3 jobs, for test-file timings;
- the default branch's file tree, its workflow files, its local actions (each `.github/actions/**/action.yml`, and any other a workflow calls with `uses: ./`, up to 50), its `package.json` and `nx.json`, and the configs the practices read: Dependabot's and Renovate's, the merge-queue tools' (Mergify, bors, Kodiak, Aviator), the task runners' remote-cache switches (`turbo.json`, `.bazelrc`, `settings.gradle`, `pants.toml`, `.moon/workspace.yml`, `vite.config.*`), `.cargo/config.toml` and `.yarnrc.yml`;
- for the stack, each package's manifest (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml` or `Gemfile`), up to 500, and the root's task files, such as a `Makefile` or `justfile`, 100 files to a GraphQL query;
- for the graphs, each npm package's entry files, from its `exports` (or `main` and `module`), the modules they re-export, and the task runners' configs (`turbo.json`, `nx.json`, `project.json`, Vite+'s `vite.config.*`), up to 1,000 files, in the same GraphQL batches;
- merged and opened PRs from the same days, through GitHub's search;
- the check runs and commit statuses on 3 of people's newest PR pushes, two calls each and one more for each further 100 check runs up to 300, to see whether another CI ran there.

Every call names `github.com`, whatever `GH_HOST` says, and turns `gh`'s own telemetry off (`GH_TELEMETRY=false`). Any `gh` version with `gh api` works.

This uses some of your account's hourly API limit: scoring `vitejs/vite` on 19 Nov 2026 took 79 calls, one of them the stack's GraphQL query. The workflow files are one GraphQL query for each 100 of them, up to 200 files; a file that query doesn't give is one more call. The local actions and configs are one GraphQL query for up to 100 of them, and none when the tree has none: a dozen actions cost 1 call. GraphQL queries count against GitHub's separate GraphQL limit. The job graph, which job waits on which and what sets the wait, comes from those workflow files and the sampled runs' jobs, so it adds none unless the repo has more than 200 workflow files: then the sampled workflow's own file, and each local reusable workflow it calls, is one call if it isn't among the 200 read. A reusable workflow called by this repo's full name, such as `owner/name/.github/workflows/build.yml@main`, is local too. A read that fails there leaves that part of the graph unknown, with the reason, rather than stopping the run. The graphs read their files at the tree's blob ids, as the stack does, and reread no manifest: one query for the entry files and task configs, then one for each level of re-exports, 100 files to a query. On 19 Nov 2026 that added 1 to 4 calls a repo, median 3: `trpc/trpc` 4, `TanStack/query` 3, `honojs/hono` 3, `vitejs/vite` 2 and `ngrx/platform` 1. They stop at 1,000 files and 8 levels of re-exports, so they add at most 19. A file that fails to read leaves only the entries that reach it unknown.

**Unknown isn't absent.** When it couldn't check a practice, such as when GitHub cuts a big repo's file tree short or the repo has more than 200 workflow files, that practice shows as `unknown`, with the reason, and no fix is suggested for it. Statistics GitHub is still computing, such as the weekly commit counts, leave the pace unknown for that run. A read that fails for any other reason, such as a 5xx after one retry, a lost connection, a rate limit or a missing permission, stops the run with exit code 1, rather than scoring on partial data.

## What it writes and sends

By default it prints to the terminal and nothing else: no cache, no report files, no network requests besides `gh`'s.

- **Job logs** are read in memory, and only the derived test timings are kept, with test names that hold only name characters: nothing else from a log line is printed or saved. They're never written to disk, even with `--cache`.
- **`--cache`** keeps API answers for up to 24 hours and reuses them. **`--save`** writes the report as JSON. Both go to your user cache folder, never npm's cache: `$XDG_CACHE_HOME/ci-doctor` or `~/.cache/ci-doctor` on Linux, `~/Library/Caches/ci-doctor` on macOS, `%LOCALAPPDATA%\ci-doctor` on Windows, or `CI_DOCTOR_CACHE_DIR`. Each gh account gets its own folder, so one account never sees another's answers. The output says how many answers came from the cache and how old the oldest was.
- **`--standing`** sends a JSON body holding the score and the size class, `{"score":81,"size":"medium"}`, and nothing else: no repo name, account or measurements. It sends to the endpoint `--standing-url` or `CI_DOCTOR_STANDING_URL` names, over https, and refuses a URL with a query, fragment or credentials in it. ci-doctor.ref0.dev doesn't take standings yet, so there's no default. An unscored run sends nothing.
- **`--submit`** adds the report to [ci-doctor-db](https://github.com/ref-0/ci-doctor-db), the public data behind the scores, as a pull request. The next section says what it sends.

## Submitting a report

```sh
npx @ref0/ci-doctor --repo pip/garden --submit
```

It scores the repo and prints the report as usual. Then it says what it will send and where, and through `gh api`, with your sign-in and no clone, forks ci-doctor-db if you have no fork, makes a branch from its default branch, adds one file, `reports/pip__garden/<date>.json`, under the repo's name as GitHub spells it, and opens a pull request. It prints the pull request's link. A submission only adds a file, so it never replaces a report already there: to send the same day's report again, use the pull request that's open. If one of yours that adds that file is still open, it prints that link and sends nothing.

The file is the report `--json` prints, with `submitted: { by, at }`, your GitHub login and the time, and `scorerVersion`, which every report carries. `read` keeps only the call counts, not the cache's folder. Nothing else from your machine is sent: no checkout, no cache, no token.

It refuses, and sends nothing, for a private repo (`--standing` sends only the score and size class), for a checkout with no GitHub remote, for a `--days` other than 7, and for an unscored report: it prints the scorer's reason and says there's nothing to submit.

Before sending, it runs `smokeCheck(text, { path })`, the same function ci-doctor-db's check runs on the pull request. It returns what's wrong, empty when the file passes, and never repeats a string from the file but through `shown`, which keeps only `[\w./:@+-]`, at most 60 characters, in backticks:

1. The file is JSON under 1 MB with the fields that are read, of their types. No string or key holds a control character (newline and tab too), a bidi override, `</ci-report` or a code fence, and none is over 400 characters, but the three that name a package cycle whole, which may run to 8,000.
2. It has a score. It's filed at its repo and date, today's or yesterday's in UTC.
3. The current release made it.
4. Its numbers are in range and in order (p50 ≤ p75 ≤ p90, timed pushes ≤ heads, at least 5 timed), and every fix's and note's link goes into ci-doctor's guide.
5. Its score, grade, band, parts, `detail` and size are what `scoreOf` and `sizeClass` give for its own measures, within a point, and its measures are enough to score by the scorer's own rules: no part with none of its measures, and low confidence when the measured weight is under `MEASURED_LOW`.

ci-doctor-db doesn't score the repo again. Its import keeps who submitted a report, and a repo with only submitted reports isn't measured there.

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
| `--submit` | Add this public repo's report to ci-doctor-db, as a pull request from your fork |

Exit codes: 0 for a report, scored or unscored. 1 when a read fails, or `gh` is missing or signed out. 2 for a usage error, such as an ambiguous remote, or a `--submit` it refuses.

## The practices

`practices` says what the repo does, each `true`, `false` or `null` (`unknown`, with the reason in `practices.unknown`). A practice is `false` only when every place it can live was read and nothing there hinted at it: the workflow files, the local actions a step can run, each tool's config where that tool reads it, and for batching, the bots' pull requests merged in the window. Text after a `#` comment counts for nothing.

Each has a strict detector, the forms each tool documents, and a loose one beside it: words that suggest the practice in a form the strict one doesn't know. When only the loose one fires, the practice is `null`, a line in `unknown` names it and the file, and `practices.hints` holds `{ practice, path, kind }`, never the text matched. `kind` is one of `HINT_KINDS`: `word` (words in a CI file), `config` (a tool's config that doesn't say the practice is on), `job` (a job named for changes whose outputs gate others) and `title` (bots' pull-request titles). `practices.where` gives, for each practice that's `true`, the path that showed it, or `pull requests` for history.

| Practice | Strict forms |
| --- | --- |
| `remoteCache` | Turborepo, Nx Cloud or Nx's self-hosted server, Bazel's `--remote_cache`, BuildBuddy, Develocity or Vite+'s `VP_REMOTE_CACHE` in a workflow or local action, unless it's set off; Nx Cloud in `nx.json`; `--remote_cache=<url>` in `.bazelrc`; a remote `buildCache` in `settings.gradle`; `remote_cache_read = true` in `pants.toml`; `remote.host` in `.moon/workspace.yml` |
| `affected` | Each runner's selection by what changed (`--affected`, `nx affected`, `[<since>]` filters, Jest's `--changedSince` and `--onlyChanged`, Vitest's `--changed`, Pants' `--changed-since`, Lerna's and Yarn's `--since`, Rush's `git:`, `moon ci`, pytest's testmon and picked, Bazel's diff tools, `turbo-ignore`), or a job whose outputs other jobs read, in an `if:`, a step or a matrix, that works from the changed files: a paths-filter or changed-files action, `git diff --name-only`, the compare or pull-request files API, or a local action or script named for changes |
| `depBotsBatched` | Dependabot's `groups` in `.github/dependabot.yml` or `.yaml`; Renovate's groups, grouping presets or schedule in any of its config files or `package.json`'s `renovate`; or a bot's grouped pull request merged in the window, such as "Bump the npm group …". With no bot config and no bot pull requests it's `null`, with nothing to batch, and so is a checkout with no config, which has no pull requests to read |
| `mergeQueue` | GitHub's `merge_group`, Mergify's `queue_rules`, bors' `status`, Aviator's parallel mode. Kodiak and Aviator's default mode are `null`: they test on top of the base only as GitHub's settings ask. A queue set only in a service's settings is in no file, and can't be seen |
| `frozenInstall` | Lockfile-only flags, plus `pnpm install` and Yarn 2+'s `yarn install`, frozen on CI by default, unless turned off |
| `pathFilters` | `paths` or `paths-ignore` on a pull-request trigger, never on `push` alone, or a paths-filter or changed-files action |

`rereadPractices(report, { days, token, cacheDir })` takes a stored report, the JSON `--json` prints, and returns it with `practices`, `fixes` and `notes` read again from the repo as it is now, and `practicesDate`, the day they were. Everything else is as stored. It reads the repo, its tree and files, and one search for the merged pull requests of the last `days` (7).

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

It reads through `gh api` as the CLI does. `token` is passed to `gh` as `GH_TOKEN`, such as a GitHub App's installation token; without it, `gh`'s own sign-in reads. `cacheDir` keeps and reuses answers up to 24 hours old there. `scoreOf` and the other scoring functions are exported too, to re-score a stored report from its inputs, which `inputsOf` reads from it. `smokeCheck(text, { path })` returns what's wrong with a submitted report file, empty when it passes, and `shown` is how its lines print a value from the file.

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
