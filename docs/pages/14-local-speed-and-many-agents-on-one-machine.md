[Guide](../README.md)

# 14. Local speed, and many agents on one machine

Agents wait on local checks far more often than on CI, so local feedback got the same treatment. We run several AI engineers at once, each in its own git worktree, on one shared many-core machine.

## Fast local feedback

- **The narrowest check that covers the change.**
  - While working: run one test file by path (`vp test run <file> -t '<name>'`) and format and lint just the changed files.
  - Before pushing: run `check`, `build` and `test:cached`.
  - The commands are spelled out in `AGENTS.md`, so agents don't invent broader ones.
- **`test:cached` picks tests near the diff.** It takes committed and uncommitted changes since the merge base: changed tests, name matches and direct importers, plus explicit config, bundle and disk-read edges. Locally, selection takes 0.8–1.8 s, against 8.6–13.5 s for Vitest's own changed-file mode. Cached passes replay from the local and remote task cache. `--all` and folder paths stay available. We rejected a separate "fast" command; the default command is the fast one. [`scripts/local/`](../../scripts/local/) has the selection. The local cached-test driver isn't ported; write it to the contract in [`scripts/local/README.md`, section 3](../../scripts/local/README.md#3-testcached-the-near-tests-as-cached-groups) (group before filtering, bounded by the slot cap, fall back to everything, validate paths, serialize the summary folder, account for every file, fail on interrupted or not-run), summarized below.
- **Everything replays across worktrees.**
  - Builds, lint and test passes come from the task cache, local first, then remote.
  - A content-keyed, machine-wide type cache keeps several versions of each project side by side. Locally, a fresh worktree's type check went from 17–20 s to 0.4 s.
  - A worktree with no build replays main's from the remote cache.
- **Nothing needs a build first.** Packages export source under a custom export condition, ahead of their built output, so tests and type checks start immediately (section 9).
- **Local is lighter than CI by design.**
  - Type-aware lint runs on changed files locally and on every file in CI.
  - The local check took ~11 s and 2.3 GiB, against ~8 GB for full type-aware lint (the measurement in section 9).
  - `check:static` runs CI's static checks once, after committing, because its range checks only see commits.
- **Small per-process savings multiply.** Node's compile cache is on for every per-file process, generated files are written only when their content changes, and the server bundle is built once per input state.
- **Rust locally:** `sccache` with a 5 GiB cap. Locally, a second fresh worktree built in about a third of the time, with 82 of 91 compiler calls hitting the cache. Each worktree keeps its own `target/`. To set it up:
  1. install a verified `sccache` release for the host;
  2. set `[build] rustc-wrapper = "<absolute-sccache-path>"` in the user's Cargo config (`~/.cargo/config.toml`);
  3. give it a bounded cache directory and size;
  4. compare a cold and a warm build, and read `sccache --show-stats`.

  In a sandbox that can't reach the sccache server, build with `RUSTC_WRAPPER= cargo build`. It's local-only unless measurement justifies CI use (section 6), and it doesn't reclaim `target/` disk space. Setup and validation: [`scripts/local/README.md`, section 5](../../scripts/local/README.md#5-rust-compile-cache-local-only).
- **Container, proof and replay tests run only in CI.** So do Docker and the full CI command. Locally, an agent runs a by-hand CI run for one file only when a decision depends on it.

## The local runner contract

`test:cached` is a selection plus a runner. A runner that just takes the selected list can report green when tests didn't run. Ours does all of the following. [`scripts/local/`](../../scripts/local/) ships only the selection, so make sure whatever runner you write or use meets every point:

- **Form stable groups from the whole ordinary suite, then filter,** so a group's key doesn't depend on the selection. Local grouping is separate from CI's.
- **Bound concurrent tasks** from the machine's file-slot cap.
- **Fall back to every ordinary test** if selection fails.
- **Validate explicit paths,** and refuse ambiguous substring matches.
- **Serialize callers** that share a summary or cache directory. Tag each invocation and round, and reject foreign or missing summaries.
- **Account for every selected file** as replayed, passed, failed, interrupted or not run, and fail when execution is incomplete.
- **`--no-cache` turns off reads and writes** in both the local and remote tiers.
- **Optionally re-run a sample of hits uncached** to check soundness. Never count a replay as a fresh flake observation.

Let the repo supply its own database and generated-file setup; the contract doesn't need our stack.

## Sharing one machine

- **Machine-wide test slots.** Every local test file takes a lock from a shared pool (`flock`, held by a child process). The default cap is `max(2, floor(availableParallelism / 4))`, a quarter of the cores rounded down and at least 2, unless `TEST_SLOTS` overrides it, and it covers all worktrees and agents.
  - **Every caller must use the same project name, slot directory and cap.** A caller with a higher cap takes the low-numbered slots a lower-cap caller uses, so the bound no longer holds. Set the cap once in the machine's shared launch environment, and never raise it in one thread.
  - The pool coordinates one user sharing one `/tmp`. Other users, containers or VMs need a deliberately shared coordinator, or their own capacity budgets. Confirm the pool is active (Perl with `flock` is installed) before you read load or slot-wait logs.
  - Three runs of three workers each had pushed the box's load past its core count.
  - Cap 4 had no timeouts (one socket closure, one failed test), cap 6 had three timeouts, and cap 8 had many. Other worktrees were busy too, so this shows reliability, not a clean speed comparison.
  - **Log the wait for a slot separately from execution.** Match each record to one worktree and work interval, and report ambiguous, unmatched and missing completions (a killed file logs none). Name the denominator: all active engineer time, or only covered work. Waits summed across parallel files overlap, so they aren't a causal estimate of lost engineer time; merge or partition the intervals first. By our measure, slot waits were a meaningful share of active time, enough to keep measuring.
- **No implicit installs.** Set `verifyDepsBeforeRun: false` in pnpm. Concurrent auto-installs near ext4's ~65,000 hard-link limit made pnpm fall back to copying and **truncated shared store files**: 8,543 in one reproduction, corrupting other worktrees. Install once, alone, per checkout.
- **Don't let one agent's tests take the whole machine.** One related-tests run used enough memory to get an agent's session killed by the OOM killer. When memory is tight, run named files and leave the rest to CI.
- **Check load and disk first** when many unrelated tests fail. A full temp disk produced SQL and template-copy errors that had nothing to do with the change.
- **Housekeeping timers,** best-effort Linux cleanup:
  - a weekly sweep of idle Rust `target/` directories, which rechecks each one's eligibility before deleting it (one cleanup freed 18 GiB);
  - a low-priority sweep of temp leftovers every 6 hours, from a single process snapshot taken at its start;
  - never a shared Cargo target dir across worktrees, which returned the wrong binary as "fresh".

  Both sweeps race with new work, and can't see into processes they lack access to; neither proves a directory will stay unused. Configure an explicit exclusion for the slot directory and any control-plane state. On another machine, read a dry run and agree the cleanup scope before enabling deletion ([`scripts/local/README.md`, section 4](../../scripts/local/README.md#4-housekeeping-timers)).
- **Stop processes by PID only.** A pattern kill can stop another engineer's run.
