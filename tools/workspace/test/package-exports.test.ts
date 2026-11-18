/**
 * The export guard: its rules on in-memory packages, and the command on throwaway Git repos.
 *
 *     node --test tools/workspace/test/
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { builtFiles, type Package, packageExports, packageFolders, problems } from '../src/package-exports.ts';

const source = 'workspace-source';

const tracked = new Set([
  'packages/model/src/index.ts',
  'packages/model/src/test-clock.ts',
  'packages/contracts/src/index.ts',
  'packages/contracts/vectors/keys.json',
  'packages/sdk/src/index.ts',
  'packages/sdk/src/client/index.ts',
  'packages/compiler/src/browser-bundle.ts',
]);

/** A package that packs its root, with a source-only entry for tests. */
const model: Package = {
  directory: 'packages/model',
  manifest: {
    name: '@example/model',
    exports: {
      '.': { [source]: './src/index.ts', types: './dist/index.d.mts', import: './dist/index.mjs' },
      './testing': { [source]: './src/test-clock.ts' },
    },
  },
  pack: [{ dts: true, entry: ['src/index.ts'] }],
};

/** A package that packs, with a pattern for its vectors. */
const contracts: Package = {
  directory: 'packages/contracts',
  manifest: {
    name: '@example/contracts',
    exports: {
      '.': { [source]: './src/index.ts', types: './dist/index.d.mts', import: './dist/index.mjs' },
      './testing/vectors/*.json': './vectors/*.json',
    },
  },
  pack: [{ dts: true, entry: ['src/index.ts'] }],
};

/** A published package whose pack names its entries. */
const sdk: Package = {
  directory: 'packages/sdk',
  manifest: {
    name: '@example/sdk',
    exports: {
      '.': { [source]: './src/index.ts', types: './dist/index.d.mts' },
      './client': { [source]: './src/client/index.ts', types: './dist/client.d.mts' },
    },
    publishConfig: { exports: { '.': { types: './dist/index.d.mts' } } },
  },
  pack: [{ dts: {}, entry: { index: 'src/index.ts', client: 'src/client/index.ts' } }],
};

const cli: Package = {
  directory: 'packages/cli',
  manifest: { name: '@example/cli', exports: {} },
  pack: [{ dts: false, entry: ['src/main.ts'] }],
};

describe('builtFiles', () => {
  it('names each entry below the entries’ folder, with types only when it packs them', () => {
    assert.deepEqual(
      [...builtFiles([{ dts: true, entry: ['src/index.ts', 'src/inspect/layout.ts'] }])],
      ['dist/index.mjs', 'dist/index.d.mts', 'dist/inspect/layout.mjs', 'dist/inspect/layout.d.mts'],
    );
    assert.deepEqual([...builtFiles([{ dts: false, entry: ['src/main.ts'] }])], ['dist/main.mjs']);
    assert.deepEqual([...builtFiles([{ entry: { browser: 'src/browser-stub.ts' } }])], ['dist/browser.mjs']);
  });
});

describe('problems', () => {
  it('passes packed, source-only and empty exports, with built targets untracked', () => {
    assert.deepEqual(problems([model, contracts, sdk, cli], tracked), []);
  });

  it('names a package with no exports', () => {
    const service: Package = { directory: 'packages/service', manifest: { name: '@example/service' }, pack: [] };

    assert.deepEqual(problems([service], tracked), [
      'packages/service/package.json: has no exports, so any of its files can be imported. List its entry points, or write "exports": {} if nothing imports it.',
    ]);
  });

  it('names a target no file or pack entry has, condition by condition', () => {
    const broken: Package = {
      ...sdk,
      manifest: { ...sdk.manifest, exports: { './browser': { [source]: './src/browser.ts', import: './dist/browser.mjs' } }, publishConfig: {} },
    };

    assert.deepEqual(problems([broken], tracked), [
      `packages/sdk/package.json: exports["./browser"]["${source}"] names ./src/browser.ts, which isn't tracked. Point it at a file that's there.`,
      `packages/sdk/package.json: exports["./browser"]["import"] names ./dist/browser.mjs, which no pack entry builds. Add its entry to the package's build config, or point it at a file that's there.`,
    ]);
  });

  it('names a pattern that matches no file', () => {
    const vectors: Package = { ...contracts, manifest: { ...contracts.manifest, exports: { './fixtures/*.json': './fixtures/*.json' } } };

    assert.deepEqual(problems([vectors], tracked), [
      `packages/contracts/package.json: exports["./fixtures/*.json"] names ./fixtures/*.json, which isn't tracked. Point it at a file that's there.`,
    ]);
  });

  it('names a generated target', () => {
    const generated: Package = {
      directory: 'packages/compiler',
      manifest: { name: '@example/compiler', exports: { './browser-bundle': './src/browser-bundle.ts', './browser.gen': './src/browser.gen.ts' } },
      pack: [],
    };

    assert.deepEqual(problems([generated], tracked), [
      'packages/compiler/package.json: exports["./browser.gen"] names ./src/browser.gen.ts, which a tool writes. Export the module that uses it instead.',
    ]);
  });

  it('names an entry point with types that no pack entry builds', () => {
    const unpacked: Package = {
      ...sdk,
      manifest: { ...sdk.manifest, exports: { './client': { [source]: './src/client/index.ts', types: './src/client/index.ts' } }, publishConfig: {} },
    };

    assert.deepEqual(problems([unpacked], tracked), [
      `packages/sdk/package.json: exports["./client"] has types at ./src/client/index.ts, which no pack entry builds. Add "./client"'s source to the build config's entries.`,
    ]);
  });
});

