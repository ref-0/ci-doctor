import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { execFileSync } from 'node:child_process';
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
  it('is read as a public one is: the same waits, jobs, tests, practices and fixes', async () => {
    const pub = await runCli(['--repo', PUBLIC, '--json'], { routes: fakeRepo({ repo: PUBLIC }), noNetwork: true });
    const priv = await runCli(['--repo', PRIVATE, '--json'], { routes: fakeRepo({ repo: PRIVATE, private: true }), noNetwork: true });
    assert.equal(pub.code, 0, pub.stderr);
    assert.equal(priv.code, 0, priv.stderr);

    const a = json(pub.stdout);
    const b = json(priv.stdout);
    assert.equal(typeof a.score, 'number');
    assert.equal(typeof b.score, 'number');
    // Not the score: a private repo's standard runner has half the vCPUs, so its minutes count half.
    for (const key of ['size', 'practices', 'fixes', 'notes', 'wait', 'jobs', 'tests'])
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

describe('how gh is called', () => {
  it('pins github.com whatever GH_HOST says, with telemetry off (the stub fails any call without both)', async () => {
    const r = await runCli(['--repo', PUBLIC, '--json'], { routes: fakeRepo({ repo: PUBLIC }), env: { GH_HOST: 'ghe.example.com' } });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.calls.length > 10);
  });

  it('works with gh before 2.97, which has no --allow-escape-sequences', async () => {
    const r = await runCli(['--repo', PUBLIC, '--json'], { routes: fakeRepo({ repo: PUBLIC }), env: { GH_STUB_MODE: 'old' } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(typeof json(r.stdout).score, 'number');
    assert.equal(r.calls.filter((c) => c.includes('--allow-escape-sequences')).length, 1);
  });

  it('reads a GitHub remote spelled through insteadOf', async () => {
    const dir = checkout({ origin: `gh:${PUBLIC}` });
    execFileSync('git', ['config', 'url.git@github.com:.insteadOf', 'gh:'], { cwd: dir });
    const r = await runCli(['--json'], { cwd: dir, routes: fakeRepo({ repo: PUBLIC }) });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(json(r.stdout).repo, PUBLIC);
  });
});

describe('statistics GitHub is still computing', () => {
  it('leave the pace unknown, and are not cached', async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    // gh prints nothing and exits 0 on GitHub's 202.
    routes[`repos/${PUBLIC}/stats/participation`] = { status: 200, text: '' };
    const cacheDir = join(scratch(), 'cache');
    const r = await runCli(['--repo', PUBLIC, '--json', '--cache'], { routes, env: { CI_DOCTOR_CACHE_DIR: cacheDir } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(json(r.stdout).profile.pace, null);
    for (const f of listing(cacheDir)) assert.notEqual(JSON.parse(readFileSync(f, 'utf8')).body, '', `${f} keeps an empty answer`);

    const thin = fakeRepo({ repo: PUBLIC, heads: 3 });
    thin[`repos/${PUBLIC}/stats/participation`] = { status: 200, text: '' };
    const unscored = await runCli(['--repo', PUBLIC], { routes: thin });
    assert.equal(unscored.code, 0, unscored.stderr);
    assert.match(unscored.stdout, /pace –× the year/);
  });
});

describe('too little history', () => {
  it('says unscored with the reason, and still shows the practices', async () => {
    const r = await runCli(['--repo', PUBLIC], { routes: fakeRepo({ repo: PUBLIC, heads: 3 }) });

    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^pip\/public-app: unscored\. Only \d PR pushes in the window ran the main workflows; 5 are needed\./);
    assert.match(r.stdout, /Superseded PR runs cancelled\s+yes/);
    assert.match(r.stdout, /^Repo: ~\d+k? lines \(TypeScript \d+%/m);
    assert.doesNotMatch(r.stdout, /<ci-report/);
  });

  it("when bots made nearly every push, says so rather than that the main workflows didn't run", async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    const prRuns = routes[`repos/${PUBLIC}/actions/runs?event=pull_request&page=1`]!.json as { workflow_runs: { actor: { login: string } }[] };
    for (const run of prRuns.workflow_runs) run.actor = { login: 'syncbot[bot]' };
    const r = await runCli(['--repo', PUBLIC, '--json'], { routes });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(json(r.stdout).unscored, '20 of 20 PR pushes in the window came from bots (syncbot[bot]), and only pushes people make are timed; 5 are needed.');
  });

  it('blames bots from four pushes in five, and not below', async () => {
    const share = async (people: RegExp) => {
      const routes = fakeRepo({ repo: PUBLIC });
      const prRuns = routes[`repos/${PUBLIC}/actions/runs?event=pull_request&page=1`]!.json as { workflow_runs: { head_sha: string; actor: { login: string } }[] };
      for (const run of prRuns.workflow_runs) run.actor = { login: people.test(run.head_sha) ? 'pip' : run.head_sha.endsWith('0') ? 'mirror[bot]' : 'syncbot[bot]' };
      return json((await runCli(['--repo', PUBLIC, '--json'], { routes })).stdout).unscored;
    };

    assert.equal(await share(/-sha-1[6-9]$/), '16 of 20 PR pushes in the window came from bots (syncbot[bot], mirror[bot]), and only pushes people make are timed; 5 are needed.');
    assert.equal(await share(/-sha-1[5-9]$/), undefined);
  });

  it('counts a bot\'s push whose runs were all skipped among the bots\' pushes', async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    const prRuns = routes[`repos/${PUBLIC}/actions/runs?event=pull_request&page=1`]!.json as { workflow_runs: { head_sha: string; conclusion: string; actor: { login: string } }[] };
    for (const run of prRuns.workflow_runs) {
      run.actor = { login: 'syncbot[bot]' };
      if (/-sha-1?[0-4]$/.test(run.head_sha)) run.conclusion = 'skipped';
    }
    const r = await runCli(['--repo', PUBLIC, '--json'], { routes });

    assert.equal(r.code, 0, r.stderr);
    assert.match(json(r.stdout).unscored, /^20 of 20 PR pushes in the window came from bots \(syncbot\[bot\]\)/);
  });

  it("with PR runs of no gating workflow, doesn't blame bots", async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    const prRuns = routes[`repos/${PUBLIC}/actions/runs?event=pull_request&page=1`]!.json as { workflow_runs: { name: string }[] };
    for (const run of prRuns.workflow_runs) run.name = 'PR labeler';
    const r = await runCli(['--repo', PUBLIC, '--json'], { routes });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(json(r.stdout).unscored, 'Only 0 PR pushes in the window ran the main workflows; 5 are needed.');
  });

  it('with no PR runs at all, says so', async () => {
    const r = await runCli(['--repo', PUBLIC, '--json'], { routes: fakeRepo({ repo: PUBLIC, heads: 0 }) });

    assert.equal(r.code, 0, r.stderr);
    assert.match(json(r.stdout).unscored, /no pull-request runs of GitHub Actions in the last 7 days/);
  });

  it('with no workflows, suggests no fixes, and shows no merged PRs and one author in words', async () => {
    const routes = fakeRepo({ repo: PUBLIC, heads: 0, workflows: 0 });
    routes[`repos/${PUBLIC}/commits?page=1`] = { status: 200, json: Array.from({ length: 8 }, () => ({ author: { login: 'pip' } })) };
    routes['search/issues?merged'] = { status: 200, json: { total_count: 0, items: [] } };
    const r = await runCli(['--repo', PUBLIC], { routes });

    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^pip\/public-app: unscored\. There are no GitHub Actions workflows on main/);
    assert.match(r.stdout, / by 1 person \(28 days/);
    assert.match(r.stdout, /0 PRs merged\/week, – by bots/);
    assert.doesNotMatch(r.stdout, /null|Fix first:/);
  });
});

describe('the stack', () => {
  it('is in the report, its manifests read in one GraphQL call', async () => {
    const r = await runCli(['--repo', PUBLIC, '--json'], { routes: fakeRepo({ repo: PUBLIC }), noNetwork: true });

    assert.equal(r.code, 0, r.stderr);
    const { stack } = json(r.stdout);
    assert.deepEqual(stack.languages, [['TypeScript', 98], ['JavaScript', 3]]);
    assert.deepEqual(stack.workspace, { packageManagers: ['pnpm'], tools: [] });
    assert.deepEqual(stack.packages, json(r.stdout).profile.packages);
    assert.deepEqual(stack.testRunners, ['Vitest']);
    assert.deepEqual(stack.lintFormat, ['ESLint']);
    assert.deepEqual(stack.runners, json(r.stdout).jobs.providers);
    assert.deepEqual(stack.agentFiles, []);
    assert.deepEqual(stack.graph, { packages: [{ name: 'app', path: 'package.json', ecosystem: 'npm', internal: [], exports: false }], count: 1, edges: 0, cycles: [], maxDepth: 0, topFanIn: [] });
    assert.equal(r.calls.filter((c) => c.includes('graphql')).length, 1);

    const text = await runCli(['--repo', PUBLIC], { routes: fakeRepo({ repo: PUBLIC }) });
    assert.match(text.stdout, /^Stack:\n  Languages\s+TypeScript 98%, JavaScript 3%\n  Workspace\s+pnpm · 1 npm package\n  Tests\s+Vitest\n  Lint, format\s+ESLint$/m);
    assert.match(text.stdout, /^  Package graph\s+1 package, 0 internal edges, depth 0, 0 cycles$/m);
  });

  it('has the graphs, which add no call for a repo with no entry files or task configs', async () => {
    const r = await runCli(['--repo', PUBLIC, '--json'], { routes: fakeRepo({ repo: PUBLIC }), noNetwork: true });

    assert.equal(r.code, 0, r.stderr);
    const { graphs } = json(r.stdout);
    assert.deepEqual(Object.keys(graphs), ['schema', 'packages', 'exports', 'layers', 'tasks', 'jobs', 'thresholds', 'read', 'unknown']);
    assert.deepEqual(graphs.read, { files: 0, calls: 0 });
    assert.deepEqual(graphs.exports.count, { nodes: 0, edges: 0, packages: 1, packagesWithEntries: 0, filesRead: 0 });
    assert.equal(graphs.jobs.count.nodes, 1);

    const text = await runCli(['--repo', PUBLIC], { routes: fakeRepo({ repo: PUBLIC }) });
    assert.match(text.stdout, /^Graphs \(guide section 21; flags first\):\n  No flags\.\n  1 Packages {6}1 package, 0 internal edges, depth 0, 0 cycles\n  2 Export paths  none of the 1 npm package declares `exports`, `main` or `module`\n  3 Layers {8}run `scripts\/graph\/` for layers and what triggers what$/m);
  });

  it('reads a workflow that the tree lists but GitHub no longer has once, for the practices and the stack', async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    const tree = routes[`repos/${PUBLIC}/git/trees/main`]!.json as { tree: { path: string; type: string; size: number }[] };
    tree.tree.push({ path: '.github/workflows/gone.yml', type: 'blob', size: 10 });
    const r = await runCli(['--repo', PUBLIC, '--json'], { routes });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(paths(r.calls).filter((p) => p.startsWith(`repos/${PUBLIC}/contents/.github/workflows/gone.yml`)).length, 1);
  });

  it("in a checkout, comes from its files, with GitHub's languages and runners unknown", async () => {
    const r = await runCli(['--json'], { cwd: checkout() });

    assert.equal(r.code, 0, r.stderr);
    const { stack } = json(r.stdout);
    assert.deepEqual(stack.testRunners, ['Vitest']);
    assert.deepEqual(stack.workspace.packageManagers, ['npm']);
    assert.equal(stack.languages, null);
    assert.equal(stack.runners, null);
    assert.deepEqual(r.calls, []);
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

  it("fails on a rate limit, even where a 403 would mean there's no log", async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    for (const key of Object.keys(routes)) if (key.endsWith('/logs')) routes[key] = { status: 403, message: 'API rate limit exceeded for user ID 1' };
    const r = await runCli(['--repo', PUBLIC], { routes });

    assert.equal(r.code, 1);
    assert.match(r.stderr, /rate limit/);
    assert.equal(r.stdout, '');
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

    for (const url of ['https://example.com/x?repo=pip/public-app', 'https://example.com/x#frag', 'https://user:hunter2@example.com/x']) {
      const extra = await runCli(['--repo', PUBLIC, '--standing', '--standing-url', url], {});
      assert.equal(extra.code, 2, url);
      assert.match(extra.stderr, /takes no query, fragment or credentials/);
      assert.doesNotMatch(extra.stderr, /hunter2/);
      assert.deepEqual(extra.calls, []);
    }
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

describe('job logs', () => {
  it('keep only test names and timings: other text on a matching line goes nowhere', async () => {
    const SECRET = 'ghp_synthetic0secret0for0tests';
    const routes: Routes = fakeRepo({ repo: PUBLIC });
    const log = [
      LOG_LINE,
      `2026-11-19T10:00:01.0000000Z     FAIL [  14.000s] deploy token ${SECRET} rejected by the registry`,
      `2026-11-19T10:00:02.0000000Z     PASS [  13.000s] \x1b]0;${SECRET}\x07 app::bin/app tests::slow`,
      '2026-11-19T10:00:03.0000000Z     PASS [  11.500s] (3/9) app::bin/app tests::slow_one',
    ].join('\n');
    for (const key of Object.keys(routes)) if (key.endsWith('/logs')) routes[key] = { status: 200, text: `${log}\n` };
    const cacheDir = join(scratch(), 'cache');
    const r = await runCli(['--repo', PUBLIC, '--cache', '--save'], { routes, env: { CI_DOCTOR_CACHE_DIR: cacheDir } });

    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /app::bin\/app tests::slow_one 11\.5 s/);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(`${SECRET}|\x1b\\]`));
    const files = listing(cacheDir);
    assert.ok(files.some((f) => f.includes('reports')));
    for (const f of files) assert.ok(!readFileSync(f, 'utf8').includes(SECRET), `${f} holds log text`);
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

describe('runs that never ran', () => {
  type FakeRun = { id: number; head_sha: string; conclusion: string; created_at: string; updated_at: string };
  /** Pip's heads 7 to 9, stretched to 50 hours and failed, with or without jobs. */
  const stretched = (withJobs: boolean) => {
    const routes = fakeRepo({ repo: PUBLIC });
    const prRuns = routes[`repos/${PUBLIC}/actions/runs?event=pull_request&page=1`]!.json as { workflow_runs: FakeRun[] };
    for (const run of prRuns.workflow_runs.filter((each) => /-sha-[789]$/.test(each.head_sha))) {
      run.conclusion = 'failure';
      run.updated_at = new Date(Date.parse(run.created_at) + 50 * 3600e3).toISOString();
      if (!withJobs) routes[`repos/${PUBLIC}/actions/runs/${run.id}/attempts/1/jobs?page=1`] = { status: 200, json: { total_count: 0, jobs: [] } };
    }
    return routes;
  };

  it("leaves a run that took hours with no jobs out of the wait and the red heads, as a fork's unapproved run closed later", async () => {
    const plain = json((await runCli(['--repo', PUBLIC, '--json'], { routes: fakeRepo({ repo: PUBLIC }) })).stdout).wait;
    const r = await runCli(['--repo', PUBLIC, '--json'], { routes: stretched(false) });

    assert.equal(r.code, 0, r.stderr);
    const wait = json(r.stdout).wait;
    assert.equal(wait.neverRan, 3);
    assert.ok(wait.p90 <= plain.p90, `p90 ${wait.p90} min, against ${plain.p90} without the stretched runs`);
    assert.equal(wait.timed, plain.timed - 3);
    assert.equal(wait.ranHeads, plain.ranHeads - 3);
    assert.equal(Math.round(wait.redRate * wait.ranHeads), Math.round(plain.redRate * plain.ranHeads));
  });

  it('keeps a run that took hours with jobs, which is CI time', async () => {
    const r = await runCli(['--repo', PUBLIC, '--json'], { routes: stretched(true) });

    assert.equal(r.code, 0, r.stderr);
    const wait = json(r.stdout).wait;
    assert.equal(wait.neverRan, 0);
    assert.ok(wait.p90 > 60 * 49, `p90 ${wait.p90} min`);
  });
});

describe('what a score rests on', () => {
  const report = async (routes: Routes, args: string[] = ['--json']) => {
    const r = await runCli(['--repo', PUBLIC, ...args], { routes });
    assert.equal(r.code, 0, r.stderr);
    return r;
  };
  const checksAt = (i: number) => `repos/${PUBLIC}/commits/pull_request-sha-${i}/check-runs`;
  const statusesAt = (i: number) => `repos/${PUBLIC}/commits/pull_request-sha-${i}/statuses`;
  // A check that started with push `sha` and ended `minutes` after it.
  const checkOf = (slug: string, sha: number, minutes: number) => {
    const started = Date.now() - (sha * 3 + 1) * 3600e3;
    return { status: 'completed', started_at: new Date(started).toISOString(), completed_at: new Date(started + minutes * 60e3).toISOString(), app: { slug } };
  };
  const ran = (slug: string, sha: number, minutes: number) => ({ status: 200, json: { total_count: 1, check_runs: [checkOf(slug, sha, minutes)] } });
  const denied = { status: 403, message: 'Resource not accessible by integration' };
  const outsideCalls = (calls: string[][]) => paths(calls).filter((path) => /\/commits\/[^/]+\/(check-runs|statuses)/.test(path));

  it('is sure of a repo whose pushes carry no other CI, and reads three pushes to know', async () => {
    const r = await report(fakeRepo({ repo: PUBLIC, heads: 30 }));
    const { evidence, score } = json(r.stdout);

    assert.equal(typeof score, 'number');
    assert.deepEqual(evidence, { confidence: 'high', reasons: [], measured: 1, missing: [], outsideCi: { sampled: 3, read: 3, configs: [], pushes: [] } });
    assert.deepEqual(outsideCalls(r.calls), [0, 1, 2].flatMap((i) => [`${checksAt(i)}?per_page=100`, `repos/${PUBLIC}/commits/pull_request-sha-${i}/statuses?per_page=100`]));
  });

  it('gives no score when another CI was still running after the Actions checks on the sampled pushes', async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    for (const i of [0, 1, 2]) routes[checksAt(i)] = ran('azure-pipelines', i, 70);
    const r = json((await report(routes)).stdout);

    assert.equal(r.score, null);
    assert.equal(r.grade, null);
    assert.deepEqual(r.parts, {});
    assert.match(r.unscored, /^Pull requests here wait on Azure Pipelines, outside GitHub Actions: on 3 of 3 sampled pushes it was still running when the Actions checks finished, until at least 70 minutes after the push against \d(\.\d)? minutes at the median\./);
    assert.equal(r.evidence.confidence, null);
    assert.deepEqual(r.evidence.outsideCi.pushes.map((push: { ci: unknown }) => push.ci), Array.from({ length: 3 }, () => [{ name: 'Azure Pipelines', minutes: 70 }]));
  });

  it('scores a repo whose other CI finished before its Actions checks, and says the score is less sure', async () => {
    const routes = fakeRepo({ repo: PUBLIC, heads: 30 });
    for (const i of [0, 1, 2]) routes[checksAt(i)] = ran('circleci-checks', i, 2);
    const r = await report(routes, []);

    assert.match(r.stdout, new RegExp(`^${PUBLIC}: score \\d+/100, grade `));
    assert.match(r.stdout, /\nConfidence medium: CircleCI also ran on 3 of 3 sampled pushes, which the score doesn't read\.\nThe score reads GitHub Actions' history: .* It doesn't see what the tests prove, what CI costs in money, or checks that run outside GitHub Actions\.\n/);
    assert.match(r.stdout, /<ci-report [^\n]+\nScore [^\n]+\nConfidence medium: CircleCI also ran/);
  });

  it("scores a repo whose other checks it couldn't read, and says so", async () => {
    const routes = fakeRepo({ repo: PUBLIC, heads: 30 });
    for (const key of Object.keys(routes)) if (/\/check-runs$/.test(key)) routes[key] = denied;
    const r = json((await report(routes)).stdout);

    assert.equal(typeof r.score, 'number');
    assert.equal(r.evidence.confidence, 'medium');
    assert.deepEqual(r.evidence.reasons, ["checks from outside GitHub Actions couldn't be read"]);
    assert.deepEqual(r.evidence.outsideCi, { sampled: 3, read: 0, configs: [], pushes: [] });
  });

  it("takes a push as unread when either of its two answers didn't come, and says how many", async () => {
    const routes = fakeRepo({ repo: PUBLIC, heads: 30 });
    routes[checksAt(0)] = denied;
    routes[statusesAt(1)] = denied;
    const r = json((await report(routes)).stdout);

    assert.equal(r.evidence.confidence, 'medium');
    assert.deepEqual(r.evidence.reasons, ["checks from outside GitHub Actions couldn't be read on 2 of 3 sampled pushes"]);
    assert.deepEqual(r.evidence.outsideCi, { sampled: 3, read: 1, configs: [], pushes: [] });
  });

  it("reads a push's check runs past the first page", async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    for (const i of [0, 1, 2]) {
      routes[checksAt(i)] = { status: 200, json: { total_count: 101, check_runs: Array.from({ length: 100 }, () => checkOf('github-actions', i, 4)) } };
      routes[`${checksAt(i)}?page=2`] = { status: 200, json: { total_count: 101, check_runs: [checkOf('buildkite', i, 45)] } };
    }
    const r = await report(routes);

    assert.match(json(r.stdout).unscored, /^Pull requests here wait on Buildkite, outside GitHub Actions: on 3 of 3 sampled pushes/);
    assert.deepEqual(outsideCalls(r.calls).filter((path) => /check-runs/.test(path)), [0, 1, 2].flatMap((i) => [`${checksAt(i)}?per_page=100`, `${checksAt(i)}?per_page=100&page=2`]));
  });

  it("samples the newest pushes across both pull request events, not one event's first", async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    const runs = routes[`repos/${PUBLIC}/actions/runs?event=pull_request&page=1`]!.json as { workflow_runs: Record<string, unknown>[] };
    // Three pushes a few minutes old, which only a pull_request_target workflow ran on.
    const targets = [0, 1, 2].map((i) => {
      const created = Date.now() - (i + 2) * 60e3;
      return { ...runs.workflow_runs[0]!, id: 9000 + i, event: 'pull_request_target', head_sha: `target-sha-${i}`, conclusion: 'success', run_attempt: 1, created_at: new Date(created).toISOString(), run_started_at: new Date(created + 5e3).toISOString(), updated_at: new Date(created + 60e3).toISOString() };
    });
    routes[`repos/${PUBLIC}/actions/runs?event=pull_request_target&page=1`] = { status: 200, json: { total_count: 3, workflow_runs: targets } };
    for (const run of targets) {
      routes[`repos/${PUBLIC}/actions/runs/${run.id}/attempts/1/jobs?page=1`] = { status: 200, json: { total_count: 0, jobs: [] } };
      routes[`repos/${PUBLIC}/commits/${run.head_sha}/check-runs`] = { status: 200, json: { total_count: 0, check_runs: [] } };
      routes[`repos/${PUBLIC}/commits/${run.head_sha}/statuses`] = { status: 200, json: [] };
    }
    const r = await report(routes);

    assert.deepEqual(outsideCalls(r.calls).filter((path) => /check-runs/.test(path)), [0, 1, 2].map((i) => `repos/${PUBLIC}/commits/target-sha-${i}/check-runs?per_page=100`));
  });

  it('reads no other checks when a whole part of the score is already unmeasured', async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    for (const key of Object.keys(routes)) if (/\/attempts\/1\/jobs\?page=1$/.test(key)) routes[key] = { status: 200, json: { total_count: 0, jobs: [] } };
    routes['search/issues?merged'] = { status: 200, json: { total_count: 0, items: [] } };
    const r = await report(routes);

    assert.equal(json(r.stdout).score, null);
    assert.equal(json(r.stdout).unscored, "Too little of the score's efficiency part could be measured to score: none of vCPU-minutes per merged PR, runs per merged PR, setup time, queue time or how the jobs are wired.");
    assert.deepEqual(outsideCalls(r.calls), []);
  });

  it("gives no score when the repo keeps another CI's config and its Actions checks are small for its size", async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    const tree = routes[`repos/${PUBLIC}/git/trees/main`]!.json as { tree: { path: string; type: string; size: number; sha: string }[] };
    tree.tree.push({ path: '.circleci/config.yml', type: 'blob', size: 300, sha: 'c'.repeat(40) });
    const runs = routes[`repos/${PUBLIC}/actions/runs?event=pull_request&page=1`]!.json as { workflow_runs: { created_at: string; updated_at: string }[] };
    for (const run of runs.workflow_runs) run.updated_at = new Date(Date.parse(run.created_at) + 20e3).toISOString();
    const r = json((await report(routes)).stdout);

    assert.equal(r.score, null);
    assert.match(r.unscored, /^The repo keeps a config for CircleCI \(`\.circleci\/config\.yml`\), and its GitHub Actions checks on pull requests are small for its size: a wait of 0\.3 minutes, where about \d+(\.\d)? minutes is typical for 13,000 lines\./);
    assert.deepEqual(r.evidence.outsideCi.configs, [{ ci: 'CircleCI', path: '.circleci/config.yml' }]);
  });

  it("reads people's newest pushes, whichever workflows they ran, not only the pushes it timed", async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    const runs = routes[`repos/${PUBLIC}/actions/runs?event=pull_request&page=1`]!.json as { total_count: number; workflow_runs: Record<string, unknown>[] };
    // A second workflow does most of the work, and runs only on the 10 oldest pushes: those are the ones timed.
    for (const run of runs.workflow_runs.filter((each) => /-sha-1\d$/.test(each.head_sha as string))) {
      const id = (run.id as number) + 5000;
      const ended = new Date(Date.parse(run.created_at as string) + 3600e3).toISOString();
      runs.workflow_runs.push({ ...run, id, name: 'Deep', path: '.github/workflows/deep.yml', conclusion: 'success', run_attempt: 1, updated_at: ended });
      routes[`repos/${PUBLIC}/actions/runs/${id}/attempts/1/jobs?page=1`] = { status: 200, json: { jobs: [{ id: id * 10, name: 'deep', conclusion: 'success', created_at: run.created_at, started_at: run.run_started_at, completed_at: ended, labels: ['ubuntu-latest'], steps: [] }] } };
    }
    runs.total_count = runs.workflow_runs.length;
    for (const i of [0, 1, 2]) routes[checksAt(i)] = ran('buildkite', i, 45);
    const r = await report(routes);

    assert.deepEqual(json(r.stdout).wait.heavyWorkflows, ['Deep']);
    assert.deepEqual(outsideCalls(r.calls).filter((path) => /check-runs/.test(path)), [0, 1, 2].map((i) => `${checksAt(i)}?per_page=100`));
    assert.match(json(r.stdout).unscored, /^Pull requests here wait on Buildkite, outside GitHub Actions: on 3 of 3 sampled pushes/);
  });

  it('reads no other checks for a repo with too few timed pushes to score', async () => {
    const r = await report(fakeRepo({ repo: PUBLIC, heads: 3 }));

    assert.equal(json(r.stdout).score, null);
    assert.deepEqual(outsideCalls(r.calls), []);
    assert.equal(json(r.stdout).evidence.confidence, null);
  });
});

describe('what efficiency is measured in', () => {
  const report = async (routes: Routes, repo = PUBLIC) => {
    const r = await runCli(['--repo', repo, '--json'], { routes });
    assert.equal(r.code, 0, r.stderr);
    return json(r.stdout);
  };
  const relabel = (routes: Routes, labels: string[]) => {
    for (const [key, answer] of Object.entries(routes)) if (/\/attempts\/1\/jobs\?page=1$/.test(key)) for (const job of (answer.json as { jobs: { labels: string[] }[] }).jobs) job.labels = labels;
    return routes;
  };
  const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) <= 0.011 * expected + 0.11, `${actual} isn't near ${expected}`);

  it("weighs a job's minutes by its runner's vCPUs: 4 on a public repo's standard runner, 2 on a private one's", async () => {
    const open = (await report(fakeRepo({ repo: PUBLIC }))).efficiency;
    const closed = (await report(fakeRepo({ repo: PRIVATE, private: true }), PRIVATE)).efficiency;

    near(open.vcpuMinutesPerMergedPr, 4 * open.jobMinutesPerMergedPr);
    near(closed.vcpuMinutesPerMergedPr, 2 * closed.jobMinutesPerMergedPr);
    assert.equal(open.sizedShare, 1);
    near(open.expectedVcpuMinutesPerMergedPr, 4 * open.expectedMinutesPerMergedPr);
  });

  it('scores the same minutes lower on a runner 16 times the size', async () => {
    const standard = await report(fakeRepo({ repo: PUBLIC }));
    const large = await report(relabel(fakeRepo({ repo: PUBLIC }), ['ubuntu-24.04-64core']));

    assert.equal(large.efficiency.jobMinutesPerMergedPr, standard.efficiency.jobMinutesPerMergedPr);
    near(large.efficiency.vcpuMinutesPerMergedPr, 16 * standard.efficiency.vcpuMinutesPerMergedPr);
    assert.ok(large.detail.efficiency.minutesPerPr < standard.detail.efficiency.minutesPerPr, `${large.detail.efficiency.minutesPerPr} against ${standard.detail.efficiency.minutesPerPr}`);
  });

  it("counts a runner of unknown size as a standard one, and says the score is less sure", async () => {
    const standard = await report(fakeRepo({ repo: PUBLIC, heads: 30 }));
    const own = await report(relabel(fakeRepo({ repo: PUBLIC, heads: 30 }), ['self-hosted', 'big-box']));

    assert.equal(own.efficiency.vcpuMinutesPerMergedPr, standard.efficiency.vcpuMinutesPerMergedPr);
    assert.equal(own.efficiency.sizedShare, 0);
    assert.equal(own.evidence.confidence, 'medium');
    assert.deepEqual(own.evidence.reasons, ["the runners' sizes are known for 0% of job minutes, and the rest count as standard runners"]);
  });

  it("counts the known-size share as the minutes are counted, by each workflow's runs", async () => {
    const routes = fakeRepo({ repo: PUBLIC, heads: 30 });
    const runs = (routes[`repos/${PUBLIC}/actions/runs?event=pull_request&page=1`]!.json as { workflow_runs: { id: number; path: string; head_sha: string }[] }).workflow_runs;
    // Two runs of a small workflow on a standard runner; every other run on a runner of no known size.
    for (const run of runs) {
      const small = /-sha-[01]$/.test(run.head_sha);
      if (small) run.path = '.github/workflows/docs.yml';
      for (const job of (routes[`repos/${PUBLIC}/actions/runs/${run.id}/attempts/1/jobs?page=1`]!.json as { jobs: { labels: string[] }[] }).jobs) job.labels = small ? ['ubuntu-latest'] : ['self-hosted', 'big-box'];
    }
    const r = await report(routes);

    // 2 of the 5 sampled runs are sized, and about a tenth of the minutes.
    assert.ok(r.efficiency.sizedShare > 0 && r.efficiency.sizedShare < 0.15, String(r.efficiency.sizedShare));
    assert.match(r.evidence.reasons.join('; '), /the runners' sizes are known for \d% of job minutes/);
  });

  it('gives vCPU-minutes a day beside the minutes per merged PR', async () => {
    const { efficiency } = await report(fakeRepo({ repo: PUBLIC }));

    near(efficiency.prVcpuMinutesPerDay, 4 * efficiency.prJobMinutesPerDay);
  });

  const stretch = (routes: Routes, setupSeconds: number, jobSeconds: number) => {
    for (const [key, answer] of Object.entries(routes)) {
      if (!/\/attempts\/1\/jobs\?page=1$/.test(key)) continue;
      for (const job of (answer.json as { jobs: { started_at: string; completed_at: string; steps: { started_at: string; completed_at: string }[] }[] }).jobs) {
        const at = (seconds: number) => new Date(Date.parse(job.started_at) + seconds * 1e3).toISOString();
        // "Set up job" keeps its 15 seconds; the install step takes the rest of the setup.
        [job.steps[1]!.completed_at, job.steps[2]!.started_at, job.steps[2]!.completed_at, job.completed_at] = [at(setupSeconds), at(setupSeconds), at(jobSeconds), at(jobSeconds)];
      }
    }
    return routes;
  };
  const setupFix = (r: { fixes: { text: string }[] }) => r.fixes.find((fix) => /on setup/.test(fix.text))?.text;

  it('gives the setup fix over a minute a job, in minutes', async () => {
    const r = await report(stretch(fakeRepo({ repo: PUBLIC }), 120, 360));

    near(r.jobs.setupMinPerJob, 2);
    assert.equal(setupFix(r), 'Each job spends 2.0 minutes on setup: cache dependencies and build once');
  });

  it("gives no setup fix when over a minute is a sliver of a long job", async () => {
    const r = await report(stretch(fakeRepo({ repo: PUBLIC }), 90, 100 * 60));

    near(r.jobs.setupMinPerJob, 1.5);
    assert.ok(r.jobs.setupShare < 0.05, String(r.jobs.setupShare));
    assert.equal(setupFix(r), undefined);
  });

  it('means setup over the jobs that timed their steps, and leaves a run with none out of the median', async () => {
    const routes = stretch(fakeRepo({ repo: PUBLIC }), 120, 360);
    let n = 0;
    for (const [key, answer] of Object.entries(routes)) {
      if (!/\/attempts\/1\/jobs\?page=1$/.test(key)) continue;
      const { jobs } = answer.json as { jobs: { id: number; name: string; steps: unknown[] }[] };
      // Every third run timed no step at all; the others have a second job that timed none.
      if (n++ % 3 === 0) jobs[0]!.steps = [];
      else jobs.push({ ...jobs[0]!, id: jobs[0]!.id + 1, name: 'lint', steps: [] });
    }
    const r = await report(routes);

    near(r.jobs.setupMinPerJob, 2);
    assert.equal(setupFix(r), 'Each job spends 2.0 minutes on setup: cache dependencies and build once');
  });

  it('measures setup in minutes a job, so a fast job with little else to do scores full marks', async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    // Each job: 15 seconds to set up, 5 to install, 10 of tests. Setup is two thirds of it, and a third of a minute.
    for (const [key, answer] of Object.entries(routes)) {
      if (!/\/attempts\/1\/jobs\?page=1$/.test(key)) continue;
      for (const job of (answer.json as { jobs: { started_at: string; completed_at: string; steps: { started_at: string; completed_at: string }[] }[] }).jobs) {
        const at = (seconds: number) => new Date(Date.parse(job.started_at) + seconds * 1e3).toISOString();
        [job.steps[0]!.completed_at, job.steps[1]!.started_at, job.steps[1]!.completed_at, job.steps[2]!.started_at, job.steps[2]!.completed_at, job.completed_at] = [at(15), at(15), at(20), at(20), at(30), at(30)];
      }
    }
    const r = await report(routes);

    near(r.jobs.setupMinPerJob, 1 / 3);
    near(r.jobs.setupShare, 2 / 3);
    assert.equal(r.detail.efficiency.setup, 100);
    assert.ok(!r.fixes.some((fix: { text: string }) => /on setup/.test(fix.text)));
  });
});

