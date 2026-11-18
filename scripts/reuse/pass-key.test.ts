/**
 * pass-key.test.ts: what moves the pass key and what holds it, the versionless manifests, and the
 * workflow blocks, on a fixture source; then `sourceAt` on a throwaway git repository.
 *
 *     node --test scripts/reuse/pass-key.test.ts
 *
 * Reference implementation from a production monorepo; adapt to your repo. In your repo, add a
 * test that keys your real HEAD, as the original does, so a renamed job or file fails here first.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { blocksOf, isInput, type KeyConfig, keyOf, type Source, sourceAt, versionless } from './pass-key.ts';

const shape: KeyConfig = {
  keyVersion: 'pass-key test',
  component: 'crates/engine/',
  outsidePrefixes: ['shared/vectors/'],
  outsideFiles: ['.github/workflows/engine-builds.yml'],
  above: ['', 'crates/'],
  aboveFiles: ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'rustfmt.toml', 'clippy.toml'],
  aboveFolders: ['.cargo/'],
  workflowPath: '.github/workflows/ci.yml',
  jobs: ['engine', 'engine-tests', 'rust'],
  inherited: ['env', 'defaults'],
  isVersioned: (path) => /^crates\/engine\/npm\/[^/]+\/package\.json$/.test(path),
};

const workflow = `name: CI
env:
  FORCE_COLOR: '1'

jobs:
  plan:
    runs-on: x
    steps:
      - run: echo plan
  engine:
    uses: ./.github/workflows/engine-builds.yml
    with:
      tests: false
  # The engine's tests on each platform.
  engine-tests:
    uses: ./.github/workflows/engine-builds.yml
  rust:
    runs-on: x
    steps:
      - name: Format
        run: cargo fmt --check
      - name: Lint
        run: cargo clippy -- -D warnings

  pack:
    runs-on: x
`;

const platform = (version: string) => `${JSON.stringify({ name: 'engine-linux-x64', version, os: ['linux'] }, null, 2)}\n`;

const packages = ['crates/engine/npm/linux-x64/package.json', 'crates/engine/npm/linux-arm64/package.json'];

const id = (n: number) => `100644 blob ${String(n).padStart(40, '0')}`;

const repo: Source = {
  files: new Map([
    ['crates/engine/src/lib.rs', id(1)],
    ['crates/engine/Cargo.toml', id(2)],
    ['crates/engine/Cargo.lock', id(3)],
    ['crates/engine/AGENTS.md', id(4)],
    ['crates/engine/tests/a.rs', id(5)],
    ['shared/vectors/a.json', id(6)],
    ['shared/src/a.ts', id(7)],
    ['apps/web/src/a.ts', id(8)],
    ['pnpm-lock.yaml', id(9)],
    ...packages.map((path, n) => [path, id(20 + n)] as const),
  ]),
  texts: new Map(packages.map((path) => [path, platform('0.1.0')])),
  workflow,
};

const key = keyOf(repo, { shape });

/** The source with one file's contents changed, or the file added. */
const changed = (source: Source, path: string): Source => ({ ...source, files: new Map(source.files).set(path, `100644 blob ${'f'.repeat(40)}`) });

/** The source with one versioned manifest's text, and so its object id, changed by `edit`. */
const edited = (source: Source, path: string, edit: (text: string) => string): Source => ({
  ...changed(source, path),
  texts: new Map(source.texts).set(path, edit(source.texts.get(path) ?? '')),
});

const json = (edit: (value: Record<string, unknown>) => Record<string, unknown>) => (text: string) => `${JSON.stringify(edit(JSON.parse(text) as Record<string, unknown>), null, 2)}\n`;

