/**
 * Tests for the selection planner, against small Git histories it builds in a temp folder.
 *
 *     node --test templates/plan/affected-checks.test.ts
 *
 * Runs locally or in CI with Node 24 alone. It copies `affected-checks.ts` into each temp repo with
 * the config block filled in for a toy workspace: a library, an app that depends on it, and an
 * integration-heavy server. Written for this template; the production monorepo's own selector tests
 * depend on its layout and weren't ported. The CI-file case needs the `yaml` package: set
 * `PLAN_YAML` to its `dist/index.js`, or it's skipped. Reference implementation; adapt to your repo.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const planner = readFileSync(fileURLToPath(new URL('./affected-checks.ts', import.meta.url)), 'utf8');

/** The planner with the toy workspace's config. */
const configured = planner
  .replaceAll("'@<org>/'", "'@demo/'")
  .replaceAll("'@<org>/source'", "'@demo/source'")
  .replace("root: '<server-package>/'", "root: 'apps/server/'")
  .replace("sharedImporters: 20,", 'sharedImporters: 2,')
  .replace(
    "  coveredOnly: new Map<string, ReadonlyArray<string>>([",
    "  coveredOnly: new Map<string, ReadonlyArray<string>>([\n    ['apps/server/src/big.test.ts', ['apps/server/src/pack.ts']],",
  )
  .replace(
    "  nearCovers: new Map<string, ReadonlyArray<string>>([",
    "  nearCovers: new Map<string, ReadonlyArray<string>>([\n    ['apps/server/src/migrations.test.ts', ['apps/server/migrations/']],",
  );

const folders: Array<string> = [];

after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const lockfile = (version: number) =>
  `lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/lib:\n    dependencies:\n      example:\n        version: ${version}.0.0\nsnapshots:\n  example@${version}.0.0: {}\n`;

/** The toy workspace's files at its first commit. */
const files: Record<string, string> = {
  'package.json': json({ name: 'demo', private: true, type: 'module' }),
  'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
  'pnpm-lock.yaml': lockfile(1),
  'scripts/affected-checks.ts': configured,
  'scripts/helper.ts': 'export const helper = 1;\n',
  'README.md': '# demo\n',
  'packages/lib/package.json': json({ name: '@demo/lib', exports: { '.': './src/index.ts' } }),
  'packages/lib/src/index.ts': "export * from './math.ts';\n",
  'packages/lib/src/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
  'packages/lib/src/math.test.ts': "import { add } from './math.ts';\n",
  'packages/lib/src/testing/fixture.ts': 'export const fixture = 1;\n',
  'packages/lib/src/fixture.test.ts': "import { fixture } from './testing/fixture.ts';\n",
  'packages/lib/src/helper.test.ts': "import '../../../scripts/helper.ts';\n",
  'apps/web/package.json': json({ name: '@demo/web', dependencies: { '@demo/lib': 'workspace:*' } }),
  'apps/web/src/page.ts': "import { add } from '@demo/lib';\n",
  'apps/web/src/page.test.ts': "import './page.ts';\n",
  'apps/server/package.json': json({ name: '@demo/server' }),
  'apps/server/src/log.ts': 'export const log = 1;\n',
  'apps/server/src/a.ts': "import './log.ts';\n",
  'apps/server/src/b.ts': "import './log.ts';\n",
  'apps/server/src/c.ts': "import './log.ts';\n",
  'apps/server/src/queue.ts': 'export const queue = 1;\n',
  'apps/server/src/runner.ts': "import './queue.ts';\n",
  'apps/server/src/queue.test.ts': 'export {};\n',
  'apps/server/src/queue-searches.test.ts': 'export {};\n',
  'apps/server/src/runner.test.ts': "import './runner.ts';\n",
  'apps/server/src/a.test.ts': "import './a.ts';\n",
  'apps/server/src/other.test.ts': 'export {};\n',
  'apps/server/src/pack.ts': 'export const pack = 1;\n',
  'apps/server/src/big.test.ts': "import './pack.ts';\n",
  // Shares the covered-only file's name as a prefix, and isn't covered-only itself.
  'apps/server/src/big.test.ts-extra.test.ts': "import './pack.ts';\n",
  'apps/server/src/migrations.test.ts': 'export {};\n',
  'apps/server/migrations/0001.sql': 'CREATE TABLE t (id INTEGER);\n',
  'apps/server/src/queue.sandbox.test.ts':
    "import './queue.ts';\nimport type { log } from './log.ts';\nconst migrations = new URL('../migrations/', import.meta.url);\n",
  'apps/server/src/runner.sandbox.test.ts': "import './runner.ts';\n",
};

