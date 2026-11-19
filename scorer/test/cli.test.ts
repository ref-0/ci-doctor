import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { INSTALL_STEPS } from '../src/install-steps.ts';
import { fakeRepo, LOG_LINE, type Routes } from './fixtures.ts';
import { checkout, CLI, listing, runCli, scratch } from './helpers.ts';

const PUBLIC = 'pip/public-app';
const PRIVATE = 'pip/private-app';
const json = (stdout: string) => JSON.parse(stdout);
const paths = (calls: string[][]) => calls.map((c) => c.at(-1)!);

describe('the bare command in a checkout', () => {
  it("scores origin's repo", async () => {
    const dir = checkout({ origin: `git@github.com:${PUBLIC}.git` });
    const r = await runCli([], { cwd: dir, routes: fakeRepo({ repo: PUBLIC }) });

    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^${PUBLIC}: score \\d+/100, grade `));
    assert.match(r.stdout, new RegExp(`<ci-report repo="${PUBLIC}"`));
    assert.match(r.stdout, /Read live through gh: \d+ API calls\. Job logs were read in memory and not kept\. Nothing was written to disk\./);
    assert.ok(paths(r.calls).includes(`repos/${PUBLIC}`));
  });

  it('reads the default branch through gh, never raw.githubusercontent.com', async () => {
    const dir = checkout({ origin: `https://github.com/${PUBLIC}` });
    const r = await runCli(['--json'], { cwd: dir, routes: fakeRepo({ repo: PUBLIC }), noNetwork: true });

    assert.equal(r.code, 0, r.stderr);
    const workflowRead = r.calls.find((c) => c.at(-1) === `repos/${PUBLIC}/contents/.github/workflows/ci.yml?ref=main`);
    assert.ok(workflowRead?.includes('Accept: application/vnd.github.raw'));
    for (const f of readdirSync(join(CLI, '..'))) assert.doesNotMatch(readFileSync(join(CLI, '..', f), 'utf8'), /raw\.githubusercontent/);
  });
});

describe('a private repo', () => {
  it('scores the same as a public one with the same history', async () => {
    const pub = await runCli(['--repo', PUBLIC, '--json'], { routes: fakeRepo({ repo: PUBLIC }), noNetwork: true });
    const priv = await runCli(['--repo', PRIVATE, '--json'], { routes: fakeRepo({ repo: PRIVATE, private: true }), noNetwork: true });
    assert.equal(pub.code, 0, pub.stderr);
    assert.equal(priv.code, 0, priv.stderr);

    const a = json(pub.stdout);
    const b = json(priv.stdout);
    assert.equal(typeof a.score, 'number');
    for (const key of ['score', 'grade', 'parts', 'detail', 'size', 'practices', 'fixes', 'notes', 'wait', 'jobs', 'tests'])
      assert.deepEqual(b[key], a[key], key);
    assert.equal(b.practices.cancelInProgress, true);
  });
});

