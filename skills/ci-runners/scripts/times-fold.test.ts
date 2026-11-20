/**
 * times-fold.test.ts: tests for the fold of new files' times between sweeps: counting merges, when a
 * fold is due, which artifacts it trusts, and `main` against a fake GitHub. No network.
 * Run with `node --test times-fold.test.ts`.
 */
import { deepStrictEqual, match, strictEqual } from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type Artifact, artifactBytes, firstParents, type Io, isDue, main, refused, type WorkflowRun } from './times-fold.ts';

const repo = 'o/r';
const workflow = '.github/workflows/ci.yml';

/** A compare of `base...head` over main's first-parent chain m1..m3, m2 a merge of a branch of b1..b10. */
const compare = {
  status: 'ahead',
  total_commits: 13,
  commits: [
    ...Array.from({ length: 10 }, (_, at) => ({ sha: `b${at + 1}`, parents: [{ sha: at === 0 ? 'base' : `b${at}` }] })),
    { sha: 'm1', parents: [{ sha: 'base' }] },
    { sha: 'm2', parents: [{ sha: 'm1' }, { sha: 'b10' }] },
    { sha: 'm3', parents: [{ sha: 'm2' }] },
  ],
};

describe('counting merges', () => {
  test('counts first-parent commits, so a merged branch of ten commits is one merge', () => {
    deepStrictEqual(firstParents(compare, 'base', 'm3'), ['m3', 'm2', 'm1']);
  });

  test('is due at enough merges or hours since the last fold, never behind or while a sweep runs', () => {
    const wants = { merges: 10, hours: 24 };
    strictEqual(isDue({ status: 'ahead', merges: 3, hours: 2, sweeping: false }, wants).due, false);
    strictEqual(isDue({ status: 'ahead', merges: 10, hours: 2, sweeping: false }, wants).due, true);
    strictEqual(isDue({ status: 'ahead', merges: 1, hours: 25, sweeping: false }, wants).due, true);
    strictEqual(isDue({ status: 'ahead', merges: 50, hours: 50, sweeping: true }, wants).due, false);
    strictEqual(isDue({ status: 'behind', merges: 50, hours: 50, sweeping: false }, wants).due, false);
  });
});

describe('which artifacts it trusts', () => {
  const head = 'h1';
  const artifact: Artifact = {
    id: 1,
    name: `test-times-${head}`,
    size_in_bytes: 1_000,
    expired: false,
    created_at: '2026-11-20T00:00:00Z',
    archive_download_url: 'https://x/1/zip',
    workflow_run: { id: 7, head_sha: head, repository_id: 9 },
  };
  const run: WorkflowRun = { id: 7, path: workflow, event: 'pull_request', head_sha: head, repository: { id: 9, full_name: repo } };
  const at = { repo, workflow, head };

  test("trusts this repo's CI run of the merged head", () => {
    strictEqual(refused(artifact, run, at), undefined);
    strictEqual(refused(artifact, { ...run, event: 'merge_group' }, at), undefined);
  });

  test('refuses another workflow, event, commit or repo, an expired or too big archive', () => {
    deepStrictEqual(
      [
        refused(artifact, { ...run, path: '.github/workflows/other.yml' }, at),
        refused(artifact, { ...run, event: 'push' }, at),
        refused(artifact, { ...run, head_sha: 'h2' }, at),
        refused({ ...artifact, workflow_run: { ...artifact.workflow_run, head_sha: 'h2' } }, run, at),
        refused(artifact, { ...run, repository: { id: 10, full_name: 'fork/r' } }, at),
        refused({ ...artifact, expired: true }, run, at),
        refused({ ...artifact, size_in_bytes: artifactBytes + 1 }, run, at),
        refused(artifact, undefined, at),
      ],
      ['from another workflow', 'from a push run', 'from another commit', 'from another commit', 'from another repo', 'expired', 'too big', 'no run'],
    );
  });
});

