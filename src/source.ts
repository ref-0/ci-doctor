// Where the files come from: the default branch through `gh`, or a local checkout when there's no GitHub remote.
// `read` answers undefined only when a listed file can't be found; a failed read throws.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from './errors.ts';
import type { Gh } from './gh.ts';

export interface Tree {
  blobs: { path: string; size: number }[];
  /** GitHub cut the listing short, so a file missing from it is unknown, not absent. */
  truncated: boolean;
}

export interface Source {
  tree: Tree;
  read(path: string): string | undefined;
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export const githubSource = (gh: Gh, repo: string, ref: string): Source => {
  // 409 is an empty repo; 404 a default branch with no commits.
  const tree = gh.json(`repos/${repo}/git/trees/${ref}?recursive=1`, { absentOn: [404, 409] });
  const blobs = ((tree?.tree ?? []) as any[]).filter((t) => t.type === 'blob').map((t) => ({ path: String(t.path), size: Number(t.size ?? 0) }));

  return {
    tree: { blobs, truncated: !!tree?.truncated },
    read: (path) => gh.text(`repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, { raw: true, absentOn: [404] }),
  };
};

/** The checkout's tracked files, as they are on disk now. */
export const localSource = (root: string): Source => {
  let listed: string;
  try {
    listed = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 512 << 20, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    throw new CliError(`Couldn't list this checkout's files: ${String((e as { stderr?: string }).stderr ?? e).trim()}`);
  }

  // Git lists paths with forward slashes on every platform; they're joined natively only to touch the disk.
  const onDisk = (path: string) => join(root, ...path.split('/'));
  const blobs: Tree['blobs'] = [];
  for (const path of listed.split('\0').filter(Boolean)) {
    try {
      const stat = lstatSync(onDisk(path));
      if (stat.isFile()) blobs.push({ path, size: stat.size });
    } catch {
      // Deleted in the working tree but still tracked: not there to count.
    }
  }

  return {
    tree: { blobs, truncated: false },
    read: (path) => {
      try {
        return readFileSync(onDisk(path), 'utf8');
      } catch (e) {
        if ((e as { code?: string }).code === 'ENOENT') return undefined;
        throw new CliError(`Couldn't read ${path}: ${(e as Error).message}`);
      }
    },
  };
};