describe('remotes', () => {
  it('with no remote, inventories the checkout and says unscored, calling no gh', async () => {
    const dir = checkout();
    const r = await runCli([], { cwd: dir });

    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /unscored\. This checkout has no remote, so there's no Actions history to read\./);
    assert.match(r.stdout, /Package manager\s+npm/);
    assert.match(r.stdout, /Test runner\s+vitest/);
    assert.deepEqual(r.calls, []);
  });

  it('with no GitHub remote, says so', async () => {
    const dir = checkout({ origin: 'git@gitlab.com:pip/app.git' });
    const r = await runCli(['--json'], { cwd: dir });

    assert.equal(r.code, 0, r.stderr);
    const report = json(r.stdout);
    assert.equal(report.score, null);
    assert.match(report.unscored, /No remote points at github\.com \(origin\)/);
  });

  it('takes the only GitHub remote when origin is elsewhere', async () => {
    const dir = checkout({ origin: 'git@gitlab.com:pip/app.git', upstream: `https://github.com/${PUBLIC}.git` });
    const r = await runCli(['--json'], { cwd: dir, routes: fakeRepo({ repo: PUBLIC }) });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(json(r.stdout).repo, PUBLIC);
  });

  it('takes origin over another GitHub remote', async () => {
    const dir = checkout({ origin: `git@github.com:${PUBLIC}.git`, fork: 'git@github.com:mo/public-app.git' });
    const r = await runCli(['--json'], { cwd: dir, routes: fakeRepo({ repo: PUBLIC }) });

    assert.equal(json(r.stdout).repo, PUBLIC);
  });

  it('asks for --repo when several GitHub remotes and none is origin', async () => {
    const dir = checkout({ upstream: `git@github.com:${PUBLIC}.git`, fork: 'git@github.com:mo/public-app.git' });
    const r = await runCli([], { cwd: dir, routes: fakeRepo({ repo: PUBLIC }) });

    assert.equal(r.code, 2);
    assert.match(r.stderr, /Several remotes point at GitHub and none is origin: .*fork \(mo\/public-app\).*upstream \(pip\/public-app\)|upstream \(pip\/public-app\).*fork \(mo\/public-app\)/);
    assert.match(r.stderr, /Pass --repo owner\/name/);
    assert.deepEqual(r.calls, []);

    const named = await runCli(['--repo', PUBLIC, '--json'], { cwd: dir, routes: fakeRepo({ repo: PUBLIC }) });
    assert.equal(named.code, 0, named.stderr);
    assert.equal(json(named.stdout).repo, PUBLIC);
  });

  it('outside a checkout, asks for --repo', async () => {
    const r = await runCli([], { cwd: scratch() });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Not in a Git checkout/);
  });
});

describe('too little history', () => {
  it('says unscored with the reason, and still shows the practices', async () => {
    const r = await runCli(['--repo', PUBLIC], { routes: fakeRepo({ repo: PUBLIC, heads: 3 }) });

    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^pip\/public-app: unscored\. Only \d PR pushes in the window ran the main workflows; 5 are needed\./);
    assert.match(r.stdout, /Superseded PR runs cancelled\s+yes/);
    assert.doesNotMatch(r.stdout, /<ci-report/);
  });

  it('with no PR runs at all, says so', async () => {
    const r = await runCli(['--repo', PUBLIC, '--json'], { routes: fakeRepo({ repo: PUBLIC, heads: 0 }) });

    assert.equal(r.code, 0, r.stderr);
    assert.match(json(r.stdout).unscored, /no pull-request runs of GitHub Actions in the last 7 days/);
  });
});

describe('unknown is not absent', () => {
  it("a truncated tree leaves what it couldn't see unknown, and its fixes out", async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    routes[`repos/${PUBLIC}/git/trees/main`] = { status: 200, json: { tree: [{ path: 'src/index.ts', type: 'blob', size: 100 }], truncated: true } };
    const r = await runCli(['--repo', PUBLIC, '--json'], { routes });

    assert.equal(r.code, 0, r.stderr);
    const report = json(r.stdout);
    assert.equal(report.practices.cancelInProgress, null);
    assert.equal(report.practices.timeouts, null);
    assert.equal(report.practices.agentsMd, null);
    assert.ok(!report.fixes.some((f: { text: string }) => /Cancel superseded|timeout-minutes/.test(f.text)));
    assert.ok(!report.notes.some((n: { text: string }) => /No AGENTS\.md/.test(n.text)));

    const text = await runCli(['--repo', PUBLIC], { routes });
    assert.match(text.stdout, /Superseded PR runs cancelled\s+unknown/);
    assert.match(text.stdout, /Unknown because: GitHub cut the file tree short/);
  });

  it('more workflows than it reads leaves the rest unknown', async () => {
    const r = await runCli(['--repo', PUBLIC, '--json'], { routes: fakeRepo({ repo: PUBLIC, workflows: 45 }) });

    const report = json(r.stdout);
    assert.equal(report.practices.cancelInProgress, true);
    assert.equal(report.practices.mergeQueue, null);
    assert.ok(report.practices.unknown.includes('Read the first 40 of 45 workflow files'));
  });

  it('a known absence still shows its fix', async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    routes[`repos/${PUBLIC}/contents/.github/workflows/ci.yml?ref=main`] = { status: 200, raw: 'on: pull_request\njobs: {}\n' };
    const report = json((await runCli(['--repo', PUBLIC, '--json'], { routes })).stdout);

    assert.equal(report.practices.cancelInProgress, false);
    assert.ok(report.fixes.some((f: { text: string }) => /Cancel superseded/.test(f.text)));
  });
});

