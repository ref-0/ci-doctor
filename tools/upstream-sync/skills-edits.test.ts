/**
 * Tests for skills-edits.ts: renames, left-out rows, restored descriptions, and that a second run
 * changes nothing, on a throwaway folder.
 *
 * Runs: anywhere, with `node --test skills-edits.test.ts` (Node 24). No network, no git.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { type Adaptations, applyEdits, renames, rewrite, withDescription } from './skills-edits.ts';

const edits: Adaptations = { skillsDir: 'skills', ours: ['v-workers'], leftOut: ['v-legacy'], keepsUpstreamNames: ['skill-feedback.md'], edited: [] };

describe('rewrite', () => {
  const names = new Map([
    ['workers', 'v-workers'],
    ['durable-objects', 'v-durable-objects'],
  ]);

  it('renames backticked names and link paths always, bare names only when hyphenated', () => {
    const text = 'Use `workers`, see [it](../workers/SKILL.md), the workers CLI, and durable-objects.\n';
    strictEqual(rewrite(text, names, []), 'Use `v-workers`, see [it](../v-workers/SKILL.md), the workers CLI, and v-durable-objects.\n');
  });

  it('deletes rows naming a left-out skill', () => {
    strictEqual(rewrite('| a | keep |\n| v-legacy | drop |\n', new Map(), ['v-legacy']), '| a | keep |\n');
  });

  it('reads renames by source from the lock', () => {
    const lock = { skills: { 'v-workers': { source: 'v/skills', skillName: 'workers' }, same: { source: 'v/skills', skillName: 'same' }, plain: { source: 'o/x' } } };
    deepStrictEqual([...(renames(lock).get('v/skills') ?? [])], [['workers', 'v-workers']]);
  });

  it('restores a folded description from the saved copy', () => {
    const upstream = '---\nname: a\ndescription: >-\n  a long upstream\n  description\n---\nbody\n';
    const saved = '---\nname: a\ndescription: "short, ours"\n---\nold body\n';
    strictEqual(withDescription(upstream, saved), '---\nname: a\ndescription: "short, ours"\n---\nbody\n');
  });
});

describe('applyEdits', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-edits-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(join(root, 'skills-lock.json'), JSON.stringify({ skills: { 'v-workers': { source: 'v/skills', skillName: 'workers' }, 'v-kv': { source: 'v/skills', skillName: 'kv' } } }));
  mkdirSync(join(root, 'skills/v-workers/references'), { recursive: true });
  mkdirSync(join(root, 'skills/v-kv'), { recursive: true });
  writeFileSync(join(root, 'skills/v-workers/SKILL.md'), '---\nname: v-workers\ndescription: upstream says much more\n---\nPair with `kv`.\n');
  writeFileSync(join(root, 'skills/v-workers/references/skill-feedback.md'), 'File issues about `kv` upstream.\n');
  writeFileSync(join(root, 'skills/v-kv/SKILL.md'), '---\nname: v-kv\ndescription: kv\n---\n| `workers` | x |\n| v-legacy | y |\n');

  const saved = (path: string) => (path.endsWith('v-workers/SKILL.md') ? '---\nname: v-workers\ndescription: ours\n---\n' : undefined);

  it('reapplies every edit once', () => {
    const changed = applyEdits(root, edits, saved).sort();
    deepStrictEqual(changed, ['skills/v-kv/SKILL.md', 'skills/v-workers/SKILL.md']);
    strictEqual(readFileSync(join(root, 'skills/v-workers/SKILL.md'), 'utf8'), '---\nname: v-workers\ndescription: ours\n---\nPair with `v-kv`.\n');
    strictEqual(readFileSync(join(root, 'skills/v-kv/SKILL.md'), 'utf8'), '---\nname: v-kv\ndescription: kv\n---\n| `v-workers` | x |\n');
    ok(readFileSync(join(root, 'skills/v-workers/references/skill-feedback.md'), 'utf8').includes('`kv`'));
  });

  it('changes nothing the second time', () => {
    deepStrictEqual(applyEdits(root, edits, saved), []);
  });
});
