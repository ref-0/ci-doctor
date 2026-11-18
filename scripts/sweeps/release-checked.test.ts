/**
 * release-checked.test.ts: `checkedBy` and `isRelease` on a throwaway git repository.
 *
 *     node --test scripts/sweeps/release-checked.test.ts
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { checkedBy, isRelease, missingChecks, type ReleaseConfig, shippedPaths } from './release-checked.ts';

const shape: ReleaseConfig = {
  released: ['packages/cli', 'packages/sdk'],
  packagesUnder: 'packages/',
  isPackageManifest: (path) => /^packages\/[^/]+\/package\.json$/.test(path),
  alsoShipped: ['pnpm-workspace.yaml'],
  lockfile: 'pnpm-lock.yaml',
  unpublished: [':(exclude,glob)**/*.test.ts'],
};

// The runner's own git config can't change what git does here.
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' };

const root = mkdtempSync(join(tmpdir(), 'release-checked-'));
after(() => rmSync(root, { recursive: true, force: true }));

const git = (...args: ReadonlyArray<string>) => execFileSync('git', args, { cwd: root, env: gitEnv, encoding: 'utf8' }).trim();

const manifest = (name: string, version: string, dependencies: Record<string, string> = {}) => `${JSON.stringify({ name, version, dependencies }, null, 2)}\n`;

const commit = (subject: string, files: Readonly<Record<string, string>>) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }

  git('add', '-A');
  git('commit', '-q', '-m', subject);

  return git('rev-parse', 'HEAD');
};

const withVersion = (version: string) => ({
  'packages/cli/package.json': manifest('cli', version, { sdk: 'workspace:*', shared: 'workspace:*' }),
  'packages/sdk/package.json': manifest('sdk', version),
});

git('init', '-q', '-b', 'main');
commit('Start', {
  ...withVersion('0.1.0'),
  'packages/shared/package.json': manifest('shared', '0.0.0'),
  'packages/other/package.json': manifest('other', '0.0.0'),
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
});

describe('missingChecks', () => {
  it("names each required job none of the sweep's runs at the commit passed", () => {
    const required = [/^Containers /, /^Deep properties$/];

    assert.deepEqual(missingChecks(required, ['Plan', 'Containers 1/2', 'Deep properties']), []);
    assert.deepEqual(missingChecks(required, ['Plan']), ['^Containers ', '^Deep properties$']);
  });
});

describe('checkedBy', () => {
  it('reaches workspace packages through workspace: dependencies, and leaves out what no tarball holds', () => {
    assert.deepEqual(shippedPaths(root, 'HEAD', shape), ['packages/cli', 'packages/sdk', 'packages/shared', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', ':(exclude,glob)**/*.test.ts']);
  });

  it('publishes only what a passing sweep checked, whatever merged beside it', () => {
    const checked = commit('CLI: a flag', { 'packages/cli/src/a.ts': 'a' });
    commit('Server: a route', { 'apps/server/src/b.ts': 'b' });
    commit('CLI: a test', { 'packages/cli/src/a.test.ts': 't' });
    commit('Other: unreached', { 'packages/other/src/x.ts': 'x' });
    const first = commit('Release: 0.2.0', withVersion('0.2.0'));

    assert.equal(isRelease(root, first, shape.released), true);
    assert.equal(checkedBy(root, first, [checked], shape), checked);

    const unchecked = commit('Shared: a helper', { 'packages/shared/src/c.ts': 'c' });
    const second = commit('Release: 0.3.0', withVersion('0.3.0'));

    assert.equal(checkedBy(root, second, [checked], shape), undefined);
    assert.equal(checkedBy(root, unchecked, [checked], shape), undefined);
    assert.equal(checkedBy(root, second, [unchecked, checked], shape), unchecked);

    // A sweep after the release, with nothing shipped changed between, checked it too.
    const later = commit('Server: another route', { 'apps/server/src/d.ts': 'd' });
    assert.equal(checkedBy(root, second, [later], shape), later);

    commit('Lockfile: a bump', { 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n# changed\n' });
    const latest = commit('Server: a third route', { 'apps/server/src/f.ts': 'f' });
    assert.equal(checkedBy(root, second, [latest], shape), undefined);
  });

  it('refuses a version raised beside other changes, or to a version no release raises it to', () => {
    const beside = commit('CLI: 0.4.0 and a fix', { ...withVersion('0.4.0'), 'packages/cli/src/g.ts': 'g' });
    assert.throws(() => isRelease(root, beside, shape.released), /raises the version, and changes packages\/cli\/src\/g\.ts beside the versions/);

    const skipped = commit('Release: 0.9.0', withVersion('0.9.0'));
    assert.throws(() => isRelease(root, skipped, shape.released), /raises 0\.4\.0 to 0\.9\.0, where a release raises it to 0\.5\.0, or to 0\.4\.1 as a patch/);

    const plain = commit('CLI: a flag', { 'packages/cli/src/h.ts': 'h' });
    assert.equal(isRelease(root, plain, shape.released), false);
  });
});