describe('the source condition', () => {
  it('names an entry point that builds but gives its source under no condition, or not first', () => {
    const unsourced: Package = {
      ...model,
      manifest: {
        name: '@example/model',
        exports: {
          '.': { types: './dist/index.d.mts', import: './dist/index.mjs' },
          './late': { types: './dist/index.d.mts', [source]: './src/index.ts' },
        },
        publishConfig: { exports: { '.': { types: './dist/index.d.mts' } } },
      },
    };

    assert.deepEqual(problems([unsourced], tracked), [
      `packages/model/package.json: exports["."] has types and import but not its source under "${source}" first. Add "${source}": its source file, ahead of types and import.`,
      `packages/model/package.json: exports["./late"] has types but not its source under "${source}" first. Add "${source}": its source file, ahead of types.`,
    ]);
  });

  it('names a source condition that points at what a build writes', () => {
    const built: Package = {
      ...model,
      manifest: { name: '@example/model', exports: { '.': { [source]: './dist/index.mjs', types: './dist/index.d.mts', import: './dist/index.mjs' } } },
    };

    assert.deepEqual(problems([built], tracked), [
      `packages/model/package.json: exports["."]["${source}"] names ./dist/index.mjs, which a build writes. Point it at the source the build reads.`,
    ]);
  });

  it('is the one --condition names', () => {
    const own: Package = {
      ...model,
      manifest: { name: '@example/model', exports: { '.': { source: './src/index.ts', types: './dist/index.d.mts', import: './dist/index.mjs' } } },
    };

    assert.deepEqual(problems([own], tracked, 'source'), []);
    assert.equal(problems([own], tracked).length, 1);
  });
});

describe('the packages it reads', () => {
  const repos: Array<string> = [];

  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  /** A Git repo with each file written and tracked. */
  const repoWith = (files: Record<string, string>) => {
    const repo = mkdtempSync(join(tmpdir(), 'workspace-package-exports-'));
    repos.push(repo);

    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }

    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });

    return repo;
  };

  const manifest = (name: string) => JSON.stringify({ name, exports: { '.': { source: './src/index.ts' } } });

  const layout = {
    'packages/a/package.json': manifest('a'),
    'packages/a/src/index.ts': 'export {};\n',
    'packages/notes/README.md': 'Not a package.\n',
    'libs/b/package.json': manifest('b'),
    'libs/b/src/index.ts': 'export {};\n',
  };

  const options = { condition: 'source', packConfig: 'vite.config.ts', packKey: 'pack' };

  it('are the folders --packages matches that hold a package.json', () => {
    const repo = repoWith(layout);

    assert.deepEqual(packageFolders(repo, ['packages/*']), ['packages/a']);
    assert.deepEqual(packageFolders(repo, ['packages/*', 'libs/*']), ['libs/b', 'packages/a']);
  });

  it('checks each one, and fails when --packages matches none', async () => {
    const repo = repoWith({ ...layout, 'libs/b/package.json': JSON.stringify({ name: 'b', exports: { '.': { source: './src/missing.ts' } } }) });

    assert.equal(await packageExports(repo, { ...options, packages: ['packages/*'] }), 0);
    assert.equal(await packageExports(repo, { ...options, packages: ['libs/*'] }), 1);
    assert.equal(await packageExports(repo, { ...options, packages: ['apps/*'] }), 1);
  });

  it("reads the build from each package's pack config, under the key it's told", async () => {
    const exportsBuilt = JSON.stringify({
      name: 'a',
      exports: { '.': { source: './src/index.ts', types: './dist/index.d.mts', import: './dist/index.mjs' } },
    });
    const repo = repoWith({
      ...layout,
      'packages/a/package.json': exportsBuilt,
      'packages/a/vite.config.ts': "export default { pack: { dts: true, entry: ['src/index.ts'] } };\n",
      'packages/a/tsdown.config.ts': "export default { dts: true, entry: ['src/index.ts'] };\n",
    });

    assert.equal(await packageExports(repo, { ...options, packages: ['packages/*'] }), 0);
    assert.equal(await packageExports(repo, { ...options, packages: ['packages/*'], packConfig: 'tsdown.config.ts', packKey: '.' }), 0);
    assert.equal(await packageExports(repo, { ...options, packages: ['packages/*'], packConfig: 'none.config.ts' }), 1);
  });
});