describe('gh', () => {
  it('missing: fails and says how to get it', async () => {
    const r = await runCli(['--repo', PUBLIC], { gh: false });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /gh isn't installed or isn't on PATH/);
    assert.equal(r.stdout, '');
  });

  it('not signed in: fails and says to sign in', async () => {
    const r = await runCli(['--repo', PUBLIC], { routes: fakeRepo({ repo: PUBLIC }), env: { GH_STUB_MODE: 'signed-out' } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /gh isn't signed in\. Run `gh auth login`/);
  });

  it('a bad token: fails and says to sign in', async () => {
    const r = await runCli(['--repo', PUBLIC], { routes: { [`repos/${PUBLIC}`]: { status: 401, message: 'Bad credentials' } } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /gh isn't signed in/);
  });

  it("can't see the repo: fails and names the scope", async () => {
    const r = await runCli(['--repo', PRIVATE], { routes: {} });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /GitHub has no repo pip\/private-app that this gh account can see.*`repo` scope/);
  });

  it("can see the repo but not its Actions: fails, doesn't score", async () => {
    const routes = fakeRepo({ repo: PRIVATE, private: true });
    routes[`repos/${PRIVATE}/actions/runs?event=pull_request&page=1`] = { status: 403, message: 'Resource not accessible by integration' };
    const r = await runCli(['--repo', PRIVATE], { routes });

    assert.equal(r.code, 1);
    assert.match(r.stderr, /Couldn't read repos\/pip\/private-app\/actions\/runs.*Resource not accessible by integration \(HTTP 403\).*may lack access/);
    assert.equal(r.stdout, '');
  });
});

describe('a failed read', () => {
  it('exits non-zero, naming the read, after one retry', async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    const path = `repos/${PUBLIC}/contents/.github/workflows/ci.yml?ref=main`;
    routes[path] = { status: 502, message: 'Bad Gateway' };
    const r = await runCli(['--repo', PUBLIC], { routes });

    assert.equal(r.code, 1);
    assert.match(r.stderr, /Couldn't read repos\/pip\/public-app\/contents\/\.github\/workflows\/ci\.yml\?ref=main: Bad Gateway \(HTTP 502\)/);
    assert.equal(r.stdout, '');
    assert.equal(paths(r.calls).filter((p) => p === path).length, 2);
  });

  it("isn't retried when it's a 4xx", async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    routes[`repos/${PUBLIC}/languages`] = { status: 422, message: 'Unprocessable' };
    const r = await runCli(['--repo', PUBLIC], { routes });

    assert.equal(r.code, 1);
    assert.equal(paths(r.calls).filter((p) => p === `repos/${PUBLIC}/languages`).length, 1);
  });
});

describe('--standing', () => {
  const endpoint = async (handle: (req: IncomingMessage, body: string) => void) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        handle(req, body);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"standing":"Top 30% of small repos"}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    return { url: `http://127.0.0.1:${port}/standing`, close: () => new Promise((resolve) => server.close(resolve)) };
  };

  it('sends only the score and the size class', async () => {
    const seen: { req: IncomingMessage; body: string }[] = [];
    const server = await endpoint((req, body) => seen.push({ req, body }));
    try {
      const r = await runCli(['--repo', PUBLIC, '--json', '--standing', '--standing-url', server.url], { routes: fakeRepo({ repo: PUBLIC }) });
      assert.equal(r.code, 0, r.stderr);
      const report = json(r.stdout);

      assert.equal(seen.length, 1);
      const { req, body } = seen[0]!;
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/standing');
      assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ['score', 'size']);
      assert.deepEqual(JSON.parse(body), { score: report.score, size: report.size });
      // Nothing that names the repo or the account rides along in the headers either.
      assert.doesNotMatch(JSON.stringify(req.headers), /pip|public-app|authorization|cookie/i);
      assert.match(r.stderr, /Sent the score and size class, and nothing else, to http:\/\/127\.0\.0\.1:\d+\. It said: Top 30% of small repos/);
    } finally {
      await server.close();
    }
  });

  it('sends nothing without --standing, or with no score', async () => {
    const seen: string[] = [];
    const server = await endpoint((_, body) => seen.push(body));
    try {
      const plain = await runCli(['--repo', PUBLIC], { routes: fakeRepo({ repo: PUBLIC }), env: { CI_DOCTOR_STANDING_URL: server.url } });
      assert.equal(plain.code, 0, plain.stderr);
      const unscored = await runCli(['--repo', PUBLIC, '--standing', '--standing-url', server.url], { routes: fakeRepo({ repo: PUBLIC, heads: 2 }) });
      assert.equal(unscored.code, 0, unscored.stderr);
      assert.match(unscored.stdout, /Standing not sent: there is no score to send\./);
      const local = await runCli(['--standing', '--standing-url', server.url], { cwd: checkout() });
      assert.equal(local.code, 0, local.stderr);
      assert.deepEqual(seen, []);
    } finally {
      await server.close();
    }
  });

  it('needs a named endpoint, checked before any read', async () => {
    const r = await runCli(['--repo', PUBLIC, '--standing'], { routes: fakeRepo({ repo: PUBLIC }) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--standing has no endpoint yet/);
    assert.deepEqual(r.calls, []);

    const plain = await runCli(['--repo', PUBLIC, '--standing', '--standing-url', 'http://example.com/x'], {});
    assert.equal(plain.code, 2);
    assert.match(plain.stderr, /must be https/);
  });
});

