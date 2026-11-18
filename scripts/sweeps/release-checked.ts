#!/usr/bin/env node
/**
 * release-checked.ts: finds the passing sweep that checked what a release publishes. A release
 * publishes only what main's sweep passed: a passing sweep checked a commit when the files that
 * ship are the same, byte for byte, at the sweep's commit and at the release's. So a merge that
 * only touches what doesn't ship (a server, docs, tests) doesn't make a release wait for the next
 * sweep, and one that changes a shipped file does.
 *
 *     node scripts/sweeps/release-checked.ts <sha>
 *
 * It prints `checked=<the sweep's run URL>` and `sweep=<its commit>`, for `GITHUB_OUTPUT`, or fails
 * naming how to start a sweep. `<sha>` is a release commit, or the main commit a release pull
 * request raises the version of.
 *
 * Runs: in the release workflow, before it tags or publishes, and as the release pull request's
 * status check, with `GH_TOKEN` (`actions: read`) and a checkout holding main's history.
 * Configure: the CONFIG block: the published packages' directories, what else ships beside them,
 * what no tarball holds, and how main's sweeps are named.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * The rules (docs/pages/05-tiers-what-runs-where.md):
 * - What ships is each published package's directory, every workspace package it reaches through
 *   `workspace:` dependencies, `alsoShipped` (a compiled component's sources, the workspace's
 *   catalog) and the lockfile, less `unpublished` (tests and their helpers).
 * - A sweep checked `sha` when it ran at or before what `sha` holds and nothing shipped changed
 *   since, or at or after `sha` and nothing shipped changed between.
 * - A release commit, whose only change raises every published package's version to the next minor
 *   or patch, holds what its parent does: the sweep is compared with the parent. A version changed
 *   any other way, or beside other changes, throws, so nothing publishes from it.
 *
 * No dependencies: Node 24, `git` and `gh`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { argv, cwd, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------------------------

export interface ReleaseConfig {
  /** The published packages' directories, which share one version. */
  readonly released: ReadonlyArray<string>;
  /** Where the workspace's package manifests are: a git pathspec, and which of them count. */
  readonly packagesUnder: string;
  readonly isPackageManifest: (path: string) => boolean;
  /** What else ships, though no published package's directory holds it. */
  readonly alsoShipped: ReadonlyArray<string>;
  /** The lockfile the release installs from. */
  readonly lockfile: string;
  /** Git pathspecs for what no tarball holds, in a package that's published or bundled. */
  readonly unpublished: ReadonlyArray<string>;
}

export const config: ReleaseConfig = {
  released: ['packages/<cli>', 'packages/<sdk>'],
  packagesUnder: 'packages/',
  isPackageManifest: (path) => /^packages\/[^/]+\/package\.json$/.test(path),
  // e.g. a Rust crate whose binary a platform package carries, and pnpm's catalog.
  alsoShipped: ['pnpm-workspace.yaml'],
  lockfile: 'pnpm-lock.yaml',
  unpublished: [':(exclude,glob)**/*.test.ts', ':(exclude,glob)**/*.test.tsx', ':(exclude,glob)**/testing/**', ':(exclude,glob)**/AGENTS.md'],
};

/** Main's sweeps: the CI workflow, how a passing one is named, and how to start one. */
const sweeps = {
  workflow: 'ci.yml',
  isSweepTitle: (title: string) => title.startsWith('CI on main, '),
  start: 'gh workflow run ci.yml --repo <org>/<repo> --ref main -f sweep=true',
  /**
   * The checks the release counts on the sweep for: each check you route off pull requests
   * (container tests, deep properties, a replay suite), by the job name a run's page shows. A
   * passing sweep proves them only when one of its runs at that commit shows the job succeeded: a
   * sweep with nothing new runs only its plan, and inherits the earlier run at the same commit. Add
   * a name here once the sweep runs that job, and before you take it off pull requests. Live checks
   * against an environment need a freshness rule of their own.
   */
  requiredJobs: [] as ReadonlyArray<RegExp>,
};

// ---------------------------------------------------------------------------------------------

const dependencyKinds = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

const releaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** A package.json, as far as a release reads it. */
interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

const decodeManifest = (text: string, path: string) => {
  // A workspace package.json, which the package manager reads too. Its name and version are
  // checked here, and its dependency maps are read only for their keys and `workspace:` values.
  const manifest = JSON.parse(text) as Manifest;
  if (!manifest.name || !manifest.version) throw new Error(`${path} has no name or no version`);

  return manifest;
};

