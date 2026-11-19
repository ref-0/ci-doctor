/**
 * Tests for check.ts: the old-name scan, the skills-only link check and the test runner each
 * catch what they're for, including the cases a review found they missed.
 *
 * Runs: `node --test check.test.ts` from this folder (Node 24).
 */
import { deepStrictEqual, equal, match } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { FALLBACK, OLD_NAMES, skillsOnly, tests } from './check.ts';

const flagged = (line: string) => OLD_NAMES.some(([pattern]) => pattern.test(line));

const write = (root: string, file: string, text: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};

describe('the old-name scan', () => {
  it('finds old topic skills and PROMPT.md, after any relative prefix and in commands', () => {
    for (const line of ['see ../../skills/ci-workflows/SKILL.md', '.agents/skills/ci-runners/', 'cat PROMPT.md', '[it](../PROMPT.md#x)', 'the `code-review` skill']) {
      equal(flagged(line), true, line);
    }
  });

  it('leaves the new paths alone', () => {
    for (const line of ['skills/ci-doctor/references/ci-workflows/TOPIC.md', 'skills/review-gate/SKILL.md', 'the hub\'s ci-runners topic']) {
      equal(flagged(line), false, line);
    }
  });
});

describe('the skills-only link check', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-skills-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  write(root, 'skills/ci-doctor/SKILL.md', `# Hub\n\n## Outside the skills\n\n${FALLBACK.map((f) => `\`${f}\``).join(', ')}\n`);
  write(root, 'skills/ci-doctor/references/page.md', '# Page\n\nSee [the notes][notes].\n\n[notes]: ../../../elsewhere/notes.md\n');
  write(root, 'elsewhere/notes.md', '# Notes\n');

  it('follows reference-style links out of the copy, as it does inline ones', () => {
    const problems = skillsOnly(root);
    equal(problems.length, 1);
    match(problems[0] ?? '', /page\.md:5: .*leaves skills\/ for elsewhere\/notes\.md/);
  });
});

describe('the test runner', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-tests-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  write(root, 'skills/a/scripts/empty.test.ts', "import { describe } from 'node:test';\ndescribe('nothing', () => {});\n");
  write(root, 'skills/a/scripts/one.test.ts', "import { it } from 'node:test';\nit('passes', () => {});\n");
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', '.'], { cwd: root });

  it('counts a file where no test passed as a problem, and a passing one as not', () => {
    const run = tests(root);
    deepStrictEqual(
      run.problems.filter((p) => !p.startsWith('scripts/')).map((p) => p.split(':')[0]),
      ['skills/a/scripts/empty.test.ts'],
    );
    equal(run.passed, 1);
  });
});
