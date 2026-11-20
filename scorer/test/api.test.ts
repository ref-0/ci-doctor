// scoreRepo from code, with the gh stub first on PATH, as a script that holds a GitHub App's token would call it.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CliError, scoreRepo } from '../src/index.ts';
import { fakeRepo } from './fixtures.ts';
import { runCli, withStub as stubbed } from './helpers.ts';

const REPO = 'pip/public-app';

const withStub = <T>(env: Record<string, string>, f: () => T): T => stubbed(fakeRepo({ repo: REPO }), env, f);

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