describe('what the measures count', () => {
  type FakeRun = { id: number; name: string; path: string; head_sha: string; conclusion: string; run_attempt: number; created_at: string; updated_at: string };
  const prKey = `repos/${PUBLIC}/actions/runs?event=pull_request&page=1`;
  const prRunsOf = (routes: Routes) => routes[prKey]!.json as { total_count: number; workflow_runs: FakeRun[] };
  const report = async (routes: Routes, args: string[] = []) => {
    const r = await runCli(['--repo', PUBLIC, '--json', ...args], { routes });
    assert.equal(r.code, 0, r.stderr);
    return { ...r, report: json(r.stdout) };
  };

  it('takes a run that hit its time limit as red, and times its push', async () => {
    const plain = (await report(fakeRepo({ repo: PUBLIC }))).report.wait;
    const routes = fakeRepo({ repo: PUBLIC });
    for (const run of prRunsOf(routes).workflow_runs.filter((each) => /-sha-[267]$/.test(each.head_sha))) {
      run.conclusion = 'timed_out';
      run.updated_at = new Date(Date.parse(run.created_at) + 6 * 3600e3).toISOString();
    }
    const { wait } = (await report(routes)).report;

    assert.equal(wait.timed, plain.timed);
    assert.equal(Math.round(wait.redRate * wait.ranHeads), Math.round(plain.redRate * plain.ranHeads) + 3);
    assert.ok(wait.p90 >= 359, `p90 ${wait.p90} min`);
  });

  it('counts reruns it had no calls left to read at the rate of the ones it read', async () => {
    const routes = fakeRepo({ repo: PUBLIC, heads: 40 });
    const reruns = prRunsOf(routes).workflow_runs.slice(0, 30);
    for (const run of reruns) {
      run.conclusion = 'success';
      run.run_attempt = 2;
      routes[`repos/${PUBLIC}/actions/runs/${run.id}/attempts/1`] = { status: 200, json: { conclusion: 'failure' } };
    }
    const r = await report(routes);

    assert.equal(paths(r.calls).filter((path) => /\/attempts\/1$/.test(path)).length, 25);
    assert.equal(r.report.wait.rerunsUnread, 5);
    assert.equal(r.report.wait.passedOnRerunRate, 30 / 40);
  });

  it('leaves a push whose runs were all skipped out of what the rates are shares of', async () => {
    const plain = (await report(fakeRepo({ repo: PUBLIC }))).report.wait;
    const routes = fakeRepo({ repo: PUBLIC });
    for (const run of prRunsOf(routes).workflow_runs) if (/-sha-1\d$/.test(run.head_sha)) run.conclusion = 'skipped';
    const { wait } = (await report(routes)).report;

    assert.equal(wait.heads, 20);
    assert.equal(wait.ranHeads, 10);
    assert.equal(wait.redRate, (plain.redRate * plain.ranHeads) / 10);
  });

  it('spreads a burst of runs over the window it read, and over the runs it read when GitHub had more', async () => {
    const whole = (await report(fakeRepo({ repo: PUBLIC }))).report;

    assert.ok(whole.window.days >= 7 && whole.window.days <= 8, `${whole.window.days} days`);
    assert.ok(whole.headsPerWeek >= 17 && whole.headsPerWeek <= 20, `${whole.headsPerWeek} pushes a week`);

    const routes = fakeRepo({ repo: PUBLIC });
    prRunsOf(routes).total_count = 5000;
    const cut = (await report(routes)).report;

    assert.equal(cut.window.truncated, true);
    assert.ok(cut.window.days >= 2.4 && cut.window.days <= 2.5, `${cut.window.days} days`);
  });

  it('counts merged pull requests over the days it was asked to read', async () => {
    const week = (await report(fakeRepo({ repo: PUBLIC }))).report;
    const fortnight = await report(fakeRepo({ repo: PUBLIC }), ['--days', '14']);
    const since = new Date(Date.now() - 14 * 24 * 3600e3).toISOString().slice(0, 10);

    assert.ok(paths(fortnight.calls).some((path) => path.startsWith('search/issues') && decodeURIComponent(path).includes(`is:merged merged:>=${since}`)));
    assert.ok(week.profile.prsMergedPerWeek > 10.4 && week.profile.prsMergedPerWeek <= 12, `${week.profile.prsMergedPerWeek} a week`);
    assert.ok(fortnight.report.profile.prsMergedPerWeek > 5.5 && fortnight.report.profile.prsMergedPerWeek <= 6, `${fortnight.report.profile.prsMergedPerWeek} a week`);
  });

  it('leaves the minutes unknown, not zero, when no sampled run ran a job', async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    for (const key of Object.keys(routes)) if (/\/attempts\/1\/jobs\?page=1$/.test(key)) routes[key] = { status: 200, json: { total_count: 0, jobs: [] } };
    const { efficiency, detail } = (await report(routes)).report;

    assert.equal(efficiency.jobMinutesPerMergedPr, null);
    assert.equal(detail.efficiency.minutesPerPr, null);
  });

  it('tells two workflow files with one name apart', async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    for (const run of prRunsOf(routes).workflow_runs) if (/[02468]$/.test(run.head_sha)) run.path = '.github/workflows/ci-docs.yml';
    const { efficiency, wait } = (await report(routes)).report;

    assert.equal(efficiency.workflowsOnPrs, 2);
    assert.deepEqual(wait.heavyWorkflows, ['CI']);
  });

  it('samples the jobs of the workflow file that most often finishes last', async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    // Even pushes run one file and odd ones another, under one name. The odd file loses its rerun push, so the even one finishes last more often.
    for (const run of prRunsOf(routes).workflow_runs) if (/[02468]$/.test(run.head_sha)) run.path = '.github/workflows/ci-docs.yml';
    const even = new Set(prRunsOf(routes).workflow_runs.filter((run) => run.path.endsWith('ci-docs.yml')).map((run) => run.id));
    for (const [key, answer] of Object.entries(routes)) {
      const id = Number(key.match(/\/actions\/runs\/(\d+)\/attempts\/1\/jobs/)?.[1]);
      if (even.has(id)) for (const job of (answer.json as { jobs: { name: string }[] }).jobs) job.name = 'docs';
    }
    const { wait, jobs } = (await report(routes)).report;

    assert.equal(wait.lastWorkflow, '.github/workflows/ci-docs.yml');
    assert.equal(jobs.longest.name, 'docs');
  });

  it('takes a run that hit its time limit as red on the default branch, and counts its minutes', async () => {
    const plain = (await report(fakeRepo({ repo: PUBLIC }))).report;
    const routes = fakeRepo({ repo: PUBLIC });
    const pushes = routes[`repos/${PUBLIC}/actions/runs?event=push&branch=main&page=1`]!.json as { workflow_runs: FakeRun[] };
    for (const run of [...pushes.workflow_runs.slice(0, 2), ...prRunsOf(routes).workflow_runs.filter((each) => /-sha-1[0-4]$/.test(each.head_sha))]) run.conclusion = 'timed_out';
    const { main, efficiency } = (await report(routes)).report;

    assert.equal(plain.main.redRate, 0);
    assert.equal(main.redRate, 2 / 10);
    assert.equal(efficiency.jobMinutesPerMergedPr, plain.efficiency.jobMinutesPerMergedPr);
  });

  it("leaves the default branch's pushes whose runs were all skipped out of its red rate", async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    const pushes = routes[`repos/${PUBLIC}/actions/runs?event=push&branch=main&page=1`]!.json as { workflow_runs: FakeRun[] };
    pushes.workflow_runs[0]!.conclusion = 'failure';
    for (const run of pushes.workflow_runs.slice(5)) run.conclusion = 'skipped';
    const { main } = (await report(routes)).report;

    assert.equal(main.heads, 10);
    assert.equal(main.redRate, 1 / 5);
  });

  it("charges a workflow whose runs ran no job nothing, not the other workflows' minutes", async () => {
    const plain = (await report(fakeRepo({ repo: PUBLIC }))).report.efficiency;
    const routes = fakeRepo({ repo: PUBLIC });
    const runs = prRunsOf(routes);
    for (const run of [...runs.workflow_runs]) {
      const id = run.id + 5000;
      runs.workflow_runs.push({ ...run, id, name: 'Docs', path: '.github/workflows/docs.yml', conclusion: 'success', run_attempt: 1 });
      routes[`repos/${PUBLIC}/actions/runs/${id}/attempts/1/jobs?page=1`] = { status: 200, json: { total_count: 0, jobs: [] } };
    }
    runs.total_count = runs.workflow_runs.length;
    const { efficiency } = (await report(routes)).report;

    assert.equal(efficiency.workflowsOnPrs, 2);
    assert.equal(efficiency.jobMinutesPerMergedPr, plain.jobMinutesPerMergedPr);
    assert.equal(efficiency.prBilledMinutesPerDay, plain.prBilledMinutesPerDay);
  });

  it('works minutes per merged PR out from the count of merged PRs, not from the rounded weekly rate', async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    (routes['search/issues?merged']!.json as { total_count: number }).total_count = 1;
    const { efficiency, window, profile } = (await report(routes, ['--days', '90'])).report;

    assert.equal(profile.prsMergedPerWeek, 0.1);
    const whole = efficiency.prJobMinutesPerDay * window.days;
    assert.ok(Math.abs(efficiency.jobMinutesPerMergedPr - whole) <= 0.03 * whole, `${efficiency.jobMinutesPerMergedPr} per merged PR, with 1 merged and ${whole} job-minutes in the window`);
  });

  it('counts pull_request_target runs over the same days as the pull_request runs it read', async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    // GitHub holds more PR runs than were read, so the window is the 2.4 days the 20 read cover. The target runs span a week.
    prRunsOf(routes).total_count = 5000;
    const targets = Array.from({ length: 20 }, (_, i) => {
      const created = Date.now() - 3600e3 - i * 8 * 3600e3;
      return { ...prRunsOf(routes).workflow_runs[0]!, id: 9000 + i, name: 'Gate', path: '.github/workflows/gate.yml', event: 'pull_request_target', head_sha: `target-sha-${i}`, conclusion: 'success', run_attempt: 1, created_at: new Date(created).toISOString(), run_started_at: new Date(created + 5e3).toISOString(), updated_at: new Date(created + 60e3).toISOString() };
    });
    routes[`repos/${PUBLIC}/actions/runs?event=pull_request_target&page=1`] = { status: 200, json: { total_count: 20, workflow_runs: targets } };
    for (const run of targets) routes[`repos/${PUBLIC}/actions/runs/${run.id}/attempts/1/jobs?page=1`] = { status: 200, json: { total_count: 0, jobs: [] } };
    const { profile, window } = (await report(routes)).report;

    assert.ok(window.days >= 2.4 && window.days <= 2.5, `${window.days} days`);
    // 20 PR runs and the 8 target runs inside those days, not all 20 of them.
    assert.ok(profile.prRunsPerDay >= 11 && profile.prRunsPerDay <= 12, `${profile.prRunsPerDay} runs a day`);
  });

  it('names the shard group that is slowest in the most sampled runs, not in the newest alone', async () => {
    const routes = fakeRepo({ repo: PUBLIC });
    const newest = prRunsOf(routes).workflow_runs[0]!.id;
    for (const [key, answer] of Object.entries(routes)) {
      const id = Number(key.match(/\/actions\/runs\/(\d+)\/attempts\/1\/jobs/)?.[1]);
      if (!id) continue;
      const [first] = (answer.json as { jobs: { id: number; created_at: string; started_at: string }[] }).jobs;
      if (!first) continue;
      // In the newest run "unit" is the slow group; in every other run "e2e" is.
      const minutes = id === newest ? { 'unit 1/2': 10, 'unit 2/2': 12, 'e2e 1/3': 3, 'e2e 2/3': 4, 'e2e 3/3': 5 } : { 'unit 1/2': 2, 'unit 2/2': 3, 'e2e 1/3': 6, 'e2e 2/3': 8, 'e2e 3/3': 9 };
      (answer.json as { jobs: unknown[] }).jobs = Object.entries(minutes).map(([name, m], i) => ({ ...first, id: first.id + i, name, conclusion: 'success', completed_at: new Date(Date.parse(first.started_at) + m * 60e3).toISOString(), steps: [] }));
    }
    const { jobs } = (await report(routes)).report;

    assert.equal(jobs.shard.name, 'e2e #');
    assert.equal(jobs.shard.shards, 3);
  });
});