/** What a release at `level` raises `version` to: the next minor, at patch 0, or the next patch. */
export const nextVersion = (version: string, level: 'minor' | 'patch') => {
  const parts = releaseVersion.exec(version);
  if (parts === null) throw new Error(`${version || 'An empty version'} isn't a release's x.y.z`);

  const [, major, minor, patch] = parts;

  return level === 'minor' ? `${major}.${Number(minor) + 1}.0` : `${major}.${minor}.${Number(patch) + 1}`;
};

type Git = (...args: ReadonlyArray<string>) => string;

const gitIn =
  (root: string): Git =>
  (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const fileAt = (git: Git, commit: string, path: string) => {
  try {
    return git('show', `${commit}:${path}`);
  } catch {
    return undefined;
  }
};

const manifestsAt = (git: Git, commit: string, released: ReadonlyArray<string>) =>
  new Map(released.map((directory) => [directory, fileAt(git, commit, `${directory}/package.json`)]));

/** The one version every published package holds at a commit. */
const versionAt = (manifests: ReadonlyMap<string, string | undefined>, commit: string) => {
  const versions = [...manifests].map(([directory, text]) => {
    if (text === undefined) throw new Error(`${commit} has no ${directory}/package.json`);

    return decodeManifest(text, directory);
  });
  const [first] = versions;
  if (first === undefined) throw new Error('No package is published');

  const other = versions.find(({ version }) => version !== first.version);
  if (other !== undefined) throw new Error(`At ${commit.slice(0, 8)}, ${first.name} is at ${first.version} and ${other.name} at ${other.version}: they share one version`);

  return first.version;
};

/** A manifest's text with its version left out, to compare the rest. */
const withoutVersion = (text: string) => {
  const { version: _version, ...rest } = decodeManifest(text, 'package.json');

  return JSON.stringify(rest);
};

/**
 * Whether a first-parent commit is a release: its only change is every published package's
 * version, raised to the next minor or to the next patch. Throws on a version changed any other
 * way, so nothing publishes from it.
 */
export const isRelease = (root: string, sha: string, released = config.released) => {
  const git = gitIn(root);
  const parent = git('rev-list', '--parents', '-n', '1', sha).trim().split(' ')[1];
  if (parent === undefined) return false;

  const before = manifestsAt(git, parent, released);
  const after = manifestsAt(git, sha, released);
  const version = versionAt(after, sha);
  const raised = released.filter((directory) => {
    const text = before.get(directory);

    return text !== undefined && decodeManifest(text, directory).version !== version;
  });
  if (raised.length === 0) return false;

  const added = released.filter((directory) => before.get(directory) === undefined);
  if (added.length > 0) throw new Error(`${sha.slice(0, 8)} raises the version, and adds ${added.map((d) => `${d}/package.json`).join(', ')}`);

  const changed = git('diff', '--name-only', '--no-renames', '-z', parent, sha)
    .split('\0')
    .filter((path) => path !== '');
  const beside = changed.filter((path) => !released.some((d) => path === `${d}/package.json`));
  if (beside.length > 0) throw new Error(`${sha.slice(0, 8)} raises the version, and changes ${beside.join(', ')} beside the versions`);

  for (const directory of released)
    if (withoutVersion(before.get(directory) ?? '') !== withoutVersion(after.get(directory) ?? ''))
      throw new Error(`${sha.slice(0, 8)} changes more of ${directory}/package.json than its version`);

  const from = versionAt(before, parent);
  if (nextVersion(from, 'minor') !== version && nextVersion(from, 'patch') !== version)
    throw new Error(`${sha.slice(0, 8)} raises ${from} to ${version}, where a release raises it to ${nextVersion(from, 'minor')}, or to ${nextVersion(from, 'patch')} as a patch`);

  return true;
};

/**
 * What ships at a commit, as git pathspecs: the published packages' directories and each workspace
 * package they reach through `workspace:` dependencies, with what else ships and the lockfile, less
 * what no tarball holds.
 */
export const shippedPaths = (root: string, commit: string, shape = config) => {
  const git = gitIn(root);
  const byName = new Map<string, { readonly directory: string; readonly manifest: Manifest }>();

  for (const path of git('ls-tree', '-r', '--name-only', '-z', commit, '--', shape.packagesUnder).split('\0')) {
    if (!shape.isPackageManifest(path) && !shape.released.some((d) => path === `${d}/package.json`)) continue;

    const manifest = decodeManifest(git('show', `${commit}:${path}`), path);
    byName.set(manifest.name, { directory: path.slice(0, -'/package.json'.length), manifest });
  }

  const found = new Set<string>();
  const waiting = [...byName.values()].filter(({ directory }) => shape.released.includes(directory));

  for (let next = waiting.pop(); next !== undefined; next = waiting.pop()) {
    if (found.has(next.directory)) continue;

    found.add(next.directory);

    for (const kind of dependencyKinds) {
      for (const [name, range] of Object.entries(next.manifest[kind] ?? {})) {
        const reached = byName.get(name);
        if (reached !== undefined && range.startsWith('workspace:')) waiting.push(reached);
      }
    }
  }

  return [...[...found].sort(), ...shape.alsoShipped, shape.lockfile, ...shape.unpublished];
};

/**
 * The commit of the first of `passed`, the commits main's passing sweeps checked, newest first,
 * that checked what `sha` publishes, or undefined. A sweep checked it when it ran at or before what
 * `sha` holds, the release commit's parent for a release, and nothing shipped changed since, or at
 * or after `sha` itself, and nothing shipped changed between.
 */
export const checkedBy = (root: string, sha: string, passed: ReadonlyArray<string>, shape = config) => {
  const git = gitIn(root);
  const paths = shippedPaths(root, sha, shape);
  const held = isRelease(root, sha, shape.released) ? git('rev-parse', `${sha}^1`).trim() : sha;
  const ancestor = (older: string, newer: string) => spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd: root }).status === 0;
  const same = (from: string, to: string) => git('diff', '--name-only', from, to, '--', ...paths).trim() === '';

  return passed.find((run) => (ancestor(run, held) && same(run, held)) || (ancestor(sha, run) && same(sha, run)));
};

