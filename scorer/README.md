# @ref0/ci-doctor

Scores your repo's CI from 0 to 100, on your machine, and lists what to fix first, with a link to ci-doctor's guide for each fix. It also prints how to install ci-doctor's skills in your agent.

```sh
npx @ref0/ci-doctor               # score the repo this checkout belongs to
npx @ref0/ci-doctor agents skills # how to install ci-doctor's skills, per agent
```

It needs Node 24 or newer and the [GitHub CLI](https://cli.github.com), signed in with `gh auth login`. A private repo needs the `repo` scope (`gh auth refresh -s repo`).

## Which repo

Run it in a Git checkout. If the checkout's `package.json` pins a Node version in `devEngines` that isn't yours, npm refuses to run `npx` there (`EBADDEVENGINES`): run it from outside the checkout with `--repo owner/name`, or add `--force`. It scores the GitHub repo that `origin` points at. If `origin` isn't on github.com, it takes the only remote that is. If several remotes point at GitHub and none is `origin`, it stops and asks you to name one with `--repo owner/name`. `--repo` also works outside a checkout.

A checkout with no GitHub remote has no Actions history to read. It then lists what it finds in the checkout's tracked files, says "unscored" and gives the reason. A repo with no pull-request runs in the window, or fewer than 5 timed PR pushes, is unscored too, with its practices still listed.

## What it reads

It computes everything on your machine. Every GitHub read goes through `gh api`, with your own sign-in, so a private repo scores the same as a public one:

- the repo's metadata, languages, recent commits and weekly commit counts;
- pull-request and default-branch Actions runs from the last 7 days (`--days`), and the jobs of a few of them;
- the logs of up to 3 jobs, for test-file timings;
- the default branch's file tree, its workflow files and its `package.json`, `nx.json` and `.github/dependabot.yml`;
- merged and opened PRs from the last 7 days, through GitHub's search.

Every call names `github.com`, whatever `GH_HOST` says, and turns `gh`'s own telemetry off (`GH_TELEMETRY=false`). Any `gh` version with `gh api` works.

This uses some of your account's hourly API limit: scoring `vitejs/vite` on 19 Nov 2026 took 78 calls. Each workflow file is one more call, up to 40.

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
