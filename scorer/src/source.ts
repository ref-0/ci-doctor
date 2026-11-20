// Where the files come from: the default branch through `gh`, or a local checkout when there's no GitHub remote.
// `read` answers undefined only when a listed file can't be found; a failed read throws.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from './errors.ts';
import type { Gh } from './gh.ts';

export interface Tree {
  /** `sha` is the blob's object id, in GitHub's listing; a checkout's files have none. */
  blobs: { path: string; size: number; sha?: string }[];
  /** GitHub cut the listing short, so a file missing from it is unknown, not absent. */
  truncated: boolean;
}

export interface Source {
  tree: Tree;
  read(path: string): string | undefined;
  /** Several files at once, by path. A path left out of the answer couldn't be found or read whole. */
  readMany(paths: string[]): Map<string, string>;
}

/** Files per GraphQL query: GitHub answers 100 aliased blobs well inside its limits. */
export const FILES_PER_QUERY = 100;

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export const githubSource = (gh: Gh, repo: string, ref: string): Source => {
  // 409 is an empty repo; 404 a default branch with no commits.
  const tree = gh.json(`repos/${repo}/git/trees/${ref}?recursive=1`, { absentOn: [404, 409] });
  const blobs = ((tree?.tree ?? []) as any[])
    .filter((t) => t.type === 'blob')
    .map((t) => ({ path: String(t.path), size: Number(t.size ?? 0), ...(typeof t.sha === 'string' ? { sha: t.sha } : {}) }));
  const shaOf = new Map(blobs.map((b) => [b.path, b.sha]));

  const [owner, name] = repo.split('/') as [string, string];
  // One query reads up to FILES_PER_QUERY files, each an aliased object by the blob id the tree listed, so every
  // batch reads the one revision the tree is, however the branch moves meanwhile. A missing one answers null.
  const readMany = (paths: string[]) => {
    const texts = new Map<string, string>();
    const listed = paths.filter((p) => shaOf.get(p) !== undefined);
    for (let i = 0; i < listed.length; i += FILES_PER_QUERY) {
      const batch = listed.slice(i, i + FILES_PER_QUERY);
      const objects = batch.map((p, j) => `f${j}: object(oid: ${JSON.stringify(shaOf.get(p))}) { ... on Blob { isTruncated text } }`);
      const answer = gh.graphql(`query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${objects.join(' ')} } }`);
      batch.forEach((p, j) => {
        const blob = answer?.data?.repository?.[`f${j}`];
        if (typeof blob?.text === 'string' && !blob.isTruncated) texts.set(p, blob.text);
      });
    }
    return texts;
  };

  return {
    tree: { blobs, truncated: !!tree?.truncated },
    read: (path) => gh.text(`repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, { raw: true, absentOn: [404] }),
    readMany,
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

  const read = (path: string) => {
    try {
      return readFileSync(onDisk(path), 'utf8');
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return undefined;
      throw new CliError(`Couldn't read ${path}: ${(e as Error).message}`);
    }
  };

  return {
    tree: { blobs, truncated: false },
    read,
    readMany: (paths) => new Map(paths.flatMap((p) => {
      const text = read(p);
      return text === undefined ? [] : [[p, text] as const];
    })),
  };
};
