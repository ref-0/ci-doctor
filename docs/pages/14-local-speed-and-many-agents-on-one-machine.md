[Guide](../README.md)

# 14. Local speed, and many agents on one machine

Agents wait on local checks far more often than on CI, so local feedback got the same treatment. We run several AI engineers concurrently—each in its own git worktree—on one shared many-core machine.

## Fast local feedback

**Applies when:** Agents or engineers wait on local checks. **Skip when:** Local checks already run only what covers the change.

- **Run the narrowest check that covers your change:**
  - While iterating: run a single test file by path (`vp test run <file> -t '<name>'`), and format and lint only changed files.
  - Before pushing: run `check`, `build`, and `test:cached`.
  - Document these exact commands in `AGENTS.md` so agents don't invent broader ones.
- **`test:cached` selects tests near the diff.** It inspects committed and uncommitted changes since the merge base—selecting edited tests, name matches, direct importers, and explicit config, bundle, and disk-read edges. Locally, selection takes 0.8–1.8 s versus 8.6–13.5 s for Vitest's built-in changed-file mode, and cached passes replay from local and remote task caches. `--all` and folder paths remain available. We rejected a separate "fast" command: the default command *is* the fast one.
  - [`scripts/local/`](../../scripts/local/) provides the selector. The local cached-test runner itself isn't ported—implement it against the contract in [`scripts/local/README.md`, section 3](../../scripts/local/README.md#3-testcached-the-near-tests-as-cached-groups) (group before filtering, enforce the slot cap, fall back to all tests, validate paths, serialize the summary directory, account for every file, and fail on interrupted or unrun files), summarized below.
- **Reuse work across worktrees:**
  - Builds, lint, and test passes replay from the task cache (local first, then remote).
  - A content-keyed, machine-wide type cache stores multiple versions of each project side by side, cutting fresh-worktree type checks from 17–20 s down to 0.4 s locally.
  - A fresh worktree with no local build replays `main`'s build from the remote cache.
- **Skip builds before checking or testing.** Packages export source under a custom export condition ahead of built output, so tests and type checks start immediately (section 9).
- **Keep local checks lighter than CI by design:**
  - Type-aware lint runs on changed files locally and on every file in CI, taking ~11 s and 2.3 GiB locally versus ~8 GB for full type-aware lint (section 9).
  - `check:static` runs CI's static checks once *after committing*, because its range checks inspect commits only.
