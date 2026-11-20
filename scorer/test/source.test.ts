// Where files come from: GitHub's batches, read in-process against the gh stub, and a checkout on disk.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Gh } from '../src/gh.ts';
import { githubSource } from '../src/source.ts';
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
      const texts = source.readMany(source.tree.blobs.map((b) => b.path));

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
