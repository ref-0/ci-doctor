// Canned GitHub answers for one made-up repo, keyed as the gh stub keys them.
export type Answer = { status: number; json?: unknown; raw?: string; text?: string; message?: string };
export type Routes = Record<string, Answer>;

const ok = (json: unknown): Answer => ({ status: 200, json });
const file = (raw: string): Answer => ({ status: 200, raw });
const iso = (ms: number) => new Date(ms).toISOString();

export const WORKFLOW = `name: CI
on:
  pull_request:
  push:
    branches: [main]
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm vitest run
`;

export const PACKAGE_JSON = JSON.stringify({ name: 'app', devDependencies: { vitest: '4.0.0', eslint: '9.0.0' } }, null, 2);

/** A line the scorer reads test timings from, in a log it must never keep. */
export const LOG_LINE = '2026-11-19T10:00:00.0000000Z  ✓ src/secret-path/slow.test.ts (3 tests) 12500ms';

export interface RepoShape {
  repo: string;
  private?: boolean;
  /** PR heads in the window; under 5 leaves it unscored. */
  heads?: number;
  truncated?: boolean;
  workflows?: number;
}

export const fakeRepo = ({ repo, private: isPrivate = false, heads = 20, truncated = false, workflows = 1 }: RepoShape): Routes => {
  const now = Date.now();
  const routes: Routes = {};
  let id = 1000;
  const runsOf = (event: string, branch: (i: number) => string, count: number, offsetMs: number) => {
    const runs = [];
    for (let i = 0; i < count; i++) {
      const created = now - offsetMs - i * 3 * 3600e3;
      const minutes = 4 + (i % 5);
      const runId = id++;
      // Head 3 failed; head 5 went green only on a rerun.
      const conclusion = event === 'pull_request' && i === 3 ? 'failure' : 'success';
      const attempt = event === 'pull_request' && i === 5 ? 2 : 1;
      runs.push({
        id: runId,
        name: 'CI',
        path: '.github/workflows/ci.yml',
        event,
        head_sha: `${event}-sha-${i}`,
        head_branch: branch(i),
        status: 'completed',
        conclusion,
        run_attempt: attempt,
        created_at: iso(created),
        updated_at: iso(created + minutes * 60e3),
        run_started_at: iso(created + 5e3),
        actor: { login: 'pip' },
      });
      if (attempt === 2) routes[`repos/${repo}/actions/runs/${runId}/attempts/1`] = ok({ conclusion: 'failure' });
      const jobId = runId * 10;
      routes[`repos/${repo}/actions/runs/${runId}/attempts/1/jobs?page=1`] = ok({
        jobs: [
          {
            id: jobId,
            name: 'test',
            conclusion,
            created_at: iso(created + 5e3),
            started_at: iso(created + 15e3),
            completed_at: iso(created + minutes * 60e3),
            labels: ['ubuntu-latest'],
            steps: [
              { name: 'Set up job', started_at: iso(created + 15e3), completed_at: iso(created + 30e3), conclusion: 'success' },
              { name: 'Run pnpm install --frozen-lockfile', started_at: iso(created + 30e3), completed_at: iso(created + 60e3), conclusion: 'success' },
              { name: 'Run pnpm vitest run', started_at: iso(created + 60e3), completed_at: iso(created + minutes * 60e3), conclusion },
            ],
          },
        ],
      });
      routes[`repos/${repo}/actions/jobs/${jobId}/logs`] = { status: 200, text: `${LOG_LINE}\n` };
    }
    return { total_count: runs.length, workflow_runs: runs };
  };

  routes[`repos/${repo}`] = ok({
    full_name: repo,
    private: isPrivate,
    default_branch: 'main',
    created_at: iso(now - 3 * 365 * 24 * 3600e3),
    stargazers_count: 120,
    forks_count: 8,
  });
  routes[`repos/${repo}/actions/runs?event=pull_request&page=1`] = ok(runsOf('pull_request', (i) => `feature-${i}`, heads, 3600e3));
  routes[`repos/${repo}/actions/runs?event=pull_request_target&page=1`] = ok({ total_count: 0, workflow_runs: [] });
  routes[`repos/${repo}/actions/runs?event=push&branch=main&page=1`] = ok(runsOf('push', () => 'main', Math.min(heads, 10), 1800e3));

  const workflowPaths = Array.from({ length: workflows }, (_, i) => (i === 0 ? '.github/workflows/ci.yml' : `.github/workflows/extra-${i}.yml`));
  const blobs = [
    ...workflowPaths.map((path) => ({ path, type: 'blob', size: 400 })),
    { path: 'package.json', type: 'blob', size: 120 },
    { path: 'pnpm-lock.yaml', type: 'blob', size: 9000 },
    { path: 'src/index.ts', type: 'blob', size: 300_000 },
    { path: 'src/index.test.ts', type: 'blob', size: 90_000 },
  ];
  routes[`repos/${repo}/git/trees/main`] = ok({ tree: blobs, truncated });
  for (const path of workflowPaths) routes[`repos/${repo}/contents/${path}?ref=main`] = file(path.endsWith('ci.yml') ? WORKFLOW : 'name: Extra\non: workflow_dispatch\n');
  routes[`repos/${repo}/contents/package.json?ref=main`] = file(PACKAGE_JSON);

  routes[`repos/${repo}/languages`] = ok({ TypeScript: 390_000, JavaScript: 10_000 });
  routes[`repos/${repo}/commits?page=1`] = ok(Array.from({ length: 30 }, (_, i) => ({ author: { login: i % 2 ? 'pip' : 'mo' } })));
  routes[`repos/${repo}/stats/participation`] = ok({ all: Array.from({ length: 52 }, () => 7) });
  routes['search/issues?merged'] = ok({
    total_count: 12,
    items: Array.from({ length: 12 }, (_, i) => ({
      user: { login: 'mo', type: 'User' },
      created_at: iso(now - (i + 2) * 3600e3),
      pull_request: { merged_at: iso(now - i * 3600e3) },
    })),
  });
  routes['search/issues?opened'] = ok({ total_count: 15, items: [] });
  routes.user = ok({ login: 'pip' });
  return routes;
};