- **Stack small per-process wins.** Node's compile cache runs on every per-file process, generated files write only on content change, and the server bundle builds once per input state.
- **Rust locally:** Use `sccache` with a 5 GiB cap. Locally, a second fresh worktree compiled in roughly a third of the time, with 82 of 91 compiler calls hitting the cache. Keep one `target/` directory per worktree. To set it up:
  1. Install a verified `sccache` release for the host.
  2. Set `[build] rustc-wrapper = "<absolute-sccache-path>"` in `~/.cargo/config.toml`.
  3. Configure a bounded cache directory and size.
  4. Compare a cold and warm build and inspect `sccache --show-stats`.

  Inside a sandbox that can't reach the `sccache` server, build with `RUSTC_WRAPPER= cargo build`. Keep `sccache` local-only unless measurements justify CI use (section 6), and note that it doesn't reclaim `target/` disk space. Full setup and validation: [`scripts/local/README.md`, section 5](../../scripts/local/README.md#5-rust-compile-cache-local-only).
- **Leave container, proof, and replay tests to CI**—along with Docker and full CI commands. An agent dispatches a manual single-file CI run locally only when a decision depends on it.

## The local runner contract

**Applies when:** A local runner executes a selected subset of tests (such as `test:cached` or a custom driver). **Skip when:** Local runs don't use selection.

`test:cached` combines a selector with a runner. A naive runner that simply invokes a selected file list can report green even when files failed to execute. Because [`scripts/local/`](../../scripts/local/) ships only the selector, make sure any runner you write satisfies every requirement below:

- **Form stable groups from the entire ordinary suite before filtering,** so group keys never depend on the selection. Keep local grouping separate from CI's.
- **Bound concurrent tasks** using the machine's file-slot cap.
- **Fall back to every ordinary test** if selection fails.
- **Validate explicit paths** and reject ambiguous substring matches.
- **Serialize callers** sharing a summary or cache directory: tag each invocation and round, and reject foreign or missing summaries.
- **Account for every selected file** as replayed, passed, failed, interrupted, or not run—and fail the run if execution is incomplete.
- **Support `--no-cache`** to disable reads and writes in both local and remote caches.
- **Support sampled uncached hit verification** to check cache soundness, and never count a replay as a fresh flake observation.

Let each repo supply its own database and codegen setup; the contract is independent of our stack.

## Sharing one machine

**Applies when:** Multiple agents or worktrees run tests concurrently on one shared host. **Skip when:** Each machine runs a single checkout.

- **Enforce machine-wide test slots.** Every local test file acquires a lock from a shared `flock` pool (held by a child process). The default cap is `max(2, floor(availableParallelism / 4))`—a quarter of available cores rounded down, at least 2—unless overridden by `TEST_SLOTS`, shared across all worktrees and agents.
  - **Every caller must agree on project name, slot directory, and cap.** A caller using a higher cap grabs the same low-numbered slots that lower-cap callers rely on, breaking the bound. Set the cap once in the machine's shared launch environment and never raise it per thread.
  - The pool coordinates one user sharing one `/tmp`. Separate users, containers, or VMs need an explicit shared coordinator or separate capacity budgets. Confirm the pool is actually active (Perl with `flock` installed) before trusting load or slot-wait logs.
  - Three concurrent runs of three workers each had pushed system load past the core count.
  - In our observations under shared load, cap 4 produced zero timeouts (one socket closure, one failed test), cap 6 produced three timeouts, and cap 8 produced many—evidence of reliability under contention rather than a clean speed benchmark.
  - **Log slot-wait time separately from execution time.** Tie each record to a worktree and work interval, and report ambiguous, unmatched, and missing completions (a killed process logs none). State your denominator (all active engineer time vs. covered work only). Because waits summed across parallel files overlap, merge or partition intervals before estimating lost engineer time. By our measure, slot waits were a meaningful share of active time—enough to keep tracking.
- **Disable implicit installs.** Set `verifyDepsBeforeRun: false` in pnpm. Concurrent auto-installs near ext4's ~65,000 hard-link limit forced pnpm to fall back to copying and **truncated shared store files**—8,543 files in one reproduction—corrupting sibling worktrees. Install once, alone, per checkout.
- **Don't let one agent starve the machine.** A single related-tests run consumed enough memory to trigger the OOM killer on an agent session. When memory is tight, run specific files and leave broader suites to CI.
- **Check load and disk space first** whenever unrelated tests fail in bulk. A full temp disk once caused SQL and template-copy errors completely unrelated to the code change.
- **Run best-effort Linux housekeeping timers:**
  - a weekly sweep of idle Rust `target/` directories that rechecks eligibility right before deletion (one sweep freed 18 GiB);
  - a low-priority temp-leftovers sweep every 6 hours, based on a single process snapshot taken at startup;
  - never share a single Cargo `target/` directory across worktrees—Cargo returned another worktree's binary as "fresh."

  Both sweeps can race with brand-new work and can't inspect processes they lack permission to see, so neither guarantees a directory will stay idle. Explicitly exclude the slot directory and any control-plane state, and review a dry run and agree on cleanup scope before enabling deletion on a new machine ([`scripts/local/README.md`, section 4](../../scripts/local/README.md#4-housekeeping-timers)).
- **Kill processes by PID only.** Pattern kills (`pkill -f`, etc.) can terminate another engineer's active run.
