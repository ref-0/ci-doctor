// Where files come from: GitHub's batches, read in-process against the gh stub, and a checkout on disk.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { Gh } from '../src/gh.ts';
import { githubSource, localSource } from '../src/source.ts';
import { blobSha, type Routes } from './fixtures.ts';
import { withStub } from './helpers.ts';

const REPO = 'pip/app';

/** A tree of `n` package manifests at `ref`, each file's raw answer served there. */
const manifests = (n: number, ref = 'main'): Routes => {
  const paths = Array.from({ length: n }, (_, i) => `packages/p${i}/package.json`);
  const routes: Routes = { [`repos/${REPO}/git/trees/${ref}`]: { status: 200, json: { tree: paths.map((path) => ({ path, type: 'blob', size: 20, sha: blobSha(path) })) } } };
  for (const p of paths) routes[`repos/${REPO}/contents/${p}?ref=${ref}`] = { status: 200, raw: `{"name":"${p}"}` };
  return routes;
};

describe('reading files in batches', () => {
  it('reads every batch by the blob ids of the one tree it listed, never by the branch, which can move between batches', () => {
    withStub(manifests(150), {}, (log) => {
      const source = githubSource(new Gh(), REPO, 'main');
      const { texts, failed } = source.readMany(source.tree.blobs.map((b) => b.path));
      assert.equal(failed.size, 0);

      assert.equal(texts.size, 150);
      assert.equal(texts.get('packages/p7/package.json'), '{"name":"packages/p7/package.json"}');
      const queries = log().filter((c) => c.includes('graphql')).map((c) => c.at(-1)!);
      assert.equal(queries.length, 2);
      for (const q of queries) assert.doesNotMatch(q, /expression|main:/);
      const ids = queries.map((q) => [...q.matchAll(/object\(oid: \\"([0-9a-f]{40})\\"\)/g)].map((m) => m[1]));
      assert.deepEqual(ids.map((x) => x.length), [100, 50]);
      assert.deepEqual(ids.flat(), source.tree.blobs.map((b) => b.sha));
    });
  });
});

describe('a read that fails costs those files alone', () => {
  const two = (): Routes => {
    const paths = ['a/package.json', 'b/package.json'];
    return { [`repos/${REPO}/git/trees/main`]: { status: 200, json: { tree: paths.map((path) => ({ path, type: 'blob', size: 20, sha: blobSha(path) })) } } };
  };

  it('keeps what a partial GraphQL answer read, says why the rest failed, and asks once', () => {
    const graphql = {
      status: 200,
      json: { data: { repository: { f0: { isTruncated: false, text: '{"name":"a"}' }, f1: null } }, errors: [{ type: 'FORBIDDEN', path: ['repository', 'f1'], message: 'Resource not accessible by integration.' }] },
    };
    withStub({ ...two(), graphql }, {}, (log) => {
      const source = githubSource(new Gh(), REPO, 'main');
      const { texts, failed } = source.readMany(['a/package.json', 'b/package.json']);

      assert.deepEqual([...texts], [['a/package.json', '{"name":"a"}']]);
      assert.deepEqual([...failed], [['b/package.json', 'GitHub answered: Resource not accessible by integration']]);
      assert.equal(log().filter((c) => c.includes('graphql')).length, 1);
    });
  });

  it("marks a whole batch failed with GitHub's reason, rather than stopping the report", () => {
    const graphql = { status: 200, json: { data: null, errors: [{ message: 'Something went wrong while executing your query.' }] } };
    withStub({ ...two(), graphql }, {}, () => {
      const { texts, failed } = githubSource(new Gh(), REPO, 'main').readMany(['a/package.json', 'b/package.json']);

      assert.equal(texts.size, 0);
      assert.deepEqual([...failed.keys()], ['a/package.json', 'b/package.json']);
      assert.match(failed.get('a/package.json')!, /Something went wrong while executing your query/);
    });
  });

  it("marks a checkout's unreadable file failed with the reason, and reads the rest", { skip: (process.platform === 'win32' && "Windows reads a file chmod 000 leaves") || (process.getuid?.() === 0 && 'root reads every file') }, () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-doctor-source-'));
    writeFileSync(join(root, 'a.json'), '{}');
    writeFileSync(join(root, 'b.json'), '{}');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    chmodSync(join(root, 'b.json'), 0o000);

    const { texts, failed } = localSource(root).readMany(['a.json', 'b.json']);
    chmodSync(join(root, 'b.json'), 0o600);

    assert.deepEqual([...texts.keys()], ['a.json']);
    assert.match(failed.get('b.json')!, /EACCES/);
  });
});