describe('files', () => {
  it('writes none by default', async () => {
    const dir = checkout({ origin: `git@github.com:${PUBLIC}.git` });
    const before = listing(dir);
    const dist = listing(join(CLI, '..'));
    const r = await runCli([], { cwd: dir, routes: fakeRepo({ repo: PUBLIC }) });

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(listing(r.home), []);
    assert.deepEqual(listing(dir), before);
    assert.deepEqual(listing(join(CLI, '..')), dist);
  });

  it('with --cache and --save, keys them to the gh account, states freshness and keeps no logs', async () => {
    const routes: Routes = fakeRepo({ repo: PUBLIC });
    const cacheDir = join(scratch(), 'cache');
    const env = { CI_DOCTOR_CACHE_DIR: cacheDir };
    const first = await runCli(['--repo', PUBLIC, '--cache', '--save'], { routes, env });
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, new RegExp(`Read live through gh: \\d+ API calls, cached in ${join(cacheDir, 'pip', 'api')}\\.`));
    assert.match(first.stdout, new RegExp(`Saved the report to ${join(cacheDir, 'pip', 'reports', 'pip__public-app')}`));

    const files = listing(cacheDir);
    assert.ok(files.every((f) => f.startsWith(join(cacheDir, 'pip'))));
    assert.ok(files.some((f) => f.includes(join('pip', 'reports', 'pip__public-app'))));
    for (const f of files) assert.ok(!readFileSync(f, 'utf8').includes(LOG_LINE.slice(30)), `${f} holds a job log`);

    const second = await runCli(['--repo', PUBLIC, '--cache'], { routes, env });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /\d+ API calls live and \d+ answers from the cache in .*, the oldest (under a minute|1 minute) old\./);
    // Only the account check, the logs, and the commits (keyed to the moment 28 days back) go out again.
    assert.ok(paths(second.calls).every((p) => p === 'user' || /\/logs$/.test(p) || /\/commits\?/.test(p)), paths(second.calls).join('\n'));
  });
});

describe('agents skills', () => {
  it('prints every harness and step from the one constant', async () => {
    const r = await runCli(['agents', 'skills']);
    assert.equal(r.code, 0, r.stderr);
    for (const { harness, steps } of INSTALL_STEPS) {
      assert.match(r.stdout, new RegExp(harness.replace(/[/]/g, '\\/')));
      for (const step of steps) assert.ok(r.stdout.includes(step), step);
    }
    assert.deepEqual(r.calls, []);
  });

  it('rejects other commands', async () => {
    assert.equal((await runCli(['agents'])).code, 2);
    assert.equal((await runCli(['score'])).code, 2);
    assert.equal((await runCli(['--nope'])).code, 2);
  });
});
