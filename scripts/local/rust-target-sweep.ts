#!/usr/bin/env node
/**
 * rust-target-sweep.ts: delete idle worktrees' Rust build folders on a shared machine, weekly.
 *
 * Agents each work in a worktree of their own, and each worktree that builds the Rust crate keeps a
 * `target/` folder of several GiB. Nothing else removes them once the work merges.
 *
 *     node rust-target-sweep.ts            # list what qualifies, delete nothing
 *     node rust-target-sweep.ts --delete   # delete what qualifies
 *     node rust-target-sweep.ts install    # link the units and start the timer
 *
 * Only `<rust-target>` under each worktree in `<worktrees-dir>` qualifies. It is deleted only if all
 * three hold, checked again just before deleting:
 *
 * 1. No process uses the worktree: no cwd, root, exe, open file or mapping under its real path, from
 *    `/proc`. `lsof +D` alone overreports here, since pnpm hard-links `node_modules` across worktrees.
 * 2. Its branch is merged: its HEAD is in `origin/<default-branch>`, or its PR is merged or closed.
 * 3. Nothing in the worktree, outside that `target`, changed in the last 24 hours.
 *
 * A failed or timed-out `git` or `gh` call counts as not qualifying. Process inspection is best
 * effort: `/proc` entries this user can't read (another user's processes, or ones that exit
 * mid-scan) are skipped, not counted as users. The re-check narrows the race but doesn't prove a
 * worktree will stay unused. Read a dry run, and agree what it may delete, before you enable
 * `--delete` on a machine. Each run logs to `~/.local/state/<project>/rust-target-sweep.log`.
 *
 * Where it runs: a systemd user timer on the shared machine (rust-target-sweep.service and .timer,
 * Sundays at 04:00). Node 24 or later, no npm dependencies, `git` and `gh`.
 *
 * Configure: the config block below. Tests: `node --test rust-target-sweep.test.ts`.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { argv, exit, stderr } from 'node:process';

// ---- Config -------------------------------------------------------------------------------------
/** The folder holding one folder per worktree, as an absolute path, e.g. `join(homedir(), 'worktrees/<project>')`. */
const ROOT = '<worktrees-dir>';
/** The build folder inside a worktree, e.g. `'crates/service/target'`. */
const TARGET = '<rust-target>';
const REPO = '<org>/<repo>';
const DEFAULT_BRANCH = 'main';
const LOG = join(homedir(), '.local/state/<project>/rust-target-sweep.log');
// -------------------------------------------------------------------------------------------------

const DAY = 24 * 60 * 60;
const HERE = realpathSync(import.meta.dirname);
const UNITS = ['rust-target-sweep.service', 'rust-target-sweep.timer'] as const;
const GIB = 2 ** 30;

/**
 * A path with its symlinks resolved as far as it exists, and the rest appended as written, so a
 * worktree removed mid-sweep doesn't throw.
 */
export const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    const full = resolve(path);
    const parent = dirname(full);
    return parent === full ? full : join(real(parent), basename(full));
  }
};

/** Bytes as GiB, with one decimal. */
export const gib = (bytes: number) => (bytes / GIB).toFixed(1);

/** Prints `line` and appends it to the log, each stamped with the UTC time. */
const log = (line: string) => {
  const stamped = `${new Date().toISOString()} ${line}`;

  console.log(stamped);
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, `${stamped}\n`);
};

/** What a line of `/proc/<pid>/maps` maps, when it's a file: its sixth field and on. */
export const mappedPath = (line: string) => {
  const path = /^\s*(?:\S+\s+){5}(\S.*)$/.exec(line)?.[1];

  return path?.startsWith('/') ? path : undefined;
};

/** Every path a process this user can read holds: cwd, root, exe, open files and mappings. */
export const usedPaths = (proc = '/proc') => {
  const paths = new Set<string>();
  const attempt = (read: () => void) => {
    try {
      read();
    } catch {
      // Gone mid-scan, or another user's: skipped, not counted.
    }
  };

  for (const pid of readdirSync(proc).filter((name) => /^\d+$/.test(name))) {
    const dir = join(proc, pid);
    for (const link of ['cwd', 'root', 'exe']) attempt(() => paths.add(readlinkSync(join(dir, link))));
    attempt(() => {
      for (const fd of readdirSync(join(dir, 'fd'))) attempt(() => paths.add(readlinkSync(join(dir, 'fd', fd))));
    });
    attempt(() => {
      for (const line of readFileSync(join(dir, 'maps'), 'utf8').split('\n')) {
        const path = mappedPath(line);
        if (path) paths.add(path);
      }
    });
  }

  return paths;
};

/** Whether any used path is the worktree or under it. */
export const inUse = (worktree: string, used: ReadonlySet<string>) => {
  const prefix = `${real(worktree)}/`;

  for (const path of used) if (path === prefix.slice(0, -1) || path.startsWith(prefix)) return true;
  return false;
};

const run = (command: string, args: ReadonlyArray<string>, timeout: number) =>
  spawnSync(command, args, { encoding: 'utf8', timeout: timeout * 1000 });

const git = (worktree: string, ...args: string[]) => run('git', ['-C', worktree, ...args], 60);

