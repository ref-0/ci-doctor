/**
 * The declared package graph and folder layers: the checks on in-memory packages and imports, and
 * the command on a throwaway Git repo, which needs a parser (see `src/symbols/parser.ts`) and skips
 * without one.
 *
 *     node --test tools/workspace/test/
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

import { currentGraph, graphProblems, importProblems, layerProblems, unusedEntries } from '../src/graph/graph.ts';
import type { Declared, Import, Package, SourceFile } from '../src/graph/graph.ts';

const pkg = (name: string, directory: string, exports: ReadonlyArray<string>, dependencies: ReadonlyArray<string> = [], app = false): Package => ({
  name,
  directory,
  app,
  exports,
  dependencies: new Set(dependencies),
});

const contracts = pkg('@pip/contracts', 'packages/contracts', ['./core', './checks', './testing/vectors/*.json']);
const model = pkg('@pip/model', 'packages/model', ['./queue', './access'], ['@pip/contracts']);
const compiler = pkg('@pip/compiler', 'packages/compiler', ['.'], ['@pip/contracts']);
const web = pkg('@pip/web', 'apps/web', ['.'], ['@pip/model', '@pip/contracts'], true);
const docs = pkg('@pip/docs', 'apps/docs', ['.'], [], true);
const packages = [contracts, model, compiler, web, docs];

const declared: Declared = {
  graph: {
    '@pip/contracts': {},
    '@pip/model': { '@pip/contracts': { values: ['core'], tests: ['testing/vectors'] } },
    '@pip/compiler': { '@pip/contracts': { types: ['checks'] } },
    '@pip/web': { '@pip/model': { values: ['queue'] }, '@pip/contracts': { tests: ['core'] } },
    '@pip/docs': {},
  },
  nodeFiles: { '@pip/compiler': ['src/generate.ts'] },
};

const imports = (source: string, typesOnly = false): ReadonlyArray<Import> => [{ source, typesOnly, line: 1 }];

const file = (path: string, source: string, typesOnly = false): SourceFile => ({ path, imports: imports(source, typesOnly) });

const messages = (files: ReadonlyArray<SourceFile>, graph = declared) => importProblems(graph, packages, files).map(({ message }) => message);

describe('the graph itself', () => {
  it('holds when every package is named, edges reach packages and entries exist', () => {
    assert.deepEqual(graphProblems(declared, packages), []);
  });

  it('names a package the graph leaves out, an edge to an app, a missing entry and an unlisted dependency', () => {
    const found = graphProblems(
      {
        graph: {
          '@pip/contracts': {},
          '@pip/model': { '@pip/contracts': { values: ['queue'] } },
          '@pip/compiler': { '@pip/web': { values: ['.'] }, '@pip/model': { values: ['queue'] } },
          '@pip/web': {},
        },
      },
      packages,
    ).map(({ message }) => message);

    assert.deepEqual(found, [
      "@pip/docs isn't in the graph. Add it, with {} if it imports no workspace package.",
      "@pip/model's edge lists @pip/contracts/queue, which @pip/contracts's exports don't have.",
      "@pip/compiler's edge names @pip/web, an app. Nothing imports an app: move what it needs into a package.",
      "@pip/compiler imports @pip/model in the graph but doesn't list it as a dependency. Add it.",
    ]);
  });
});

describe('imports across packages', () => {
  it('lets through listed entries, types on a types edge, tests entries in tests, and Node files', () => {
    assert.deepEqual(
      messages([
        file('packages/model/src/runs.ts', '@pip/contracts/core'),
        file('packages/model/src/runs.ts', 'effect'),
        file('packages/model/src/a/b.ts', '../runs.ts'),
        file('packages/model/src/runs.test.ts', '@pip/contracts/testing/vectors/keys.json'),
        file('packages/compiler/src/isolate.ts', '@pip/contracts/checks', true),
        file('packages/compiler/src/isolate.test.ts', '@pip/contracts/checks'),
        file('packages/compiler/src/generate.ts', '@pip/contracts/checks'),
        file('apps/web/src/testing/fixtures.ts', '@pip/contracts/core'),
        file('apps/web/src/page.tsx', '@pip/model/queue'),
      ]),
      [],
    );
  });

  it('refuses an app, a missing edge, an unlisted entry, a tests entry outside tests and a value on a types edge', () => {
    assert.deepEqual(
      messages([
        file('packages/model/src/page.ts', '@pip/web'),
        file('packages/compiler/src/runs.ts', '@pip/model/queue'),
        file('apps/web/src/page.tsx', '@pip/model/access'),
        file('apps/web/src/page.tsx', '@pip/contracts/core'),
        file('packages/compiler/src/isolate.ts', '@pip/contracts/checks'),
      ]),
      [
        'Nothing imports an app, and @pip/web is one. Move what @pip/model needs into a package.',
        "@pip/compiler doesn't import @pip/model: package-graph.json has no such edge.",
        "@pip/web doesn't import @pip/model/access: its edge to @pip/model lists `queue`. To import another entry point, add it to that edge.",
        '@pip/web imports @pip/contracts/core only in its tests, as package-graph.json says.',
        '@pip/compiler takes only types from @pip/contracts/checks. Write `import type`, which loads nothing: `import { type … }` still loads it.',
      ],
    );
  });

  it('refuses a relative path out of a package, allowed or not, and into no package', () => {
    assert.deepEqual(
      messages([
        file('packages/model/src/runs.ts', '../../contracts/src/core.ts'),
        file('packages/contracts/src/core.ts', '../../model/src/runs.ts'),
        file('packages/model/src/runs.ts', '../../../scripts/check.ts'),
      ]),
      [
        'This relative path leaves @pip/model for @pip/contracts. Import @pip/contracts by its name, through its exports.',
        "@pip/contracts doesn't import @pip/model: package-graph.json has no such edge.",
        'This relative path leaves @pip/model for a file no package holds.',
      ],
    );
  });
});

describe('the current graph', () => {
  const files = [
    file('packages/model/src/runs.ts', '@pip/contracts/core'),
    file('packages/model/src/runs.test.ts', '@pip/contracts/testing/vectors/keys.json'),
    file('packages/compiler/src/isolate.ts', '@pip/contracts/checks', true),
    file('apps/web/src/page.tsx', '@pip/model/queue'),
    file('apps/web/src/page.test.tsx', '@pip/contracts/core'),
  ];

  it('draws each edge by how its entries are imported', () => {
    assert.deepEqual(currentGraph(packages, files).graph, {
      '@pip/compiler': { '@pip/contracts': { types: ['checks'] } },
      '@pip/contracts': {},
      '@pip/docs': {},
      '@pip/model': { '@pip/contracts': { values: ['core'], tests: ['testing/vectors'] } },
      '@pip/web': { '@pip/contracts': { tests: ['core'] }, '@pip/model': { values: ['queue'] } },
    });
  });

  it('is a graph the imports it came from hold to', () => {
    const graph = currentGraph(packages, files);

    assert.deepEqual([...graphProblems(graph, packages), ...importProblems(graph, packages, files)], []);
  });

  it('lists what a declared graph allows and no import uses', () => {
    const wider: Declared = { graph: { ...declared.graph, '@pip/web': { ...declared.graph['@pip/web'], '@pip/model': { values: ['queue', 'access'] } } } };

    assert.deepEqual(unusedEntries(wider, packages, files.slice(0, 4)), ['@pip/web -> @pip/model/access', '@pip/web -> @pip/contracts']);
  });
});

describe('folder layers', () => {
  const layered: Declared = {
    graph: {},
    layers: { 'packages/cli/src': [['base'], ['terminal', 'client'], ['commands'], ['main']] },
    layerExceptions: { 'packages/cli/src': { 'terminal/output.ts': ['commands/help'] } },
  };

  const layerMessages = (files: ReadonlyArray<SourceFile>, graph = layered) => layerProblems(graph, files).map(({ message }) => message);

  it('lets a file import its own place and places below it, and a test anything', () => {
    assert.deepEqual(
      layerMessages([
        file('packages/cli/src/commands/run.ts', '../base/quote.ts'),
        file('packages/cli/src/commands/run.ts', './flags.ts'),
        file('packages/cli/src/main.ts', './commands/run.ts'),
        file('packages/cli/src/base/quote.test.ts', '../commands/run.ts'),
        file('packages/cli/src/terminal/output.ts', '../commands/help.ts'),
      ]),
      [],
    );
  });

  it('refuses a place beside, above or in no layer, and an exception no import needs', () => {
    assert.deepEqual(
      layerMessages([
        file('packages/cli/src/terminal/lines.ts', '../client/selectors.ts'),
        file('packages/cli/src/base/quote.ts', '../commands/run.ts'),
        file('packages/cli/src/commands/run.ts', '../watch/watch.ts'),
      ]),
      [
        'terminal and client sit in one layer of packages/cli/src, so neither imports the other. Move what it needs down, or join the two from a place above both.',
        'base sits below commands in packages/cli/src, so it imports nothing of it. Move what it needs down, to where both can import it.',
        'watch is in no layer of packages/cli/src. Add it to the layer it belongs in.',
        "packages/cli/src's exception for terminal/output.ts importing commands/help is no longer needed. Delete it.",
      ],
    );
  });
});

const loaded = await import('../src/graph/imports.ts').then(
  (module) => module,
  (error: Error) => error,
);
const skip = loaded instanceof Error ? `no parser: ${loaded.message}` : false;

const repos: Array<string> = [];

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bin.ts');

/** A Git repo holding `files`, each committed. */
const repoWith = (files: Readonly<Record<string, string>>) => {
  const repo = mkdtempSync(join(tmpdir(), 'package-graph-'));
  repos.push(repo);

  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }

  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });

  return repo;
};

