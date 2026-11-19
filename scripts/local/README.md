# Local: fast feedback, and many agents on one machine

These are the scripts behind local runs: which tests sit near a change, one machine-wide pool of test slots, the remote task cache for machines that hold a writer token, and two housekeeping timers for a machine many worktrees share.

Why each exists, with the numbers: [guide section 14](../../docs/pages/14-local-speed-and-many-agents-on-one-machine.md) ([fast local feedback](../../docs/pages/14-local-speed-and-many-agents-on-one-machine.md#fast-local-feedback), [sharing one machine](../../docs/pages/14-local-speed-and-many-agents-on-one-machine.md#sharing-one-machine)). The task cache itself, and how to set up its Worker and tokens: [guide section 6](../../docs/pages/06-reuse-work-by-its-real-inputs.md#a-remote-task-cache-with-tests-as-tasks) and [step by step](../../docs/pages/06-reuse-work-by-its-real-inputs.md#setting-up-the-remote-task-cache-on-cloudflare-step-by-step).

## Files

| File | What it does | Where it runs |
| --- | --- | --- |
| `near-tests.ts` | Picks the test files near a local change. It compares the working tree (uncommitted and new files included, through a temporary index) with the merge base. Each pick is filed as `changed`, `named` (named for a changed module or a direct importer of one), `importing` (imports one directly) or `reaching` (under a changed config's folder, or a rule you add). A `LOCAL_EVERY` path or a root config picks every test. Prints `local=<JSON>`, or the files with `--files`. | Local, before `test:cached` runs groups |
| `near-tests.test.ts` | Tests for the picking. `node --test near-tests.test.ts` | Anywhere |
| `test-slots.ts` | The machine-wide pool. A test file starts only while fewer than the cap run, across every worktree. The cap is `TEST_SLOTS` when set, else `max(2, floor(availableParallelism / 4))`. Each slot is a `flock`ed file in `/tmp/<project>-test-slots-<uid>`, held by a Perl child, so a killed run lets go. | Local |
| `test-file-slot.ts` | A Vitest setup file. It takes a slot before each test file, gives it back after the file's own hooks, and appends the wait and the run to `$XDG_STATE_HOME/<project>/test-slots.jsonl`. CI takes no slot. | Every local Vitest run |
| `check-static.ts` | Runs CI's static and lint jobs' steps locally, one after another, and stops at the first failure. CI checks a PR's merge from `HEAD^1` to `HEAD`; here each range check runs from the merge base with `origin/main` to `HEAD`, which covers the same commits. Commit first, then run it once before pushing. Configure `defaultBranch` and `staticSteps`; their placeholders are `ci.yml`'s `<generated-files-check-command>`, `<types-command>` and `<lint-command>`, and a placeholder left in stops the run with exit 2. | Local, before a push |
| `check-static.test.ts` | `node --test check-static.test.ts` | Anywhere |
| `test-slots.test.ts` | Tests for taking slots: waiting while all are held, taking a free one beside a held one, and the times each turn reports. `node --test test-slots.test.ts` | Anywhere |
| `task-cache.ts` | Reads `~/.config/<project>/task-cache.json` (mode 0600). `remoteCacheUrl()` feeds your root config, and the CLI wraps `vp run` with `VP_REMOTE_CACHE=read-write`. CI's own variables win, and `VP_REMOTE_CACHE=off` skips the remote cache for one run. | Machines with a writer token |
| `rust-target-sweep.ts`, `.service`, `.timer` | Best-effort cleanup of a worktree's Rust `target/`, when three checks pass: no process it can see uses the worktree (from `/proc`), its branch is merged or its PR is closed, and nothing else in it changed in 24 h. It checks again right before deleting, which narrows the race but doesn't close it. Processes it can't read are skipped, not counted. Dry run by default. The timer fires Sundays at 04:00. | Shared machine, systemd user timer |
| `rust-target-sweep.test.ts` | Tests for the three checks: what counts as in use, what counts as a change outside the target, a merged HEAD, and the sizes it reports. Needs `git`, never calls `gh`. `node --test rust-target-sweep.test.ts` | Anywhere with `git` |
| `tmp-sweep.sh`, `.service`, `.timer` | Best-effort cleanup of your own top-level `/tmp` entries when nothing in them changed for N days (ctime is ignored under `node_modules`) and no process held one, as a cwd, an fd, a mapping or a bound unix socket, in its one `/proc` snapshot at the start. System and runtime folders are skipped, and so is the test-slot pool's folder, always, plus anything `TMP_SWEEP_KEEP` adds. Dry run by default. Runs every 6 h at `Nice=19` with idle IO. | Shared machine, systemd user timer |

## What the machine needs

Each piece is optional. Check the ones you use:

| For | Install and check |
| --- | --- |
| Test slots | Perl with `Fcntl` (for `flock`). Without Perl, `test-slots.ts` warns and runs the file with no slot, so the bound is silently gone. Check, with no other test runs on the machine: in **both** shells set the same temporary cap and pool (`export TEST_SLOTS=1`, the same `PROJECT`), hold a slot in one with a slow test file, start a second run in the other, and see it wait. Then go back to the common launch setting. |
| The housekeeping timers and the spend watcher | Linux with `/proc`, Bash 4+, GNU coreutils and findutils, Node 24 or later, and a working systemd user manager (`systemctl --user status`). Run `loginctl enable-linger` if they must run while you're logged out. Give each unit a `PATH` holding the CLIs it calls (`git`, `gh`, `blacksmith`). |
| The Rust sweep | Node 24 or later, `git`, and `gh` logged in with read access to the repo's pull requests |
| Anything else | On macOS or another OS, adapt the scripts and use its scheduler (launchd, cron), or mark them as not applying. |

Make the folders the install steps below write to: `mkdir -p ~/.local/bin ~/.config/systemd/user`.

## Wire it in

Each piece is set up only once the user approves the plan, and a timer is a new scheduled job that needs its own yes ([PROMPT, "Before approval"](../../skills/ci-doctor/SKILL.md#before-approval-read-only)).

### 1. Test slots

```ts
// test.config.ts (your Vitest config)
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // First, so the slot is let go last, after the file's own harness has closed.
    setupFiles: [fileURLToPath(new URL('./scripts/local/test-file-slot.ts', import.meta.url))],
  },
});
```

Set `PROJECT` in `test-slots.ts`. If you move the folder, also change `WORKTREE_DEPTH` in `test-file-slot.ts`. `test-file-slot.ts` imports `vitest`, so it loads only inside a Vitest run. Check it with `node --check`, not by importing it.

**One pool, one cap.** The bound holds only when every concurrent caller uses the same `PROJECT`, the same slot folder and the same cap:

- Set `TEST_SLOTS`, if you set it at all, once in the machine's shared launch environment (the profile every agent's shell reads). Never raise it for one thread. A run at cap 8 takes slots a run at cap 4 waits for, so mixed caps break the bound for both.
- The pool is per user and per `/tmp`. Other users, containers and VMs each get their own. If they share the cores, give them a deliberately shared coordinator, or split the machine's capacity between them.
- Before you read slot-wait logs or a load test, confirm the pool is active: the folder `/tmp/<project>-test-slots-<uid>` exists and no run warned that Perl is missing.

### 2. The remote task cache

```ts
// vite.config.ts (root)
import { remoteCacheUrl } from './scripts/local/task-cache.ts';

const remote = remoteCacheUrl();
export default defineConfig({ run: { cache: { tasks: true, remote: remote && { url: remote } } } });
```

```json
{ "scripts": { "build": "node scripts/local/task-cache.ts build" } }
```

### 3. `test:cached`: the near tests, as cached groups

`near-tests.ts` picks the files. The driver that runs them as cached groups isn't ported: it's tied to the source repo's database and generated-file setup. Write your own to this contract, or a pass can be green when tests didn't run.

```sh
files=$(node scripts/local/near-tests.ts origin/main --files)
<test-cached-command> $files     # your driver: no paths runs these; --all every file; folders, theirs
```

The driver must:

1. **Group before filtering.** Form stable groups from the complete ordinary suite first, then keep the groups holding a selected file, so a group's key doesn't move with the selection. Local groups are your own (small groups, few workers each), separate from CI's grouping.
2. **Bound concurrency** from the slot cap: no more simultaneous group tasks than test slots.
3. **Fall back to everything** if selection fails (a missing base, a parse error): run all ordinary tests, and say so.
4. **Validate paths.** Refuse an explicit path that matches no test file, and refuse a substring that matches several when the caller meant one.
5. **Serialize a shared summary folder.** Callers that share a summary or cache folder take a lock first. Tag each invocation and round, and reject a summary that's missing or belongs to another invocation.
6. **Account for every selected file** as replayed, passed, failed, interrupted or not run. Fail when any file was interrupted or not run, not only when one failed.
7. **`--no-cache` disables reads and writes** in both tiers, local and remote.
8. Optionally, re-run a sample of replayed groups uncached to check hits. Never count a replay as a fresh observation when counting flakes.

Repo-specific setup (databases, generated files) is the driver's to do before the groups run.

Add your repo's tests that no import leads to, such as ones that read a module from disk, run a bundle built from it or list what they cover, in `extraReaching`. Without them, those tests run only in CI and the daily full run.

### 4. Housekeeping timers

Both sweeps are best-effort Linux cleanup, not proof that nothing will use what they delete. Do these in order, and enable nothing until the first three are done:

1. **Agree the scope.** With whoever owns the machine, agree what may go, and list what must stay: coordination and control-plane state, other tools' caches. The test-slot pool's folder (`*-test-slots-*`) is always kept; `TMP_SWEEP_KEEP` adds to it, never replaces it.
2. **Set the exclusions in the units.** For the temp sweep, a systemd override, so the unit and your dry run read the same list:

   ```sh
   cp scripts/local/tmp-sweep.{service,timer} ~/.config/systemd/user/
   systemctl --user edit tmp-sweep.service
   # [Service]
   # Environment=TMP_SWEEP_KEEP='<keep-globs>'
   ```

   The unit ships an empty `Environment=TMP_SWEEP_KEEP=` line and a dry-run note; the override replaces that line. For the Rust sweep, fill in its config block and set `ExecStart` to the script's path.
3. **Read a dry run with the unit's settings:** the same environment and age cutoff as `ExecStart` (`--days 2` here).

   ```sh
   install -m 755 scripts/local/tmp-sweep.sh ~/.local/bin/tmp-sweep
   TMP_SWEEP_KEEP='<keep-globs>' ~/.local/bin/tmp-sweep --days 2   # dry run
   node scripts/local/rust-target-sweep.ts                          # dry run
   ```

4. **Then enable,** with the user's yes for each timer:

   ```sh
   systemctl --user daemon-reload && systemctl --user enable --now tmp-sweep.timer
   node scripts/local/rust-target-sweep.ts install       # links both units, enables the timer
   ```

The temp sweep runs every 6 h with a 2-day threshold, which is what kept a busy machine's `/tmp` from filling. The Rust sweep runs weekly.

### 5. Rust compile cache (local only)

If agents build Rust in many worktrees, a shared compiler cache stops each worktree compiling the same dependencies again. It doesn't reclaim `target/` disk; the Rust sweep does that.

1. Install a verified `sccache` release for the host, and put it somewhere stable.
2. In `~/.cargo/config.toml`:

   ```toml
   [build]
   rustc-wrapper = "<absolute-sccache-path>"
   ```

3. Bound the cache: `SCCACHE_DIR=<cache-dir>` and `SCCACHE_CACHE_SIZE=<size>` (for example `20G`) in the shared launch environment.
4. Keep each worktree's own `target/`. Never share one between worktrees.
5. Measure: build a fresh worktree cold, then another warm, and read `sccache --show-stats`. Keep it only if warm builds are clearly faster.
6. In a sandbox that can't reach the cache server, build with `RUSTC_WRAPPER= cargo build`.

This is for local machines. Use it in CI only if your own CI measurements justify it.

## Placeholders

| Placeholder | Where | What to put |
| --- | --- | --- |
| `<project>` | `test-slots.ts`, `task-cache.ts`, `rust-target-sweep.ts` | A short name for the slot directory, the state and config folders |
| `<worker-url>`, `<machine-name>`, `<writer-token>` | `task-cache.json`, shown in `task-cache.ts` | The cache Worker's host, a name for this machine, and its token. Never commit the file. |
| `<worktrees-dir>` | `rust-target-sweep.ts` `ROOT` | The folder that holds one folder per worktree |
| `<rust-target>` | `rust-target-sweep.ts` `TARGET` | The `target/` path inside a worktree, e.g. `crates/service/target` |
| `<org>/<repo>` | `rust-target-sweep.ts` `REPO` | The GitHub repository, for the PR-state check |
| `<rust-target-sweep-script>` | `rust-target-sweep.service` | The absolute path of `rust-target-sweep.ts` |
| `<test-cached-command>` | Section 3 | Your local cached-test driver |
| `<keep-globs>` | `TMP_SWEEP_KEEP`, section 4 | Space-separated name globs the temp sweep never deletes, added to the slot pool's `*-test-slots-*` |
| `<absolute-sccache-path>`, `<cache-dir>`, `<size>` | Section 5 | Where `sccache` is, its cache folder and its size bound |

Also set `LOCAL_EVERY`, `AREA_ROOTS` and `ownJob` in `near-tests.ts` to your layout, and keep `ownJob` in step with `LEFT_OUT` in `../shards/test-groups.ts`.