/** Why the worktree's branch counts as merged, or null when it doesn't, or a call failed. */
export const merged = (worktree: string, repo = REPO, defaultBranch = DEFAULT_BRANCH) => {
  if (git(worktree, 'merge-base', '--is-ancestor', 'HEAD', `origin/${defaultBranch}`).status === 0) {
    return `HEAD is in origin/${defaultBranch}`;
  }

  const branch = (git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').stdout ?? '').trim();
  if (!branch || branch === 'HEAD') return null;
  const states = run('gh', ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'state', '-q', '.[].state'], 60);
  const found = (states.stdout ?? '').split(/\s+/).filter(Boolean);
  if (states.status === 0 && found.length && found.every((state) => state === 'MERGED' || state === 'CLOSED')) {
    return `PR ${found.join(', ').toLowerCase()}`;
  }

  return null;
};

/**
 * Each entry under `top`, depth first. A symlink is listed but never followed, even to a folder,
 * and a folder it can't read is skipped. `enter` can keep the walk out of a folder, and that
 * folder isn't listed.
 */
function* walk(top: string, enter: (dir: string) => boolean = () => true): Generator<{ path: string; file: boolean }> {
  let entries;
  try {
    entries = readdirSync(top, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(top, entry.name);
    if (entry.isDirectory() && !enter(path)) continue;
    yield { path, file: entry.isFile() };
    if (entry.isDirectory()) yield* walk(path, enter);
  }
}

const lstatOrNull = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/** Whether anything in the worktree, outside `target`, changed in the last 24 hours. */
export const changedRecently = (worktree: string, target: string, now = Date.now() / 1000) => {
  const since = now - DAY;

  for (const { path } of walk(worktree, (dir) => dir !== target)) {
    const stat = lstatOrNull(path);
    if (stat && stat.mtimeMs / 1000 > since) return true;
  }

  return false;
};

/** The bytes of the regular files under `path`, not following symlinks. */
export const size = (path: string) => {
  let total = 0;

  for (const entry of walk(path)) if (entry.file) total += lstatOrNull(entry.path)?.size ?? 0;

  return total;
};

/** Whether the worktree's target qualifies, and why or why not. */
export const why = (
  worktree: string,
  used: ReadonlySet<string>,
  target = TARGET,
  isMerged: (worktree: string) => string | null = merged,
): readonly [boolean, string] => {
  const folder = join(worktree, target);

  if (inUse(worktree, used)) return [false, 'in use'];
  const reason = isMerged(worktree);
  if (reason === null) return [false, 'not merged and no closed PR'];
  if (changedRecently(worktree, folder)) return [false, 'changed in the last 24 hours'];

  return [true, reason];
};

const isFolder = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

const sweep = (remove: boolean) => {
  const target = normalize(TARGET).replace(/\/$/, '');
  const names = isFolder(ROOT) ? readdirSync(ROOT).sort() : [];
  const worktrees = names.map((name) => join(ROOT, name)).filter((path) => existsSync(join(path, '.git')));
  if (!worktrees.length) {
    log(`no worktrees under ${ROOT}; nothing deleted`);
    return;
  }
  // Worktrees share one object store, so one fetch updates every worktree's origin/<branch>.
  const fetched = run('git', ['-C', worktrees[0]!, 'fetch', '-q', 'origin', DEFAULT_BRANCH], 120);
  if (fetched.status !== 0) {
    log('git fetch failed; nothing deleted');
    return;
  }

  const targets = names
    .map((name) => [join(ROOT, name), join(ROOT, name, target)] as const)
    .filter(([, path]) => isFolder(path) && !lstatSync(path).isSymbolicLink());
  const used = usedPaths();
  let freed = 0;
  let kept = 0;

  for (const [worktree, path] of targets) {
    if (real(path) !== join(real(worktree), target) || real(dirname(worktree)) !== real(ROOT)) {
      log(`skip ${path}: not where a worktree's target belongs`);
      continue;
    }
    let [ok, reason] = why(worktree, used, target);
    if (!ok) {
      kept += 1;
      log(`keep ${path}: ${reason}`);
      continue;
    }
    const bytes = size(path);
    if (!remove) {
      freed += bytes;
      log(`would delete ${path} (${gib(bytes)} GiB): ${reason}`);
      continue;
    }
    [ok, reason] = why(worktree, usedPaths(), target);
    if (!ok) {
      kept += 1;
      log(`keep ${path}: ${reason}, at the second check`);
      continue;
    }
    rmSync(path, { recursive: true });
    freed += bytes;
    log(`deleted ${path} (${gib(bytes)} GiB): ${reason}`);
  }

  log(`${remove ? 'freed' : 'would free'} ${gib(freed)} GiB; kept ${kept} of ${targets.length}`);
};

const install = () => {
  const units = join(homedir(), '.config/systemd/user');
  mkdirSync(units, { recursive: true });

  for (const unit of UNITS) {
    const link = join(units, unit);
    if (lstatOrNull(link)) unlinkSync(link);
    symlinkSync(join(HERE, unit), link);
  }
  for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', UNITS[1]]]) {
    const done = spawnSync('systemctl', args, { stdio: 'inherit' });
    if (done.status !== 0) throw new Error(`systemctl ${args.join(' ')} failed`);
  }
};

if (import.meta.main) {
  const args = argv.slice(2);
  if (args.length === 1 && args[0] === 'install') install();
  else if (args.length === 0 || (args.length === 1 && args[0] === '--delete')) sweep(args[0] === '--delete');
  else {
    stderr.write('usage: rust-target-sweep.ts [--delete | install]\n');
    exit(2);
  }
}
