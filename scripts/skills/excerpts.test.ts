/**
 * Tests for excerpts.ts: a section ends at the next heading of its level, links follow the
 * excerpt, and the committed excerpts match their sources.
 *
 * Runs: `node --test excerpts.test.ts` from this folder (Node 24).
 */
import { deepStrictEqual, equal, match, throws } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { relink, section, stale } from './excerpts.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('excerpts', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'excerpts-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, 'docs'), { recursive: true });
  writeFileSync(
    join(tmp, 'docs', 'page.md'),
    '# Page\n\n## One\n\nText [two](#two) and [other](other.md#x).\n\n### Deeper\n\n```md\n## Not a heading\n```\n\n## Two\n\nLast.\n',
  );

  it('takes a heading and everything under it, up to the next heading of its level', () => {
    const { block } = section(tmp, 'docs/page.md', 'One');
    match(block, /^### One/);
    match(block, /#### Deeper/);
    match(block, /## Not a heading/);
    equal(block.includes('Last.'), false);
  });

  it('refuses a heading the source no longer has', () => {
    throws(() => section(tmp, 'docs/page.md', 'Three'), /no heading "Three"/);
  });

  it('points links at the same files from the excerpt, and a bare anchor at its source', () => {
    const text = relink('[two](#two) [other](other.md#x) [web](https://example.com) `[code](x.md)`', 'docs/page.md', 'skills/hub/references/excerpts/p.md');
    deepStrictEqual(text, '[two](../../../../docs/page.md#two) [other](../../../../docs/other.md#x) [web](https://example.com) `[code](x.md)`');
  });

  it('finds every committed excerpt up to date with its sources', () => {
    deepStrictEqual(stale(repo), []);
  });
});