/** The required jobs no successful job of the sweep's runs at one commit matches. */
export const missingChecks = (required: ReadonlyArray<RegExp>, succeeded: ReadonlyArray<string>) =>
  required.filter((job) => !succeeded.some((name) => job.test(name))).map((job) => job.source);

/** The names of a run's jobs that succeeded, on any attempt. */
const succeededJobs = (run: string) =>
  execFileSync(
    'gh',
    ['api', '--paginate', `repos/${env['GITHUB_REPOSITORY'] ?? '<org>/<repo>'}/actions/runs/${run}/jobs?filter=all&per_page=100`, '--jq', '.jobs[] | select(.conclusion == "success") | .name'],
    { encoding: 'utf8', timeout: 30_000 },
  )
    .split('\n')
    .filter((name) => name !== '');

/** Main's passing sweeps, newest first, by their run-name. */
const passingSweeps = () =>
  execFileSync(
    'gh',
    [
      'api',
      `repos/${env['GITHUB_REPOSITORY'] ?? '<org>/<repo>'}/actions/workflows/${sweeps.workflow}/runs?branch=main&event=workflow_dispatch&status=success&per_page=100`,
      '--jq',
      '.workflow_runs[] | "\\(.head_sha) \\(.html_url) \\(.display_title)"',
    ],
    { encoding: 'utf8', timeout: 30_000 },
  )
    .split('\n')
    .flatMap((line) => {
      const [sha = '', url = '', ...title] = line.split(' ');

      return sha !== '' && sweeps.isSweepTitle(title.join(' ')) ? [{ sha, url, id: url.split('/').at(-1) ?? '' }] : [];
    });

if (argv[1] === fileURLToPath(import.meta.url)) {
  const [sha] = argv.slice(2);

  if (sha === undefined || sha === '') {
    console.error('usage: node scripts/sweeps/release-checked.ts <sha>');
    exit(2);
  }

  try {
    const runs = passingSweeps();
    const found = checkedBy(
      cwd(),
      sha,
      runs.map((run) => run.sha),
    );
    const run = runs.find((each) => each.sha === found);
    if (run === undefined) throw new Error(`No passing sweep checked what ${sha.slice(0, 8)} publishes. Wait for the next, or start one: ${sweeps.start}`);

    if (sweeps.requiredJobs.length > 0) {
      const succeeded = runs.filter((each) => each.sha === run.sha).flatMap((each) => succeededJobs(each.id));
      const missing = missingChecks(sweeps.requiredJobs, succeeded);
      if (missing.length > 0) throw new Error(`The sweep at ${run.sha.slice(0, 8)} shows no successful ${missing.join(', ')}, so it doesn't prove what the release counts on.`);
    }

    console.log(`checked=${run.url}`);
    console.log(`sweep=${run.sha}`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    exit(1);
  }
}
