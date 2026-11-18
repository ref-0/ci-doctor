/**
 * type-coverage.test.ts: the check on a throwaway workspace, through nested project references and
 * with a stand-in lint-files command.
 *
 *     TYPE_COVERAGE_NODE_MODULES=/path/to/node_modules node --test scripts/docs/type-coverage.test.ts
 *
 * It runs a real `tsc --showConfig`, so it needs a `node_modules` holding `typescript`: the one
 * `TYPE_COVERAGE_NODE_MODULES` names, else the repo's own beside these scripts. Without one it
 * skips.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { env, execPath } from 'node:process';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import { config, typeCoverage } from './type-coverage.ts';

const installed = env['TYPE_COVERAGE_NODE_MODULES'] ?? fileURLToPath(new URL('../../node_modules', import.meta.url));
const skip = existsSync(join(installed, 'typescript', 'package.json')) ? false : 'no node_modules with typescript: set TYPE_COVERAGE_NODE_MODULES';

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

let repo = '';

/** Writes each file into the repo, and tracks it unless it's in `untracked`. */
const write = (files: Readonly<Record<string, string>>, untracked: ReadonlyArray<string> = []) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }

  execFileSync('git', ['add', '--', ...Object.keys(files).filter((path) => !untracked.includes(path))], { cwd: repo, env: gitEnv });
};

/** The check's exit code, and each file it names. */
const check = async (shape = config) => {
  const errors = mock.method(console, 'error', () => undefined);
  const logs = mock.method(console, 'log', () => undefined);

  try {
    const status = await typeCoverage(repo, shape);
    const named = errors.mock.calls.flatMap((call) => {
      const match = /^::error file=([^:]+)::/.exec(String(call.arguments[0]));

      return match === null ? [] : [match[1]];
    });

    return { status, named };
  } finally {
    errors.mock.restore();
    logs.mock.restore();
  }
};

/** A root that reaches `app`, which reaches the tooling project through a reference of its own. */
const workspace = {
  'package.json': JSON.stringify({ name: 'workspace', private: true }),
  'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './app' }] }),
  'app/tsconfig.json': JSON.stringify({ include: ['src'], references: [{ path: '../tsconfig.tooling.json' }] }),
  'tsconfig.tooling.json': JSON.stringify({ include: ['tool.mts'] }),
  'app/src/index.ts': 'export {};\n',
  'app/src/view.tsx': 'export {};\n',
  'tool.mts': 'export {};\n',
  'gate/tsconfig.json': JSON.stringify({ include: ['**/*.ts'] }),
  'gate/gate.ts': 'export {};\n',
  'app/scripts/build.ts': 'export {};\n',
  'notes.ts': 'export {};\n',
};

/** The workspace with every tracked file in a project the root reaches. */
const covered = {
  ...workspace,
  'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './app' }, { path: './gate/tsconfig.json' }] }),
  'app/tsconfig.json': JSON.stringify({ include: ['src', 'scripts'], references: [{ path: '../tsconfig.tooling.json' }] }),
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'type-coverage-test-'));
  execFileSync('git', ['init', '-q'], { cwd: repo, env: gitEnv });
  if (skip === false) symlinkSync(installed, join(repo, 'node_modules'));
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('the type coverage check', { skip }, () => {
  it("fails on each tracked file outside the root's projects, through nested references", async () => {
    write(workspace, ['notes.ts']);

    assert.deepEqual(await check(), { status: 1, named: ['app/scripts/build.ts', 'gate/gate.ts'] });
  });

  it('passes once every tracked file is in a project the root reaches', async () => {
    write(covered, ['notes.ts']);

    assert.deepEqual(await check(), { status: 0, named: [] });
  });

  it('fails on each tracked file lint ignores, other than one a tool writes', async () => {
    write({ ...covered, 'app/src/routes.gen.ts': 'export {};\n' }, ['notes.ts']);

    // A stand-in for lint, which reads every TypeScript file but gate/ and what a tool writes.
    const lint = `console.log(${JSON.stringify(['app/src/index.ts', 'app/src/view.tsx', 'tool.mts', 'app/scripts/build.ts'].join('\n'))})`;

    assert.deepEqual(await check({ ...config, lintFilesCommand: [execPath, '-e', lint] }), { status: 1, named: ['gate/gate.ts'] });
  });
});
