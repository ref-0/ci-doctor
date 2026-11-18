/**
 * check-static.test.ts: the steps run in order and stop at the first that fails, a placeholder
 * stops the run first, and the range starts at the merge base with the default branch.
 *
 * Runs: `node --test check-static.test.ts`. Anywhere: it makes throwaway git repos.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { after, describe, it } from 'node:test';

import { baseOf, run, staticSteps, unfilled, type Step } from './check-static.ts';

const folders: Array<string> = [];

after(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const folder = () => {
  const made = mkdtempSync(join(tmpdir(), 'check-static-'));
  folders.push(made);

  return made;
};

const git = (repo: string, args: ReadonlyArray<string>) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } }).trim();

const commit = (repo: string, file: string, text: string) => {
  writeFileSync(join(repo, file), text);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', file]);

  return git(repo, ['rev-parse', 'HEAD']);
};

/** A step that writes `name` into `root` and exits with `code`. */
const step = (name: string, code: number): Step => ({
  name,
  command: [execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(name)}, ''); process.exit(${String(code)})`],
});

describe('check-static', () => {
  it('runs each step in order and stops at the first that fails, with its exit code', () => {
    const root = folder();

    assert.equal(run([step('one', 0), step('two', 3), step('three', 0)], root), 3);
    assert.deepEqual(['one', 'two', 'three'].map((name) => existsSync(join(root, name))), [true, true, false]);
    assert.equal(run([step('four', 0)], root), 0);
  });

  it('runs a step’s local command in place of CI’s', () => {
    const root = folder();

    assert.equal(run([{ ...step('ci', 1), local: step('here', 0).command }], root), 0);
    assert.equal(existsSync(join(root, 'here')), true);
    assert.equal(existsSync(join(root, 'ci')), false);
  });

  it('names the steps that still hold a placeholder', () => {
    assert.deepEqual(unfilled(staticSteps('base')), ['Generated files are current', 'Types']);
    assert.deepEqual(unfilled([step('filled', 0)]), []);
  });

  it('checks from the merge base with the default branch, not from its tip', () => {
    const repo = folder();
    git(repo, ['init', '-q', '-b', 'main']);
    const left = commit(repo, 'a.txt', 'a\n');
    git(repo, ['switch', '-q', '-c', 'branch']);
    commit(repo, 'b.txt', 'b\n');
    git(repo, ['switch', '-q', 'main']);
    commit(repo, 'c.txt', 'c\n');
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'main']);
    git(repo, ['switch', '-q', 'branch']);

    assert.equal(baseOf(repo), left);
  });
});
