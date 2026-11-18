/**
 * snapshot-pins.test.ts: the pins it names, when it refuses them, and the command on a throwaway
 * git repository.
 *
 *     node --test scripts/sweeps/snapshot-pins.test.ts
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { refusal, snapshotPins } from './snapshot-pins.ts';

const snapshot = 'https://pkg.pr.new/org/tools/@org/lib@0123456789abcdef0123456789abcdef01234567';

const catalog = (version: string) => ({ path: 'pnpm-workspace.yaml', text: `catalog:\n  '@org/lib': ${version}\n  left-pad: 1.3.0\n` });

const lockfile = (version: string) => ({
  path: 'pnpm-lock.yaml',
  text: `catalogs:\n  default:\n    '@org/lib':\n      specifier: ${version}\n      version: ${version}\n`,
});

const pullRequest = { event: 'pull_request', heavyFile: '', testPaths: '' };

describe('snapshotPins', () => {
  it('names each line that pins a snapshot, by file and line', () => {
    assert.deepEqual(snapshotPins([catalog(snapshot), lockfile(snapshot)]), [
      `pnpm-workspace.yaml:2: '@org/lib': ${snapshot}`,
      `pnpm-lock.yaml:4: specifier: ${snapshot}`,
      `pnpm-lock.yaml:5: version: ${snapshot}`,
    ]);
  });

  it('names one by its host, in any case and under any scheme', () => {
    const other = 'HTTP://PKG.PR.NEW/org/tools/@org/lib@0123456';

    assert.deepEqual(snapshotPins([catalog(other)]), [`pnpm-workspace.yaml:2: '@org/lib': ${other}`]);
  });
});

describe('refusal', () => {
  it('passes the released version on any run', () => {
    assert.equal(refusal(snapshotPins([catalog('0.1.0'), lockfile('0.1.0')]), pullRequest), undefined);
    assert.equal(refusal(snapshotPins([catalog('0.1.0')]), { event: 'push', heavyFile: '', testPaths: '' }), undefined);
  });

  it('refuses a snapshot on a pull request, a push, a sweep, and a run by hand that names no file', () => {
    const pins = snapshotPins([catalog(snapshot)]);

    for (const event of ['pull_request', 'push', 'sweep', 'workflow_dispatch'])
      assert.match(refusal(pins, { event, heavyFile: '', testPaths: '' }) ?? '', /^The dependencies name a pkg\.pr\.new snapshot[\s\S]*pnpm-workspace\.yaml:2:/);
  });

  it('allows a snapshot on a run by hand of one named file', () => {
    const pins = snapshotPins([catalog(snapshot), lockfile(snapshot)]);
    const byHand = { event: 'workflow_dispatch', heavyFile: '', testPaths: '' };

    assert.equal(refusal(pins, { ...byHand, heavyFile: 'src/queue.sandbox.test.ts' }), undefined);
    assert.equal(refusal(pins, { ...byHand, testPaths: 'scripts/proof.test.ts' }), undefined);
  });

  it('refuses a run by hand that names more than one file', () => {
    const pins = snapshotPins([catalog(snapshot), lockfile(snapshot)]);
    const byHand = { event: 'workflow_dispatch', heavyFile: '', testPaths: '' };

    assert.notEqual(refusal(pins, { ...byHand, testPaths: 'src/a.test.ts src/b.test.ts' }), undefined);
    assert.notEqual(refusal(pins, { ...byHand, heavyFile: 'src/queue.sandbox.test.ts', testPaths: 'src/a.test.ts' }), undefined);
  });
});

describe('the command', () => {
  const script = fileURLToPath(new URL('snapshot-pins.ts', import.meta.url));
  const folders: Array<string> = [];

  after(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  // The runner's own git config can't change what git tracks here.
  const git = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

  /** A repo whose nested package tracks `tracked` as its version, with `untracked` beside it. */
  const repo = (tracked: string, untracked: string) => {
    const folder = mkdtempSync(join(tmpdir(), 'snapshot-pins-'));
    const manifest = (version: string) => `${JSON.stringify({ dependencies: { '@org/lib': version } })}\n`;

    folders.push(folder);
    mkdirSync(join(folder, 'packages/lib'), { recursive: true });
    writeFileSync(join(folder, 'package.json'), '{}\n');
    writeFileSync(join(folder, 'packages/lib/package.json'), manifest(tracked));
    execFileSync('git', ['init', '-q'], { cwd: folder, env: git });
    execFileSync('git', ['add', '-A'], { cwd: folder, env: git });
    mkdirSync(join(folder, 'scratch'));
    writeFileSync(join(folder, 'scratch/package.json'), manifest(untracked));

    return folder;
  };

  const run = (folder: string, event: string, testPaths = '') =>
    spawnSync(process.execPath, [script], { cwd: folder, env: { ...git, EVENT: event, HEAVY_FILE: '', TEST_PATHS: testPaths }, encoding: 'utf8' });

  it("refuses a pull request whose tracked manifest pins a snapshot, naming the file's line", () => {
    const refused = run(repo(snapshot, '0.1.0'), 'pull_request');

    assert.equal(refused.status, 1);
    assert.ok(refused.stderr.includes('packages/lib/package.json:1: '));
  });

  it('reads only tracked manifests, so an untracked snapshot passes', () => {
    const passed = run(repo('0.1.0', snapshot), 'pull_request');

    assert.equal(passed.status, 0);
    assert.ok(passed.stderr.includes('snapshot-pins: 2 manifests name no snapshot'));
  });

  it('allows a run by hand that names one file', () => {
    const allowed = run(repo(snapshot, '0.1.0'), 'workflow_dispatch', 'scripts/a.test.ts');

    assert.equal(allowed.status, 0);
    assert.ok(allowed.stderr.includes('the snapshot is allowed'));
  });
});
