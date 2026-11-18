/**
 * Tests for install.ts on a throwaway playbook: links rewritten into --root, anchors checked, and a
 * repo's own skill left alone.
 *
 * Runs: `node --test install.test.ts` from this folder, or `node --test skills/install.test.ts` from
 * the playbook's root (Node 24).
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { deepStrictEqual, equal, match, notEqual, ok } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { check, outside, slug } from './install.ts';

const script = join(dirname(fileURLToPath(import.meta.url)), 'install.ts');

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

describe('install', () => {
  let tmp = '';
  let root = '';
  let into = '';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'install-'));
    root = join(tmp, 'repo', '.agents', 'ci-doctor');
    write(join(root, 'skills', 'a', 'SKILL.md'),
      '# A\n\n[check](../../checks/c.md#the-rule) · [ref](references/r.md) · [b](../b/SKILL.md)\n');
    write(join(root, 'skills', 'a', 'references', 'r.md'), '[guide](../../../docs/README.md#2-runners)\n');
    write(join(root, 'skills', 'b', 'SKILL.md'), '# B\n');
    write(join(root, 'checks', 'c.md'), '# Check\n\n## The rule\n');
    write(join(root, 'docs', 'README.md'), '# Guide\n\n## 2. Runners\n');
    mkdirSync(join(tmp, 'repo', '.claude'));
    into = join(tmp, 'repo', '.claude', 'skills');
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const runCli = (...args: string[]) => {
    const done = spawnSync(process.execPath, [script, ...args], { cwd: join(tmp, 'repo'), encoding: 'utf8' });
    return { code: done.status, output: done.stdout + done.stderr };
  };

  it('installs only the named skill and points its links at the root', () => {
    const done = runCli('--root', '.agents/ci-doctor', '--into', '.claude/skills', 'a');
    equal(done.code, 0, done.output);
    ok(!existsSync(join(into, 'b')));
    const text = readFileSync(join(into, 'a', 'SKILL.md'), 'utf8');
    ok(text.includes('](../../../.agents/ci-doctor/checks/c.md#the-rule)'), text);
    ok(text.includes('](references/r.md)'), text);
    ok(text.includes('](../../../.agents/ci-doctor/skills/b/SKILL.md)'), text);
    deepStrictEqual(check([into]), []);
  });

  it("never overwrites a repo's own skill", () => {
    write(join(into, 'a', 'SKILL.md'), "# the repo's own\n");
    const done = runCli('--root', '.agents/ci-doctor', '--into', '.claude/skills', 'a');
    notEqual(done.code, 0);
    equal(readFileSync(join(into, 'a', 'SKILL.md'), 'utf8'), "# the repo's own\n");
  });

  it('reinstalls over its own copy', () => {
    equal(runCli('--root', '.agents/ci-doctor', '--into', '.claude/skills', 'a').code, 0);
    equal(runCli('--root', '.agents/ci-doctor', '--into', '.claude/skills', 'a').code, 0);
  });

  it("refuses a harness folder that isn't there", () => {
    const done = runCli('--root', '.agents/ci-doctor', '--into', '.codex-typo/skills', 'a');
    notEqual(done.code, 0);
    match(done.output, /parent folder doesn't exist/);
  });

  it('lists in its manifest what a skill needs outside it', () => {
    deepStrictEqual(outside(root, 'a'), ['checks/c.md', 'docs/README.md', 'skills/b/SKILL.md']);
  });

  it('finds a missing file and a missing anchor', () => {
    write(join(root, 'skills', 'a', 'bad.md'), '[x](nope.md) [y](../../checks/c.md#gone) `[z](skip.md)`\n');
    const problems = check([join(root, 'skills', 'a', 'bad.md')]);
    equal(problems.length, 2);
    match(problems[0] ?? '', /no such file/);
    match(problems[1] ?? '', /#gone/);
  });

  it('slugs as GitHub does', () => {
    equal(slug('2. Runners, Blacksmith and the cost of getting fast'), '2-runners-blacksmith-and-the-cost-of-getting-fast');
    equal(slug('If your stack uses `Effect`'), 'if-your-stack-uses-effect');
  });
});
