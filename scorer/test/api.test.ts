// scoreRepo from code, with the gh stub first on PATH, as a script that holds a GitHub App's token would call it.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CliError, scoreRepo } from '../src/index.ts';
import { fakeRepo } from './fixtures.ts';
import { binDir, runCli, scratch } from './helpers.ts';

const REPO = 'pip/public-app';

/** Points this process's gh at the stub and its answers, for the length of `f`. */
const withStub = <T>(env: Record<string, string>, f: () => T): T => {
  const root = scratch();
  const fixtures = join(root, 'routes.json');
  writeFileSync(fixtures, JSON.stringify(fakeRepo({ repo: REPO })));
  writeFileSync(join(root, 'gh.log'), '');
  const set = { PATH: binDir(root), GH_STUB_FIXTURES: fixtures, GH_STUB_LOG: join(root, 'gh.log'), GH_TOKEN: '', ...env };
  const before = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
  Object.assign(process.env, set);
  try {
    return f();
  } finally {
    for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
};

describe('scoreRepo', () => {
  it('returns the report --json prints', async () => {
    // As JSON, which drops what's undefined, such as `unscored` on a scored report.
    const report = JSON.parse(JSON.stringify(withStub({}, () => scoreRepo(REPO))));
    const cli = JSON.parse((await runCli(['--repo', REPO, '--json'], { routes: fakeRepo({ repo: REPO }) })).stdout);

    assert.deepEqual(Object.keys(report), Object.keys(cli));
    for (const key of ['score', 'parts', 'detail', 'practices', 'stack', 'fixes']) assert.deepEqual(report[key], cli[key], key);
    assert.equal(report.read.calls, cli.read.calls);
  });

  it('reads with the token it is given', () => {
    assert.throws(() => withStub({ GH_STUB_TOKEN: 'app-token' }, () => scoreRepo(REPO)), /isn't signed in/);
    assert.equal(withStub({ GH_STUB_TOKEN: 'app-token' }, () => scoreRepo(REPO, { token: 'app-token' })).repo, REPO);
  });

  it('takes 1 to 90 days', () => {
    assert.throws(() => scoreRepo(REPO, { days: 0 }), CliError);
    assert.throws(() => scoreRepo(REPO, { days: 91 }), CliError);
  });
});