/** A repo at the toy workspace, then a commit with `changes` (null deletes), and the plan's lines. */
const plan = (changes: Record<string, string | null>, near = true, baseFiles = files) => {
  const folder = mkdtempSync(join(tmpdir(), 'affected-checks-'));
  folders.push(folder);

  const run = (...args: Array<string>) =>
    execFileSync('git', args, { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const write = (entries: Record<string, string | null>) => {
    for (const [path, text] of Object.entries(entries)) {
      const full = join(folder, path);
      if (text === null) {
        rmSync(full);
        continue;
      }

      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
  };

  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'test');
  write(baseFiles);
  run('add', '-A');
  run('commit', '-qm', 'base');
  write(changes);
  run('add', '-A');
  run('commit', '-qm', 'change', '--allow-empty');

  const output = execFileSync(
    process.execPath,
    ['scripts/affected-checks.ts', ...(near ? ['--near'] : []), 'HEAD^1', 'HEAD'],
    { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );

  return Object.fromEntries(
    output
      .trim()
      .split('\n')
      .map((line) => {
        const at = line.indexOf('=');

        return [line.slice(0, at), JSON.parse(line.slice(at + 1)) as unknown];
      }),
  );
};

describe('the planner', () => {
  it('runs no tests for docs alone', () => {
    assert.deepEqual(plan({ 'README.md': '# demo, again\n' }), {
      packages: [],
      uncovered: ['apps/server/src/big.test.ts'],
      ci_jobs: [],
      ci_needs: [],
      own_jobs: [],
      test_selection: {},
    });
  });

  it('runs a library and its dependents for a library edit', () => {
    const result = plan({ 'packages/lib/src/math.ts': 'export const add = () => 0;\n' });
    assert.deepEqual(result.packages, [
      'apps/web/',
      'packages/lib/',
    ]);
    assert.deepEqual(result.test_selection, {
      'apps/web/src/page.test.ts': 'dependent-package',
      'packages/lib/src/fixture.test.ts': 'package-edit',
      'packages/lib/src/helper.test.ts': 'package-edit',
      'packages/lib/src/math.test.ts': 'package-edit',
    });
  });

  it('explains a test edit and a lockfile change that reaches a package and its dependent', () => {
    assert.deepEqual(plan({ 'packages/lib/src/math.test.ts': 'export {};\n' }).test_selection, {
      'packages/lib/src/math.test.ts': 'edited',
    });
    const result = plan({ 'pnpm-lock.yaml': lockfile(2) });
    assert.deepEqual(result.packages, ['apps/web/', 'packages/lib/']);
    assert.deepEqual(result.test_selection, {
      'apps/web/src/page.test.ts': 'lockfile',
      'packages/lib/src/fixture.test.ts': 'lockfile',
      'packages/lib/src/helper.test.ts': 'lockfile',
      'packages/lib/src/math.test.ts': 'lockfile',
    });
  });

  it('explains the test that reaches the changed package entry', () => {
    const entryScoped = configured.replace('entryScoped: []', "entryScoped: ['@demo/lib']");
    const result = plan({ 'packages/lib/src/math.ts': 'export const add = () => 0;\n' }, true, {
      ...files,
      'scripts/affected-checks.ts': entryScoped,
      'apps/web/src/unrelated.test.ts': 'export {};\n',
    });

    assert.deepEqual(result.packages, ['apps/web/src/page.test.ts', 'packages/lib/']);
    const selection = result.test_selection as Record<string, string>;
    assert.equal(selection['apps/web/src/page.test.ts'], 'package-entry');
    assert.equal(selection['apps/web/src/unrelated.test.ts'], undefined);
  });

  it('runs only the tests that run a test-only edit', () => {
    assert.deepEqual(plan({ 'packages/lib/src/testing/fixture.ts': 'export const fixture = 2;\n' }).packages, [
      'packages/lib/src/fixture.test.ts',
    ]);
  });

  it('runs everything for a shared input or unknown code', () => {
    assert.equal(plan({ 'tsconfig.json': '{}\n' }).packages, null);
    assert.equal(plan({ 'tools/thing.ts': 'export {};\n' }).packages, null);
    assert.equal(plan({ 'scripts/affected-checks.ts': `${configured}\n` }).packages, null);
  });

  it('runs the tests that import a root script only tests use', () => {
    const result = plan({ 'scripts/helper.ts': 'export const helper = 2;\n' });
    assert.deepEqual(result.packages, [
      'packages/lib/src/helper.test.ts',
    ]);
    assert.deepEqual(result.test_selection, { 'packages/lib/src/helper.test.ts': 'root-script' });
  });

  it('runs the near tests of a server module: its own, those named for it, and those one climb up', () => {
    const result = plan({ 'apps/server/src/queue.ts': 'export const queue = 2;\n' });
    assert.deepEqual(result.packages, [
      'apps/server/src/queue-searches.test.ts',
      'apps/server/src/queue.test.ts',
      'apps/server/src/runner.test.ts',
    ]);
    assert.deepEqual(result.test_selection, {
      'apps/server/src/queue-searches.test.ts': 'named-for-changed-module',
      'apps/server/src/queue.test.ts': 'named-for-changed-module',
      'apps/server/src/runner.test.ts': 'imports-changed-module',
      'apps/server/src/queue.sandbox.test.ts': 'imports-changed-module',
    });
  });

  it('stops climbing at a module more than the fan-in cutoff run', () => {
    // log.ts has 3 importers, past the toy cutoff of 2, so a.test.ts isn't reached through a.ts.
    assert.deepEqual(plan({ 'apps/server/src/log.ts': 'export const log = 2;\n' }).packages, []);
  });

  it('runs the whole server without --near', () => {
    assert.deepEqual(plan({ 'apps/server/src/queue.ts': 'export const queue = 2;\n' }, false).packages, [
      'apps/server/',
    ]);
  });

  it('runs a test that reads files from disk by its coverage declaration', () => {
    const result = plan({ 'apps/server/migrations/0002.sql': 'CREATE TABLE u (id INTEGER);\n' });
    assert.deepEqual(result.packages, [
      'apps/server/src/migrations.test.ts',
    ]);
    assert.deepEqual(result.test_selection, {
      'apps/server/src/migrations.test.ts': 'coverage-declaration',
      'apps/server/src/queue.sandbox.test.ts': 'imports-changed-module',
    });
  });

  it('leaves out a covered-only test unless the change covers it, even when everything runs', () => {
    const elsewhere = plan({ 'tsconfig.json': '{}\n' });
    const covering = plan({ 'apps/server/src/pack.ts': 'export const pack = 2;\n' });

    assert.equal(elsewhere.packages, null);
    assert.deepEqual(elsewhere.uncovered, ['apps/server/src/big.test.ts']);
    assert.equal((elsewhere.test_selection as Record<string, string>)['apps/server/src/big.test.ts'], undefined);
    assert.equal((elsewhere.test_selection as Record<string, string>)['apps/server/src/other.test.ts'], 'fallback-everything');
    assert.deepEqual(covering.uncovered, []);
    assert.ok((covering.packages as Array<string>).includes('apps/server/src/big.test.ts'));
  });

  it("runs an own-job file only through its own runtime imports and file URLs on a PR", () => {
    // queue.ts: queue.sandbox imports it. runner.sandbox reaches it only through runner.ts.
    assert.deepEqual(plan({ 'apps/server/src/queue.ts': 'export const queue = 2;\n' }).own_jobs, [
      'apps/server/src/queue.sandbox.test.ts',
    ]);
    // A type-only import runs nothing.
    assert.deepEqual(plan({ 'apps/server/src/log.ts': 'export const log = 2;\n' }).own_jobs, []);
    // A folder the file opens by URL.
    assert.deepEqual(plan({ 'apps/server/migrations/0002.sql': 'CREATE TABLE u (id INTEGER);\n' }).own_jobs, [
      'apps/server/src/queue.sandbox.test.ts',
    ]);
    // Everything selected still runs only the reached own-job files on a PR.
    assert.deepEqual(plan({ 'tsconfig.json': '{}\n' }).own_jobs, []);
  });

  it('runs every own-job file of a reached package without --near, and all of them for everything', () => {
    assert.deepEqual(plan({ 'apps/server/src/log.ts': 'export const log = 2;\n' }, false).own_jobs, [
      'apps/server/src/queue.sandbox.test.ts',
      'apps/server/src/runner.sandbox.test.ts',
    ]);
    assert.equal(plan({ 'tsconfig.json': '{}\n' }, false).own_jobs, null);
  });

  it('runs only the edited job for a CI edit, and nothing for a comment', { skip: !process.env['PLAN_YAML'] }, () => {
    const workflow = (lint: string, tests = 'test') =>
      `name: CI\non: push\njobs:\n  plan:\n    runs-on: x\n    steps: [{ run: plan }]\n  lint:\n    needs: plan\n    runs-on: x\n    steps: [{ run: ${lint} }]\n  tests:\n    needs: plan\n    runs-on: x\n    steps: [{ run: ${tests} }]\n`;
    const folderFiles = { '.github/workflows/ci.yml': workflow('lint') };
    Object.assign(files, folderFiles);

    const edited = plan({ '.github/workflows/ci.yml': workflow('lint --fix') });
    const comment = plan({ '.github/workflows/ci.yml': `# a comment\n${workflow('lint')}` });
    const tests = plan({ '.github/workflows/ci.yml': workflow('lint', 'test --force') });

    assert.deepEqual(edited.ci_jobs, ['lint']);
    assert.deepEqual(edited.packages, []);
    assert.deepEqual(comment.ci_jobs, []);
    assert.deepEqual(comment.test_selection, {});
    assert.deepEqual(tests.packages, []);
    assert.deepEqual(tests.ci_jobs, ['tests']);
    const selection = tests.test_selection as Record<string, string>;
    assert.equal(selection['apps/web/src/page.test.ts'], 'ci-file');
    assert.equal(selection['apps/server/src/big.test.ts'], undefined);
    assert.equal(selection['apps/server/src/queue.sandbox.test.ts'], undefined);
    delete files['.github/workflows/ci.yml'];
  });
});