const manifest = (name: string, extra: object = {}) => JSON.stringify({ name, ...extra });

describe('the command', { skip }, () => {
  it('reads import kinds from source', () => {
    if (loaded instanceof Error) return;

    const text = [
      "import type { A } from '@pip/a/core';",
      "import { type B } from '@pip/a/core';",
      "export type { C } from './c.ts';",
      "export * from './d.ts';",
      "const e = await import('./e.ts');",
      "type F = import('@pip/a/f').F;",
    ].join('\n');

    assert.deepEqual(loaded.importsOf(text, 'x.ts'), [
      { source: '@pip/a/core', typesOnly: true, line: 1 },
      { source: '@pip/a/core', typesOnly: false, line: 2 },
      { source: './c.ts', typesOnly: true, line: 3 },
      { source: './d.ts', typesOnly: false, line: 4 },
      { source: './e.ts', typesOnly: false, line: 5 },
      { source: '@pip/a/f', typesOnly: true, line: 6 },
    ]);
  });

  it('generates a graph the workspace holds to, then fails an import it leaves out', () => {
    const repo = repoWith({
      'packages/core/package.json': manifest('@pip/core', { exports: { './time': './src/time.ts' } }),
      'packages/core/src/time.ts': 'export const now = () => 0;\n',
      'apps/web/package.json': manifest('@pip/web', { dependencies: { '@pip/core': 'workspace:*' } }),
      'apps/web/src/page.ts': "import { now } from '@pip/core/time';\nexport const page = now;\n",
    });
    const run = (...args: ReadonlyArray<string>) => spawnSync('node', [bin, 'package-graph', ...args], { cwd: repo, encoding: 'utf8' });

    const generated = run('--generate');
    assert.equal(generated.status, 0, generated.stderr);
    writeFileSync(join(repo, 'package-graph.json'), generated.stdout);
    execFileSync('git', ['add', '.'], { cwd: repo });

    const clean = run();
    assert.equal(clean.status, 0, clean.stderr);

    writeFileSync(join(repo, 'packages/core/src/time.ts'), "import { page } from '../../../apps/web/src/page.ts';\nexport const now = () => 0;\n");
    const broken = run();
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /packages\/core\/src\/time\.ts:1: Nothing imports an app, and @pip\/web is one/);
  });
});