describe('main, with a fake GitHub', () => {
  const times = (files: Record<string, number>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: 1,
      ...extra,
      projects: { workspace: { files: Object.fromEntries(Object.entries(files).map(([path, ms]) => [path, { duration: ms, lastRun: 1, samples: [[1, ms]] }])) } },
    });
  const fake = (over: { stored?: string; runs?: ReadonlyArray<object>; artifacts?: Record<string, ReadonlyArray<Artifact>>; runOf?: Record<number, WorkflowRun>; zips?: Record<string, string> }) => {
    const written: Record<string, string> = {};
    const logged = new Array<string>();
    const io: Io = {
      api: (path) => {
        if (path.startsWith(`repos/${repo}/compare/`)) return JSON.stringify(compare);
        if (path.includes('/actions/workflows/')) return JSON.stringify({ workflow_runs: over.runs ?? [] });
        const pulls = /commits\/(\w+)\/pulls/.exec(path);
        if (pulls) return JSON.stringify(pulls[1] === 'm2' ? [{ merged_at: 'x', merge_commit_sha: 'm2', head: { sha: 'b10' } }, { merged_at: null, merge_commit_sha: null, head: { sha: 'open' } }] : []);
        const named = /artifacts\?name=test-times-(\w+)/.exec(path);
        if (named) return JSON.stringify({ artifacts: over.artifacts?.[named[1] ?? ''] ?? [] });
        const run = /actions\/runs\/(\d+)$/.exec(path);
        if (run) return JSON.stringify(over.runOf?.[Number(run[1])]);
        throw new Error(`unexpected api ${path}`);
      },
      download: (url) => Buffer.from(url),
      unzip: (archive) => {
        const text = over.zips?.[archive.toString()];
        if (text === undefined) throw new Error('no run-times.json');
        return text;
      },
      files: () => ['a.test.ts', 'new.test.ts', 'poison.test.ts'],
      read: (path) => (path === 'stored.json' ? over.stored : undefined),
      write: (path, text) => {
        written[path] = text;
      },
      log: (line) => logged.push(line),
      now: () => 100 * 3_600_000,
      env: { GITHUB_REPOSITORY: repo, GITHUB_REF_NAME: 'main', GITHUB_WORKFLOW_REF: `${repo}/${workflow}@refs/heads/main` },
    };
    return { io, written, logged };
  };

  test('due counts merges since through, and waits out a running sweep', () => {
    const stored = times({ 'a.test.ts': 5 }, { through: 'base', foldedAt: 99 * 3_600_000 });
    const quiet = fake({ stored });
    strictEqual(main(['due', 'stored.json', '--sha', 'm3', '--merges', '3'], quiet.io), 0);
    strictEqual(quiet.written['-'], 'due=true\n');

    const few = fake({ stored });
    main(['due', 'stored.json', '--sha', 'm3', '--merges', '4'], few.io);
    strictEqual(few.written['-'], 'due=false\n');

    const sweeping = fake({ stored, runs: [{ status: 'in_progress', display_title: 'CI on main, daily' }] });
    main(['due', 'stored.json', '--sha', 'm3', '--merges', '1'], sweeping.io);
    strictEqual(sweeping.written['-'], 'due=false\n');
  });

  test("folds only a trusted run's new files, held to the checkout and the bounds", () => {
    const stored = times({ 'a.test.ts': 5 }, { through: 'base' });
    const good: Artifact = {
      id: 1, name: 'test-times-b10', size_in_bytes: 10, expired: false, created_at: '2026-11-20T00:00:00Z',
      archive_download_url: 'good', workflow_run: { id: 7, head_sha: 'b10', repository_id: 9 },
    };
    const forged: Artifact = { ...good, id: 2, archive_download_url: 'forged', created_at: '2026-11-21T00:00:00Z', workflow_run: { id: 8, head_sha: 'b10', repository_id: 9 } };
    const run = (id: number, path: string): WorkflowRun => ({ id, path, event: 'pull_request', head_sha: 'b10', repository: { id: 9, full_name: repo } });
    const pr = times({ 'a.test.ts': 500, 'new.test.ts': 7_000, 'gone.test.ts': 1 });
    const poison = JSON.stringify({ version: 1, projects: { w: { files: { 'poison.test.ts': { samples: [[1e307, 1e308], [1e307, 1e308], [1e307, 1e308]] } } } } });
    const { io, written, logged } = fake({
      stored,
      artifacts: { b10: [good, forged] },
      runOf: { 7: run(7, workflow), 8: run(8, '.github/workflows/upload.yml') },
      zips: { good: pr, forged: poison },
    });

    strictEqual(main(['fold', 'stored.json', '--sha', 'm3', '--out', 'out.json'], io), 0);
    const out = JSON.parse(written['out.json'] ?? '{}');
    deepStrictEqual(Object.keys(out.projects.workspace.files).sort(), ['a.test.ts', 'new.test.ts']);
    strictEqual(out.projects.workspace.files['a.test.ts'].duration, 5);
    deepStrictEqual([out.through, out.foldedAt], ['m3', 100 * 3_600_000]);
    match(logged.join('\n'), /Refused: 1 from another workflow/);
  });

  test('writes nothing when this merge is behind the stored times', () => {
    const { io, written } = fake({ stored: times({}, { through: 'base' }) });
    const behind = { ...io, api: (path: string) => (path.includes('/compare/') ? JSON.stringify({ ...compare, status: 'behind' }) : io.api(path)) };
    strictEqual(main(['fold', 'stored.json', '--sha', 'm1', '--out', 'out.json'], behind), 0);
    strictEqual(written['out.json'], undefined);
  });
});
