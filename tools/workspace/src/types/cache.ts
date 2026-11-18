/**
 * Each project's type check results, kept for every worktree on the machine in one folder,
 * `$WORKSPACE_TYPES_CACHE` when it's set, else `$XDG_CACHE_HOME/workspace-types/` or
 * `~/.cache/workspace-types/`. `types` replays a project whose inputs another worktree, or this
 * one, already checked, and checks the rest.
 *
 * Runs: imported by `types.ts`. In CI, point `WORKSPACE_TYPES_CACHE` at a folder the Actions cache
 * restores and saves.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * A project's key hashes the contents of every file its program read, as the checker's
 * `--listFiles` named them, except installed packages under `node_modules/`, which the lockfile
 * pins. It also hashes what decides which files a program reads and how: the lockfiles, every
 * `package.json` and `tsconfig*.json` in the workspace and each file a config's `extends` names,
 * the path of every file a project includes, and the checker's command and arguments. So an edit
 * to any file a program read moves that project's key, and adding, removing or renaming a
 * project's file moves every key. Contents are hashed rather than dated, since each worktree is a
 * fresh checkout, and every path is from the worktree's root, so two worktrees at the same
 * contents share a key. A result is kept only when no file it read, and no shared input, changed
 * while it ran.
 *
 * Each result is a file named by its key, in a folder for its project, so worktrees on different
 * branches keep theirs side by side, and a project keeps its `kept` most recently used. A result
 * is written to a file of its own and renamed into place, so a reader in another worktree finds it
 * whole or not at all, and one removed while it's read was opened already. `types` keeps only
 * passes.
 *
 * What it assumes: installed packages match the lockfile. Reinstall, or empty the folder, after
 * any install the lockfile doesn't describe. It doesn't see a new file that would win a module
 * resolution the checker made elsewhere, outside every project's includes, such as a hand-made
 * package in an ignored `node_modules`.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { env } from 'node:process';

import { manifestInputs, sha256, workspaceFiles } from './inputs.ts';
import type { Project } from './projects.ts';

/** What the checker printed for a project, but its file list, and how it exited. */
export interface Result {
  readonly status: number;
  readonly diagnostics: string;
}

/** A kept result: the files its program read, from the root, and the key they hashed to. */
interface Entry extends Result {
  readonly key: string;
  readonly files: ReadonlyArray<string>;
}

const keptOrNone = (text: string): Entry | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;

    const { key, files, status, diagnostics } = value as Record<string, unknown>;
    const ok =
      typeof key === 'string' &&
      typeof status === 'number' &&
      typeof diagnostics === 'string' &&
      Array.isArray(files) &&
      files.every((file) => typeof file === 'string');

    return ok ? { key, files, status, diagnostics } : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Splits the checker's output into its diagnostics and the files `--listFiles` named, by absolute
 * path.
 */
export const splitListed = (output: string) => {
  const files: Array<string> = [];
  const diagnostics: Array<string> = [];

  for (const line of output.split('\n')) {
    if (isAbsolute(line) && !/\(\d+,\d+\): /.test(line)) files.push(line);
    else diagnostics.push(line);
  }

  return { files, diagnostics: diagnostics.join('\n') };
};

/** How many results a project keeps, the most recently used: about one a branch being worked on. */
export const kept = 32;

/** A write left by a run that died before its rename, which no live run still writes after this. */
const abandonedMs = 60 * 60 * 1000;

/** An installed package's file, which the lockfile stands for in the key. */
const installed = /(?:^|\/)node_modules\//;

/**
 * The machine's folder of results, for every worktree: `WORKSPACE_TYPES_CACHE`, from `root`, or
 * the user's cache.
 */
export const cacheFolder = (root: string) => {
  const named = env['WORKSPACE_TYPES_CACHE'];
  if (named !== undefined && named !== '') return resolve(root, named);

  const base = env['XDG_CACHE_HOME'];

  return join(base !== undefined && isAbsolute(base) ? base : join(homedir(), '.cache'), 'workspace-types');
};

