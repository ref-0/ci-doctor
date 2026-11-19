# Remote task cache on Cloudflare

A Cloudflare Worker that speaks Vite+'s remote task-cache protocol (`vp run`), with **D1** (a SQL database, here the index of results) and **R2** (object storage, here the cached blobs). CI and maintainers' machines share it, so a fresh worktree or a pull request's first run replays what `main` already ran. Why and how it fits: [the guide, section 6](../../docs/pages/06-reuse-work-by-its-real-inputs.md). This README is the one runbook for setting it up.

Reference implementation from a production monorepo; adapt to your repo. **It's for Vite+ only.** For Turborepo, Nx, Bazel or Gradle, start from that runner's own remote cache or a server for its protocol, as [guide section 6's table](../../docs/pages/06-reuse-work-by-its-real-inputs.md#task-runners-and-their-remote-caches) says. Skip this Worker, its scripts and its OIDC example. The trust design below carries over to any self-hosted cache server.

**Nothing here runs before the user approves the plan.** The commands below are for the approved implementation ([PROMPT, "Before approval"](../../skills/ci-doctor/SKILL.md#before-approval-read-only)).

## What's here

| Path | What it is |
|---|---|
| `src/worker.ts` | The Worker: routes, who a request is, rate limits, admission, store logging, the cleanup cron |
| `src/credentials.ts` | HTTP Basic readers and writers by token digest; GitHub OIDC for CI writes |
| `src/digest.ts` | A token's SHA-256, shared with the credential script |
| `src/env.d.ts` | The bindings, matching `wrangler.jsonc` |
| `src/worker.test.ts`, `src/testing/harness.ts` | Invariant tests of policy, admission and buffers, against the Worker in Miniflare. No account needed. They use their own fixture scope and policy, so they pass whatever policy you choose |
| `src/policy.test.ts` | Checks that your filled-in `0003_project.sql` registers the policy you wrote in its `chosen` block |
| `vendor/vite-plus-remote-cache-cloudflare/` | The upstream protocol at a pinned commit, MIT. Its README lists each local change |
| `migrations/` | `0001`, `0002` are upstream's. `0003_project.sql` registers your namespace: **fill in its placeholders** |
| `wrangler.jsonc.example` | Copy to `wrangler.jsonc` and fill in |
| `scripts/credential.ts` | Mints a writer or reader token. The only way to change `WRITERS` / `READERS` |
| `scripts/vp-run.ts` | Local wrapper around `vp run` that adds the machine's writer credential |
| `../templates/github/actions/task-cache/` | CI's side: points a job's `vp run` at the cache |

## Placeholders

| Placeholder | Where | What |
|---|---|---|
| `<project>` | `0003_project.sql`, `wrangler.jsonc` (`NAMESPACE`), both scripts | The namespace: `/projects/<project>` in the URL. Lowercase letters, digits, `-` |
| `<worker-url>` | `0003_project.sql`, `credential.ts` | The Worker's origin, no trailing slash. With `workers_dev: true` it's `https://<worker-name>.` followed by your account's workers subdomain, which the dashboard's Workers overview shows. With your own domain, set `workers_dev: false`, add a route, and use that origin, e.g. `https://task-cache.example.com`. It must be exact: OIDC tokens name it as their audience |
| `<worker-name>` | `wrangler.jsonc` | The Worker's name in Cloudflare |
| `<cloudflare-account-id>` | `wrangler.jsonc` | Your account ID. Not secret, but keep it out of shared templates |
| `<d1-database-name>`, `<d1-database-id>` | `wrangler.jsonc` | From `wrangler d1 create`. The deploy script applies migrations by the `INDEX` binding, so it needs no name |
| `<r2-bucket-name>` | `wrangler.jsonc` | From `wrangler r2 bucket create` |
| `<rate-limit-id-1>`, `<rate-limit-id-2>` | `wrangler.jsonc` | Any two positive integers unique in your account |
| `<org>/<repo>` | `0003_project.sql`, `credential.ts` | The GitHub repository |
| `<github-repository-id>`, `<github-owner-id>` | `0003_project.sql` | `gh api repos/<org>/<repo> --jq '.id, .owner.id'` |
| `<branch>` | `0003_project.sql` | Your default branch, usually `main`. Pass the same to the action's `write-branch` |
| `TASK_CACHE_READ_TOKEN` | `credential.ts`, CI | The repository secret CI reads with. A generic name; rename it in both places if you like |

## Trust: decide who may write what main replays

A cache writer can supply a forged pass or build output for inputs main reads. OIDC authenticates the writer; it doesn't prove the computation. Decide this before you deploy:

1. List every writer: each machine token, and each CI event the migration's policy lets write.
2. List every path that consumes a replayed result: release, deploy, publish.
3. Choose one policy and write it down.

**The design this example ships:**

- **Credentials are digests.** `wrangler.jsonc` holds each credential's name and its token's SHA-256, never a token, so nothing deployed is secret.
- **Pull requests and runs by hand read,** with a read token from a repository secret.
- **Only main's CI writes,** on pushes to the registered branch, with the job's GitHub OIDC token (a short-lived identity token GitHub issues to the job). There's no write secret.
- **Forks** get no secret and run fresh.

That's `pull_requests = 0` in `0003_project.sql`, and in each job that calls the action, `branch-writes: 'false'` with `write-branch` set to your `<branch>`. Issue no machine writers. Local runs then use the local cache only, unless you hand a machine a read-only credential (an adaptation: mint a reader, store it where `vp-run.ts` reads, and set `VP_REMOTE_CACHE=read`).

**The broader policy** the source repo ran, as known development debt: `pull_requests = 1` (same-repository pull requests into the branch and runs by hand on its branches write too), `branch-writes: 'true'`, and one writer per maintainer machine. Every one of those can write what main replays. Choose it only with an independent check that re-verifies what shipping paths replay, or with shipping outputs never coming from the remote cache. This version of the Worker routes one namespace, so giving branches their own namespace is an adaptation.

Sampling hits (re-running a few replayed tasks) catches some faults. It doesn't establish provenance. Write your choice in `src/policy.test.ts`'s `chosen` block, so the tests fail if the migration and the choice drift apart.

## Set it up, step by step

Two people may do this, and **agents never log in for you or read credential files**:

- a **Cloudflare operator**, with rights to create R2 buckets, D1 databases and Workers in the account (steps 1–3 and 5);
- a **GitHub maintainer**, with read access to the repository's metadata and the right to set its Actions secrets (step 6).

0. **Before you start.** Node 24 or later. From this folder, `npm install`, which installs Wrangler. The maintainer runs `gh auth status` and checks it shows the account and repository they mean.

1. **Log in.** The operator runs `npx wrangler login` and picks the account. A login can see several accounts, so name yours for every command:

   ```sh
   export CLOUDFLARE_ACCOUNT_ID=<cloudflare-account-id>
   npx wrangler whoami
   ```

2. **Create the bucket and the database.**

   ```sh
   npx wrangler r2 bucket create <r2-bucket-name>
   npx wrangler d1 create <d1-database-name>      # prints the database_id
   ```

3. **Set R2's lifecycle rule,** as a backstop behind the Worker's own 7-day cleanup: delete any object after **9 days**, and abort incomplete multipart uploads after **1 day**. In the dashboard: R2 → the bucket → Settings → Object lifecycle rules. Or:

   ```sh
   npx wrangler r2 bucket lifecycle add <r2-bucket-name> task-cache-expiry --expire-days 9 --abort-multipart-days 1
   ```

   (Check `npx wrangler r2 bucket lifecycle add --help` for your Wrangler's flag names.)

4. **Configure.** Choose the trust policy above first. Run `npm test`. Then:
   - copy `wrangler.jsonc.example` to `wrangler.jsonc` and fill it in, leaving `WRITERS` and `READERS` empty;
   - fill in `migrations/0003_project.sql`, with `pull_requests` set to your policy;
   - fill in the Configure blocks at the top of `scripts/credential.ts` and `scripts/vp-run.ts`;
   - set `chosen` in `src/policy.test.ts` to the same policy.

   Run `npm test` again. The invariant tests pass before and after you fill things in. If one passes only before, a placeholder you filled in broke a statement. If only `policy.test.ts` fails, the migration and `chosen` disagree: fix whichever is wrong.

5. **Deploy, with no credentials yet.** Migrations first, then the Worker:

   ```sh
   npm run deploy     # wrangler d1 migrations apply INDEX --remote && wrangler deploy
   ```

   With empty `WRITERS` and `READERS`, every request gets 401 until step 6's digests deploy. That's expected. After the first deploy, prefer **Workers Builds**: connect the repo in the dashboard, set the root directory to this folder, the deploy command to `npm run deploy`, and trigger on changes to this folder and your lockfile. Then a merge that changes a digest deploys it, and nobody needs a deploy token.

   Wrangler can't read Workers Builds' logs. To debug a failed build, install [Cloudflare's `cf` CLI](https://developers.cloudflare.com/cf/get-started/) (`npm install --global cf`), log in yourself with `cf auth login` (it doesn't reuse Wrangler's login), find other commands with `cf cli search "<task>"`, and read the log with `CLOUDFLARE_ACCOUNT_ID=<cloudflare-account-id> cf builds logs get <build-id>`. Keep downloaded logs private.

6. **Give CI a read token.** The maintainer runs:

   ```sh
   node scripts/credential.ts reader ci
   ```

   It sets the repository secret through `gh secret set`'s standard input and writes only the token's SHA-256 under `READERS.ci`. Merge, and let the deploy carry it, before you turn on any client. **CI writes with GitHub OIDC**, so there's no write secret: jobs that write need `permissions: id-token: write`.

7. **Add CI's action.** Copy `../templates/github/actions/task-cache/` into your repo's `.github/actions/`, fill in its URL, and call it in each job that runs `vp run`, **before** the dependency install, so tasks the install runs can hit too. Set its inputs to the policy: `write-branch: <branch>`, and `branch-writes: 'false'` for main-only writes or `'true'` for the broader policy.

8. **Local runs.** Copy `scripts/vp-run.ts` into the consuming workspace's root `scripts/`, so it resolves that workspace's `vp`, and point the root `build` and `check` scripts at it. Under main-only writes, stop here: without a credential file it uses the local cache alone. Under the broader policy, add a writer per maintainer machine (below).

9. **Prove a hit.** On main, after CI has pushed a run through the action, take a second clean checkout with a fresh local store (for example a new worktree with `node_modules/.vite` absent), run one harmless cached task, and see `◉ remote cache hit, replaying`. Then read `npx wrangler tail <worker-name>` while CI stores, and check the stores come from the events your policy allows.

## Add a writer

Only under the broader policy. A writer reads and writes, from one machine.

```sh
node scripts/credential.ts writer <name>
```

It writes the token to `~/.config/<project>/task-cache.json`, mode 0600, and the token's SHA-256 under `WRITERS.<name>` in `wrangler.jsonc`. Merge that, and the deploy carries it. Until the deploy, the Worker refuses the new token. Running it again for the same name replaces the token. To remove a writer, delete its line and merge.

## Rotate the read token

```sh
node scripts/credential.ts reader ci
```

Between the secret's change and the deploy, CI's reads get **401**, which Vite+ treats as misses: jobs pass, only slower. A token never goes on a command line or into a log.

## What hits and misses look like

`vp run` prints each task's source:

```text
~/packages/lib$ vp pack ◉ remote cache hit, replaying
~/packages/lib$ vp pack ○ cache miss: <why>, executing
```

When the remote tier fails, the reason says so: `remote cache fetch failed`. A failed upload prints at the end, and the task still passes:

```text
vp run: <package>#build:cached not uploaded to the remote cache: network error.
```

`vp run --last-details` summarizes, e.g. `3 cache hits (2 remote)`. Server side, `npx wrangler tail <worker-name>` shows each store's log line: `operation: "store"`, its status and who made it, never a token. `VP_REMOTE_CACHE=off` turns the remote tier off for one run.

**Status codes:**

| Code | Meaning |
|---|---|
| 401 | Missing or unknown credential, or a token that isn't that credential's |
| 403 | A reader tried to write, writes are off, or a run's OIDC token failed the write policy (wrong repo, event, branch or audience). Under main-only writes, a pull request that asks to write gets this: set its action's `branch-writes` to `'false'` |
| 404 | Unknown route, another namespace, a query string, or a missing blob |
| 413 | Past a size limit (key, value 8 MiB, metadata, blob, whole store). **Vite+ doesn't report it** |
| 429 | Past a rate limit |
| 503 | D1, R2 or GitHub's keys unreachable, the memory budget exceeded, or the namespace's entry/byte limit full |

## Pitfalls

the guide, section 6 has the detail. The ones that cost the most:

- **One result per task key.** Two branches building the same task keep replacing each other's result, so each misses. Salt build and lint commands with a source digest. A miss after a revert is this, not a fault.
- **Absolute checkout paths** in task commands or plugin paths: each worktree misses everything.
- **Different program paths:** `vp` in one job and `pnpm exec vp` in another miss each other on identical source.
- **Directory listings, tool caches, temp report files and per-job env vars** in a task's inputs move every key. A flake report written into the repo root once invalidated everything.
- **Entry limits too small.** A lockfile change gives every task a new key. With 2,000 entries the cache filled in a day and refused every upload with 503.
- **A value past 8 MiB** is refused, and Vite+ says nothing. Watch for 413s in `wrangler tail`.
- **Duplicating the remote cache in the Actions cache** hides whether remote reuse works at all.
- **Mutation probes** write their altered state and evict useful entries. Run them with `VP_REMOTE_CACHE=off`.
- **Rotating the read token** gives 401s until the new digest deploys.
- **A client and Worker policy that disagree:** an action asking to write where the Worker says no gets 403s on every upload, which Vite+ treats as uploads not made.
