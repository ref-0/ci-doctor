/**
 * near-tests.test.ts: how `localTests` picks the tests near a change. `node --test near-tests.test.ts`
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { areaOf, localTests, type Read } from './near-tests.ts';

const repo = new Map([
  ['packages/core/src/queue.ts', "export const queue = 1;\n"],
  ['packages/core/src/queue.test.ts', "import { queue } from './queue.ts';\n"],
  ['packages/core/src/queue-searches.test.ts', "import { other } from './other.ts';\n"],
  ['packages/core/src/window.ts', "import { queue } from './queue.ts';\n"],
  ['packages/core/src/window.test.ts', "import { window } from './window.ts';\n"],
  ['packages/core/src/reads.test.ts', "import { queue } from './queue';\n"],
  ['packages/core/src/other.ts', 'export const other = 1;\n'],
  ['packages/core/src/other.test.ts', "import { other } from './other.ts';\n"],
  ['packages/core/src/testing/harness.ts', "import { window } from '../window.ts';\n"],
  ['packages/core/src/harness.test.ts', "import { h } from './testing/harness.ts';\n"],
  ['packages/core/src/big.sandbox.test.ts', "import { queue } from './queue.ts';\n"],
  ['packages/web/vite.config.ts', 'export default {};\n'],
  ['packages/web/src/page.test.ts', "import { x } from 'react';\n"],
]);
const tracked = new Set(repo.keys());
const read: Read = (paths) =>
  new Map(paths.flatMap((path) => (repo.has(path) ? [[path, repo.get(path) ?? '']] : [])));

test('a module picks the tests named for it, its importers, and those importing it', () => {
  const near = localTests(['packages/core/src/queue.ts'], read, tracked);

  assert.deepEqual(near.changed, []);
  // `window.ts` imports `queue.ts`, so its own test counts as named too. The harness only tests
  // run is never climbed, so `harness.test.ts` stays out.
  assert.deepEqual(near.named, [
    'packages/core/src/queue-searches.test.ts',
    'packages/core/src/queue.test.ts',
    'packages/core/src/window.test.ts',
  ]);
  assert.deepEqual(near.importing, ['packages/core/src/reads.test.ts']);
  assert.deepEqual(near.reaching, []);
});

test('a config reaches the tests under its folder, and a root config every test', () => {
  assert.deepEqual(localTests(['packages/web/vite.config.ts'], read, tracked).reaching, [
    'packages/web/src/page.test.ts',
  ]);

  const every = localTests(['pnpm-lock.yaml'], read, tracked);
  // Every ordinary test, never a container's.
  assert.equal(every.reaching.length, 7);
  assert.ok(!every.reaching.includes('packages/core/src/big.sandbox.test.ts'));
});

test("a path's area is its package, or its top folder", () => {
  assert.equal(areaOf('packages/core/src/queue.ts'), 'packages/core/');
  assert.equal(areaOf('scripts/check.ts'), 'scripts/');
});