/** The cache for `root`'s projects, checked with `command`, the checker and all its arguments. */
export const typesCache = (root: string, projects: ReadonlyArray<Project>, command: ReadonlyArray<string>) => {
  const folder = cacheFolder(root);
  const hashes = new Map<string, Promise<string>>();

  // Each file's hash, once a run: its contents, or that it's gone.
  const hashOf = (file: string) => {
    let hash = hashes.get(file);

    if (hash === undefined) {
      hash = readFile(join(root, file)).then(sha256, () => 'missing');
      hashes.set(file, hash);
    }

    return hash;
  };

  // When the shared inputs were first read, so a result is kept only if none changed since.
  const sharedAt = Date.now();

  const sharedInputs = manifestInputs(root, workspaceFiles(root));

  // What every project's key takes in beside its own program's files. The checker's absolute
  // path stays out, so worktrees share keys; its version is in the lockfile.
  const shared = (async () => {
    const included = projects.flatMap(({ files }) => [...files].map((file) => relative(root, file)));
    const args = command.map((word) => (isAbsolute(word) ? relative(root, word) : word));

    return sha256(
      JSON.stringify({
        args,
        inputs: await Promise.all(sharedInputs.map(async (file) => [file, await hashOf(file)])),
        included: included.sort(),
      }),
    );
  })();

  // Whether any of `files` changed at or after `since`. One that's gone counts as `gone`.
  const changedSince = async (files: ReadonlyArray<string>, since: number, gone: number) => {
    const times = await Promise.all(
      files.map((file) =>
        stat(resolve(root, file)).then(
          ({ mtimeMs }) => mtimeMs,
          () => gone,
        ),
      ),
    );

    return times.some((time) => time >= since);
  };

  const keyOf = async (files: ReadonlyArray<string>) =>
    sha256(JSON.stringify([await shared, await Promise.all(files.map(async (file) => [file, await hashOf(file)]))]));

  // A project's results, each in a file its key names.
  const projectFolder = (project: Project) => join(folder, sha256(relative(root, project.config)).slice(0, 16));

  // A project's results, the most recently used first, as `[name, used]`. None for no folder.
  const listed = async (project: Project) => {
    const at = projectFolder(project);
    const names = await readdir(at).catch(() => []);
    const used = await Promise.all(
      names.map(async (name) => {
        const time = await stat(join(at, name)).then(
          ({ mtimeMs }) => mtimeMs,
          () => undefined,
        );

        return time === undefined ? [] : [[name, time] as const];
      }),
    );

    return used.flat().sort((a, b) => b[1] - a[1]);
  };

  /**
   * The project's result whose key holds, of those it keeps, any worktree's. A replay marks it
   * used, so the results a project keeps are those runs still ask for.
   */
  const replay = async (project: Project): Promise<Result | undefined> => {
    const at = projectFolder(project);
    const results = (await listed(project)).filter(([name]) => name.endsWith('.json'));

    for (const [name] of results.slice(0, kept)) {
      const text = await readFile(join(at, name), 'utf8').catch(() => undefined);
      const entry = text === undefined ? undefined : keptOrNone(text);
      if (entry === undefined || name !== `${entry.key}.json`) continue;

      const { key, files, status, diagnostics } = entry;
      if ((await keyOf(files)) !== key) continue;

      const now = new Date();
      await utimes(join(at, name), now, now).catch(() => undefined);

      return { status, diagnostics };
    }

    return undefined;
  };

  // Removes the project's results past the `kept` most recently used, and writes left abandoned.
  // Another run may remove the same file first, or still read one it opened, which Linux allows.
  const prune = async (project: Project) => {
    const at = projectFolder(project);
    const all = await listed(project);
    const results = all.filter(([name]) => name.endsWith('.json'));
    const abandoned = all.filter(([name, time]) => !name.endsWith('.json') && time < Date.now() - abandonedMs);

    for (const [name] of [...results.slice(kept), ...abandoned]) {
      await unlink(join(at, name)).catch(() => undefined);
    }
  };

  /**
   * Keeps a fresh result, read from `listed`, the absolute paths the checker named, unless a file
   * it read changed after `started`, when the checker began, or a shared input changed after it
   * was read.
   */
  const keep = async (project: Project, started: number, listed: ReadonlyArray<string>, result: Result) => {
    const files = listed
      .flatMap((file) => {
        const path = relative(root, file);

        return installed.test(path) || path.startsWith('..') ? [] : [path];
      })
      .sort();
    // A file the program read and that's gone went while the checker ran, and the key, which
    // hashes it as gone, would hold for the next run without it. A shared input, hashed as the run
    // began, is in the key as it was then.
    const changed = (await changedSince(files, started, Infinity)) || (await changedSince(sharedInputs, sharedAt, 0));
    if (changed) return;

    const at = projectFolder(project);
    const key = await keyOf(files);
    const out = join(at, `${key}.json`);
    const temporary = `${out}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await mkdir(at, { recursive: true });
    await writeFile(temporary, JSON.stringify({ key, files, ...result }));
    await rename(temporary, out);
    await prune(project);
  };

  return { replay, keep };
};
