/**
 * What the types cache (`cache.ts`) keys on beside a project's own files: the workspace's files
 * and the manifests that decide how the checker resolves and reads them.
 *
 * Runs: imported by `cache.ts`.
 * Configure: `lockfiles` below, if your package manager writes another.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

/**
 * The files that pin what's installed, and the workspace's settings. A missing one hashes as
 * missing, so listing every package manager's costs nothing.
 */
export const lockfiles = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'];

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/**
 * Every file at `root` that Git doesn't ignore, tracked or not, from the root. Outside a Git
 * repo, such as a test's workspace, every file but those under `node_modules` and `.git`.
 */
export const workspaceFiles = (root: string): ReadonlyArray<string> => {
  try {
    return execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    const walk = (folder: string): ReadonlyArray<string> =>
      readdirSync(join(root, folder), { withFileTypes: true }).flatMap((entry) => {
        const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
        if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '.git' ? [] : walk(path);

        return entry.isFile() ? [path] : [];
      });

    return walk('');
  }
};

/**
 * The lockfiles, every `package.json` and `tsconfig*.json` in `files`, and each workspace file a
 * config's `extends` names, from the root, sorted: what decides which files a resolver reads and
 * how it reads them.
 */
export const manifestInputs = (root: string, files: ReadonlyArray<string>) => {
  const manifests = files.filter((file) => {
    const name = basename(file);

    return name === 'package.json' || /^tsconfig.*\.json$/.test(name);
  });
  const extended = manifests.flatMap((file) => {
    if (basename(file) === 'package.json') return [];

    const text = (() => {
      try {
        return readFileSync(join(root, file), 'utf8');
      } catch {
        return '';
      }
    })();
    const named = /"extends"\s*:\s*(\[[^\]]*\]|"[^"]*")/.exec(text)?.[1] ?? '';

    return [...named.matchAll(/"(\.[^"]*)"/g)].flatMap(([, target = '']) => {
      const path = relative(root, resolve(root, dirname(file), target));

      return path.startsWith('..') ? [] : [path];
    });
  });

  return [...new Set([...lockfiles, ...manifests, ...extended])].sort();
};