describe('keyOf', () => {
  for (const path of [
    'crates/engine/src/lib.rs',
    'crates/engine/tests/a.rs',
    'crates/engine/Cargo.lock',
    'crates/engine/.cargo/config.toml',
    'shared/vectors/b.json',
    '.github/workflows/engine-builds.yml',
    '.cargo/config.toml',
    'crates/.cargo/config.toml',
    'Cargo.toml',
    'crates/Cargo.toml',
    'rust-toolchain.toml',
    'clippy.toml',
  ]) {
    it(`changes when ${path} changes or is added`, () => {
      assert.equal(isInput(path, shape), true);
      assert.notEqual(keyOf(changed(repo, path), { shape }), key);
    });
  }

  for (const path of ['crates/engine/AGENTS.md', 'shared/src/a.ts', 'apps/web/src/a.ts', 'pnpm-lock.yaml', '.github/workflows/release.yml']) {
    it(`holds when ${path} changes`, () => {
      assert.equal(isInput(path, shape), false);
      assert.equal(keyOf(changed(repo, path), { shape }), key);
    });
  }

  for (const [what, from, to] of [
    ['the workflow env', '\nenv:\n', "\nenv:\n  ANOTHER: '1'\n"],
    ['added defaults', '\njobs:\n', '\ndefaults:\n  run:\n    shell: bash\n\njobs:\n'],
    ['the engine job', '\n  engine:\n', '\n  engine:\n    timeout-minutes: 1\n'],
    ['the rust job, under a comment at its indent', '\n  rust:\n', '\n  rust:\n  # a comment\n    env: {}\n'],
    ["the rust job's last line", '-- -D warnings\n', '-- -D warnings\n      - run: cargo test\n'],
  ] as const) {
    it(`changes when ${what} changes in the workflow`, () => {
      assert.notEqual(keyOf({ ...repo, workflow: workflow.replace(from, to) }, { shape }), key);
    });
  }

  for (const [what, from, to] of [
    ['the plan job', '\n  plan:\n', '\n  plan:\n    timeout-minutes: 1\n'],
    ['the pack job', '\n  pack:\n', '\n  pack:\n    timeout-minutes: 1\n'],
    ['the comment between jobs', "  # The engine's tests", '  # Changed: the tests'],
  ] as const) {
    it(`holds when ${what} changes in the workflow`, () => {
      assert.equal(keyOf({ ...repo, workflow: workflow.replace(from, to) }, { shape }), key);
    });
  }

  for (const job of shape.jobs) {
    it(`fails when the workflow has no job ${job}`, () => {
      assert.throws(() => keyOf({ ...repo, workflow: workflow.replace(`\n  ${job}:\n`, `\n  ${job}-renamed:\n`) }, { shape }), new RegExp(`no job ${job}`));
    });
  }

  it('finds each block, ending at the next job and leaving out trailing comments', () => {
    const blocks = blocksOf(workflow, shape);

    assert.deepEqual([...blocks.keys()], ['env', 'jobs.engine', 'jobs.engine-tests', 'jobs.rust']);
    assert.match(blocks.get('jobs.rust') ?? '', /cargo fmt --check[\s\S]*cargo clippy/);
    assert.match(blocks.get('jobs.engine') ?? '', /^ {2}engine:\n[\s\S]*tests: false$/);
  });
});

describe('the pass key and the binary key', () => {
  it('holds the pass key when a release raises every version, and moves the binary key', () => {
    const released = packages.reduce((source, path) => edited(source, path, json((value) => ({ ...value, version: '9.0.0' }))), repo);

    assert.equal(keyOf(released, { shape }), key);
    assert.notEqual(keyOf(released, { shape, versions: true }), keyOf(repo, { shape, versions: true }));
  });

  for (const [what, edit] of [
    ['its os', json((value) => ({ ...value, os: ['darwin'] }))],
    ['a field added', json((value) => ({ ...value, bin: 'engine' }))],
    ['its version moved', json(({ version, ...value }) => ({ ...value, version }))],
    ['its version a number', json((value) => ({ ...value, version: 9 }))],
    ['its version gone', json(({ version: _version, ...value }) => value)],
    ['its indent', (text: string) => `${JSON.stringify(JSON.parse(text), null, 4)}\n`],
    ['its last newline', (text: string) => text.trimEnd()],
  ] as const) {
    it(`moves the pass key when ${what} changes in a manifest`, () => {
      for (const path of packages) assert.notEqual(keyOf(edited(repo, path, edit), { shape }), key);
    });
  }

  it('hashes a manifest that is not JSON as a release writes it whole, by its object id', () => {
    const [path = ''] = packages;
    const broken = edited(repo, path, () => '{\n');

    assert.equal(versionless('{\n'), undefined);
    assert.equal(versionless('[]\n'), undefined);
    assert.notEqual(keyOf(broken, { shape }), key);
    assert.notEqual(keyOf({ ...broken, files: repo.files }, { shape }), keyOf(broken, { shape }));
  });
});

describe('sourceAt', () => {
  const root = mkdtempSync(join(tmpdir(), 'pass-key-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' };
  const git = (...args: ReadonlyArray<string>) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  const commit = (files: Readonly<Record<string, string>>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }

    git('add', '-A');
    git('commit', '-q', '-m', 'x');

    return git('rev-parse', 'HEAD');
  };

  it('reads the tracked files, the versioned texts and the workflow at a commit', () => {
    git('init', '-q');
    const first = commit({ '.github/workflows/ci.yml': workflow, 'crates/engine/src/lib.rs': 'fn a() {}\n', [packages[0] ?? '']: platform('0.1.0') });
    const release = commit({ [packages[0] ?? '']: platform('0.2.0') });
    const change = commit({ 'crates/engine/src/lib.rs': 'fn b() {}\n' });

    const at = (commit: string) => sourceAt(commit, root, shape);
    assert.equal(at(first).texts.get(packages[0] ?? ''), platform('0.1.0'));
    assert.equal(keyOf(at(release), { shape }), keyOf(at(first), { shape }));
    assert.notEqual(keyOf(at(change), { shape }), keyOf(at(release), { shape }));
  });
});
