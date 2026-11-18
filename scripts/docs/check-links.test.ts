import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkFile, checkMentions, slug } from './check-links.ts';

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), 'check-links-'));
  mkdirSync(join(root, 'docs/pages'), { recursive: true });
  writeFileSync(join(root, 'docs/pages/06-reuse.md'), '# 6. Reuse\n\n## Task runners and their remote caches\n\n## Notes\n\n## Notes\n');
  return root;
};

test('slugs headings as GitHub does', () => {
  assert.equal(slug('6. Reuse work by its real inputs'), '6-reuse-work-by-its-real-inputs');
  assert.equal(slug('`ci-time.ts`: two clocks'), 'ci-timets-two-clocks');
  assert.equal(slug("What's here"), 'whats-here');
});

test('passes links to files, folders and headings, duplicates included', () => {
  const root = repo();
  const file = join(root, 'README.md');
  writeFileSync(
    file,
    '[a](docs/pages/06-reuse.md) [b](docs/) [c](docs/pages/06-reuse.md#task-runners-and-their-remote-caches) [d](docs/pages/06-reuse.md#notes-1) [e](https://example.com/x) [f](#top)\n\n# Top\n',
  );
  assert.deepEqual(checkFile(file), []);
});

test('fails a missing file and a missing heading', () => {
  const root = repo();
  const file = join(root, 'README.md');
  writeFileSync(file, '[a](docs/GUIDE.md)\n[b](docs/pages/06-reuse.md#no-such)\n');
  assert.deepEqual(
    checkFile(file).map((p) => [p.line, p.why]),
    [
      [1, 'no such file'],
      [2, 'no such heading'],
    ],
  );
});

test('ignores links inside code', () => {
  const root = repo();
  const file = join(root, 'README.md');
  writeFileSync(file, '```md\n[a](missing.md)\n```\n`[b](missing.md)`\n');
  assert.deepEqual(checkFile(file), []);
});

test('mentions: finds a bare path that no longer exists, skips placeholders', () => {
  const root = repo();
  const file = join(root, 'script.ts');
  writeFileSync(file, '// Why: docs/pages/06-reuse.md\n// See docs/GUIDE.md section 6.\n// Your copy: docs/<your-page>.md\n');
  assert.deepEqual(
    checkMentions(file, root).map((p) => [p.line, p.target]),
    [[2, 'docs/GUIDE.md']],
  );
});
