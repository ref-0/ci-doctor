/**
 * Tests for test-groups.ts' grouping: a covered-only file never shares a group, so a plan that
 * leaves it out can't run it through another file's group.
 * Runs: `node --test scripts/shards/test-groups.test.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupsOf, groupsWith, isCoveredOnly, type Grouping } from './test-groups.ts';

const eight: Grouping = { size: () => 8, workers: 1 };

test('a covered-only file is a group alone, and the rest of its folder still groups', () => {
  const files = ['pkg/src/a.test.ts', 'pkg/src/b.test.ts', 'pkg/src/oracle.test.ts', 'pkg/src/c.test.ts'];

  const groups = groupsOf(files, eight, ['pkg/src/oracle.test.ts']).map(({ files }) => files);

  assert.deepEqual(groups, [['pkg/src/a.test.ts', 'pkg/src/b.test.ts', 'pkg/src/c.test.ts'], ['pkg/src/oracle.test.ts']]);
});

test('a plan that leaves a covered-only file out runs no group holding it', () => {
  const files = ['pkg/src/a.test.ts', 'pkg/src/oracle.test.ts'];
  const groups = groupsOf(files, eight, ['pkg/src/oracle.test.ts']);

  const ran = groupsWith(groups, ['pkg/src/a.test.ts']).flatMap(({ files }) => files);

  assert.deepEqual(ran, ['pkg/src/a.test.ts']);
});

test('each file under a covered-only folder is a group alone', () => {
  const files = ['pkg/verification/one.test.ts', 'pkg/verification/two.test.ts'];

  const groups = groupsOf(files, eight, ['pkg/verification/']).map(({ files }) => files);

  assert.deepEqual(groups, [['pkg/verification/one.test.ts'], ['pkg/verification/two.test.ts']]);
  assert.equal(isCoveredOnly('pkg/verification/one.test.ts', ['pkg/verification/']), true);
  assert.equal(isCoveredOnly('pkg/verificationx/one.test.ts', ['pkg/verification/']), false);
});
