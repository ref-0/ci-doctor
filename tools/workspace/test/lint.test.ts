/**
 * The split lint config's two passes, `merge`, and the local check's steps, with a stand-in runner.
 *
 *     node --test tools/workspace/test/
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { defaults } from '../src/config.ts';
import { changedFiles, runCheck, type Runner } from '../src/lint/check.ts';
import { base, merge, modeVariable } from '../src/lint/config.ts';

describe('the lint config', () => {
  it('turns the type-aware rules and unused-directive reports off only for the untyped pass, and never checks types', () => {
    assert.deepEqual(base({}).lint.options, { reportUnusedDisableDirectives: 'error', typeAware: true, typeCheck: false });
    assert.deepEqual(base({ [modeVariable]: 'none' }).lint.options, { reportUnusedDisableDirectives: 'off', typeAware: false, typeCheck: false });
  });

  it("merges a repo's own settings over the shared ones: lists joined, rules and options merged", () => {
    const merged = merge(base({}).lint, {
      ignorePatterns: ['vendor/**'],
      rules: { 'oxc/no-accumulating-spread': 'off', 'own/rule': 'error' },
      options: { typeCheck: false },
      overrides: [{ files: ['scripts/**'], rules: {} }],
    });

    assert.deepEqual(merged.ignorePatterns?.at(-1), 'vendor/**');
    assert.equal(merged.rules?.['oxc/no-accumulating-spread'], 'off');
    assert.equal(merged.rules?.['own/rule'], 'error');
    assert.equal(merged.rules?.['typescript/no-explicit-any'], 'error');
    assert.equal(merged.options?.['typeAware'], true);
    assert.equal(merged.overrides?.length, 3);
  });
});

/** A runner that records each command and its mode, and fails the commands `failing` names. */
const recorder = (failing: ReadonlyArray<string> = []) => {
  const ran: Array<string> = [];
  const run: Runner = (command, env) => {
    ran.push(`${env[modeVariable] ?? 'typed'}: ${command.join(' ')}`);

    return !failing.some((word) => command.includes(word));
  };

  return { ran, run };
};

const lint = { ...defaults.lint, before: [['node', 'types.ts']] };

describe('the local check', () => {
  it('runs the steps before lint, untyped lint over everything, then typed lint on the changed files', () => {
    const { ran, run } = recorder();

    assert.equal(runCheck('/repo', lint, { fix: false, run, changed: ['src/a.ts', 'src/b.tsx'] }), 0);
    assert.deepEqual(ran, ['typed: node types.ts', 'none: vp run lint:workspace', 'typed: vp run lint:files src/a.ts src/b.tsx']);
  });

  it('runs fix passes fresh, never the cached tasks', () => {
    const { ran, run } = recorder();

    runCheck('/repo', lint, { fix: true, run, changed: ['src/a.ts'] });

    assert.deepEqual(ran.slice(1), ['none: vp check --fix', 'typed: vp lint --fix --no-error-on-unmatched-pattern src/a.ts']);
  });

  it('runs every step though one fails, and fails', () => {
    const { ran, run } = recorder(['types.ts']);

    assert.equal(runCheck('/repo', lint, { fix: false, run, changed: ['src/a.ts'] }), 1);
    assert.equal(ran.length, 3);
  });

  it('skips the typed pass when no file changed', () => {
    const { ran, run } = recorder();

    runCheck('/repo', lint, { fix: false, run, changed: [] });

    assert.deepEqual(ran, ['typed: node types.ts', 'none: vp run lint:workspace']);
  });

  it('counts committed, uncommitted and new files since the base, not deleted ones', () => {
    const repo = mkdtempSync(join(tmpdir(), 'workspace-lint-'));
    const git = (...args: Array<string>) =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo });

    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'kept.ts'), '1');
    writeFileSync(join(repo, 'gone.ts'), '1');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('switch', '-q', '-c', 'change');
    writeFileSync(join(repo, 'committed.ts'), '1');
    git('add', '-A');
    git('commit', '-q', '-m', 'change');
    writeFileSync(join(repo, 'kept.ts'), '2');
    writeFileSync(join(repo, 'new.ts'), '1');
    writeFileSync(join(repo, 'notes.md'), '1');
    rmSync(join(repo, 'gone.ts'));

    assert.deepEqual(changedFiles(repo, 'main', /\.[cm]?tsx?$/), ['committed.ts', 'kept.ts', 'new.ts']);

    rmSync(repo, { recursive: true, force: true });
  });
});
