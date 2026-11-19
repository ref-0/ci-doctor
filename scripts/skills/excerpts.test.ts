/**
 * Tests for excerpts.ts: a section ends at the next heading of its level, an item at its last
 * nested line, the techniques index carries each heading's applies-when line, links follow the
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

import { item, relink, render, section, stale } from './excerpts.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('excerpts', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'excerpts-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, 'docs'), { recursive: true });
  writeFileSync(
    join(tmp, 'docs', 'page.md'),
    '# Page\n\n## One\n\nText [two](#two) and [other](other.md#x).\n\n### Deeper\n\n```md\n## Not a heading\n```\n\n- **Trust:**\n  - Nested.\n- **Next.** Not it.\n\n## Two\n\nLast.\n',
  );
  mkdirSync(join(tmp, 'skills/ci-doctor/references/phases'), { recursive: true });
  writeFileSync(join(tmp, 'skills/ci-doctor/references/phases/phase-1-map.md'), '# Phase 1\n');
  const guide = (name: string, text: string) => {
    mkdirSync(join(tmp, 'docs/pages'), { recursive: true });
    writeFileSync(join(tmp, 'docs/pages', name), text);
  };
  const techniques = () => render(tmp, { phase: 1, title: 'T', parts: [{ index: ['docs/pages/02-'], why: 'Why.' }] });

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

  it('takes one list item by its bold label, with its nested lines, under a heading of the label', () => {
    equal(item(tmp, 'docs/page.md', 'Trust'), '### Trust\n\n- **Trust:**\n  - Nested.');
    throws(() => item(tmp, 'docs/page.md', 'Missing'), /0 items labelled "Missing"/);
  });

  it("lists each H2 with the applies-when line under it, and the title's when it has one", () => {
    guide('02-a.md', '# 2. A\n\n**Applies when:** Top. **Skip when:** Never.\n\n## One\n\n**Applies when:** X. **Skip when:** Y.\n\nBody.\n');
    const text = techniques();
    match(text, /- \*\*\[2\. A\]\(\.\.\/\.\.\/\.\.\/\.\.\/docs\/pages\/02-a\.md\)\*\*: \*\*Applies when:\*\* Top\. \*\*Skip when:\*\* Never\./);
    match(text, /\n {2}- \[One\]\(\.\.\/\.\.\/\.\.\/\.\.\/docs\/pages\/02-a\.md#one\): \*\*Applies when:\*\* X\. \*\*Skip when:\*\* Y\./);
  });

  it('refuses an index heading with no applies-when line, and a page with neither H2s nor one under its title', () => {
    guide('02-a.md', '# 2. A\n\n## One\n\nBody.\n');
    throws(techniques, /no "\*\*Applies when:\*\* … \*\*Skip when:\*\* …" line under "One"/);
    guide('02-a.md', '# 2. A\n\nBody.\n');
    throws(techniques, /under its title, and no H2s/);
  });

  it('finds every committed excerpt up to date with its sources', () => {
    deepStrictEqual(stale(repo), []);
  });
});
