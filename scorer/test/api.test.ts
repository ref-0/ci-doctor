// scoreRepo from code, with the gh stub first on PATH, as a script that holds a GitHub App's token would call it.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CliError, rereadPractices, scoreRepo } from '../src/index.ts';
import { blobSha, fakeRepo, WORKFLOW, type Routes } from './fixtures.ts';
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

describe('rereadPractices', () => {
  const withActions = (n: number) => {
    const routes = fakeRepo({ repo: REPO });
    const tree = routes[`repos/${REPO}/git/trees/main`]!.json as { tree: { path: string; type: string; size: number; sha: string }[] };
    for (let i = 0; i < n; i++) {
      const path = `.github/actions/step-${i}/action.yml`;
      tree.tree.push({ path, type: 'blob', size: 60, sha: blobSha(path) });
      routes[`repos/${REPO}/contents/${path}?ref=main`] = { status: 200, raw: `runs:\n  using: composite\n  steps:\n    - run: echo ${i}\n      shell: bash\n` };
    }
    return routes;
  };

  it('reads a dozen local actions in one more call', () => {
    const calls = (routes: Routes) => JSON.parse(JSON.stringify(stubbed(routes, {}, () => scoreRepo(REPO)))).read.calls;
    assert.equal(calls(withActions(12)) - calls(fakeRepo({ repo: REPO })), 1);
  });

  it("gives a stored report today's practices, fixes and notes, and leaves the rest as stored", () => {
    const stored = JSON.parse(JSON.stringify(withStub({}, () => scoreRepo(REPO))));
    const routes = fakeRepo({ repo: REPO });
    routes[`repos/${REPO}/contents/.github/workflows/ci.yml?ref=main`] = { status: 200, raw: WORKFLOW.replace(/\s+cancel-in-progress: true/, '') };
    const [again, asked] = stubbed(routes, {}, (log) => [JSON.parse(JSON.stringify(rereadPractices(stored))), log().map((args) => args.find((a) => /^(repos|search|graphql)\b/.test(a)) ?? '')]);

    assert.equal(stored.practices.cancelInProgress, true);
    assert.equal(again.practices.cancelInProgress, false);
    assert.ok(again.fixes.some((f: { text: string }) => /Cancel superseded/.test(f.text)));
    assert.equal(again.practicesDate, new Date().toISOString().slice(0, 10));
    const { practices: _p, fixes: _f, notes: _n, practicesDate: _d, ...rest } = again;
    const { practices: _sp, fixes: _sf, notes: _sn, ...storedRest } = stored;
    assert.deepEqual(rest, storedRest);
    assert.ok(asked.every((path: string) => /^(repos\/[^/]+\/[^/]+(\/git\/trees\/main\?recursive=1|\/contents\/.+)?|graphql|search\/issues\?.*is%3Amerged.*)$/.test(path)), asked.join('\n'));
  });

  it('refuses a checkout report, which has no repo to read', () => {
    assert.throws(() => rereadPractices({ repo: null }), CliError);
  });
});
