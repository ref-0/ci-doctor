// The graphs from outside: export paths followed through their re-exports, the task graph, and what each reads.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Gh } from '../src/gh.ts';
import { graphsBlock, graphPromptLines, graphsFixes, graphsOf, type Limits } from '../src/graphs.ts';
import { manifestPaths } from '../src/score.ts';
import { githubSource, remembered, type Source } from '../src/source.ts';
import { stackOf } from '../src/stack.ts';
import { blobSha, type Routes } from './fixtures.ts';
import { withStub } from './helpers.ts';

/** A tree of files, read from memory; `unreadable` paths are listed but fail, as a failed read does. Counts each batch. */
const tree = (files: Record<string, string>, { unreadable = [] as string[] } = {}) => {
  const batches: string[][] = [];
  const source: Source = {
    tree: { truncated: false, blobs: Object.keys(files).map((path) => ({ path, size: files[path]!.length })) },
    read: (p) => files[p],
    readMany: (paths) => {
      batches.push(paths);
      const texts = new Map<string, string>();
      const failed = new Map<string, string>();
      for (const p of paths) {
        if (unreadable.includes(p)) failed.set(p, 'GitHub answered: Something went wrong');
        else if (files[p] !== undefined) texts.set(p, files[p]!);
      }
      return { texts, failed };
    },
  };
  return { source, batches };
};

const graphs = (files: Record<string, string>, o: { unreadable?: string[]; limits?: Partial<Limits> } = {}) => {
  const { source: raw, batches } = tree(files, o);
  const source = remembered(raw);
  const stack = stackOf({ source, manifestPaths: manifestPaths(source.tree), workflows: { texts: [], complete: true }, languages: undefined, packages: { npm: 0 }, runners: undefined });
  const before = batches.length;
  const g = graphsOf({ source, stack, ...(o.limits ? { limits: o.limits } : {}) });
  return { g, batches: batches.slice(before) };
};

const json = (o: object) => JSON.stringify(o);
const node = (g: ReturnType<typeof graphs>['g'], id: string) => g.exports.nodes.find((n) => n.id === id);

/** A workspace whose core package has a root barrel: `export *` of two folders' barrels, 25 modules, imported by 3 packages. */
const barrelRepo = () => {
  const files: Record<string, string> = {
    'package.json': json({ name: 'root', private: true, workspaces: ['packages/*'], scripts: { build: 'turbo run build' } }),
    'turbo.json': `{
      // Turborepo allows comments.
      "tasks": {
        "build": { "dependsOn": ["^build"], "inputs": ["src/**"], "outputs": ["dist/**"] },
        "test": { "dependsOn": ["build"] },
        "lint": { "inputs": [] },
        "typecheck": { "inputs": ["$TURBO_ROOT$/**"] },
      },
    }`,
    'packages/core/package.json': json({
      name: '@pip/core',
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js', require: './dist/index.cjs' },
        './icons/*': './src/icons/*.ts',
        './internal/*': null,
        './util': { node: './src/util-node.ts', default: './src/util.ts' },
      },
      scripts: { build: 'tsc', test: 'vitest run', lint: 'oxlint', typecheck: 'tsc --noEmit' },
    }),
    'packages/core/src/index.ts': "export * from './a/index.ts';\nexport * from './b';\nexport { c } from './c.ts';\nexport type { T } from './types.ts';\n",
    'packages/core/src/a/index.ts': Array.from({ length: 12 }, (_, i) => `export * from './m${i}.ts';`).join('\n'),
    'packages/core/src/b/index.ts': Array.from({ length: 10 }, (_, i) => `export { n${i} } from './n${i}';`).join('\n'),
    'packages/core/src/c.ts': "import { helper } from './helper.ts';\nexport const c = helper;\n",
    'packages/core/src/helper.ts': 'export const helper = 1;\n',
    'packages/core/src/types.ts': 'export type T = 1;\n',
    'packages/core/src/icons/one.ts': 'export const one = 1;\n',
    'packages/core/src/icons/two.ts': 'export const two = 2;\n',
    'packages/core/src/util.ts': "export * from './helper.ts';\n",
    'packages/core/src/util-node.ts': 'export const util = 1;\n',
    'packages/app/package.json': json({ name: '@pip/app', main: 'src/main.ts', dependencies: { '@pip/core': 'workspace:*' }, scripts: { build: 'tsc', test: 'vitest run' } }),
    'packages/app/src/main.ts': "import { c } from '@pip/core';\nexport const main = c;\n",
    'packages/web/package.json': json({ name: '@pip/web', private: true, dependencies: { '@pip/core': 'workspace:*' }, scripts: { build: 'vite build' } }),
    'packages/cli/package.json': json({ name: '@pip/cli', private: true, dependencies: { '@pip/core': 'workspace:*', '@pip/deep': 'workspace:*' } }),
    'packages/site/package.json': json({ name: '@pip/site', private: true, dependencies: { '@pip/app': 'workspace:*' } }),
    'packages/broken/package.json': json({ name: '@pip/broken', exports: './dist/index.js' }),
    'packages/deep/package.json': json({ name: '@pip/deep', exports: { '.': './src/d0.ts' } }),
    'packages/lost/package.json': json({ name: '@pip/lost', module: './src/index.mjs' }),
    'packages/lost/src/index.mjs': "export * from './x.mjs';\n",
  };
  for (let i = 0; i < 12; i++) files[`packages/core/src/a/m${i}.ts`] = `export const m${i} = ${i};\n`;
  for (let i = 0; i < 10; i++) files[`packages/core/src/b/n${i}.ts`] = `export const n${i} = ${i};\n`;
  // A chain of re-exports 12 deep: past the walk's 8 levels.
  for (let i = 0; i < 12; i++) files[`packages/deep/src/d${i}.ts`] = `export * from './d${i + 1}.ts';\n`;
  files['packages/deep/src/d12.ts'] = 'export const end = 1;\n';
  // Docs, so the core package isn't most of the repo.
  for (let i = 0; i < 60; i++) files[`docs/page-${i}.md`] = `# Page ${i}\n`;
  return files;
};

describe('graph 2: export paths, from outside', () => {
  const { g, batches } = graphs(barrelRepo(), { unreadable: ['packages/lost/src/index.mjs'] });

  it('follows `export *` and `export { } from` chains through the package, leaving type-only re-exports out', () => {
    const core = node(g, '@pip/core#.')!;
    assert.equal(core.file, 'packages/core/src/index.ts');
    // a/index, b, c, 12 m's and 10 n's; not types.ts, which only `export type` names, nor helper.ts, which c.ts only imports.
    assert.equal(core.reexports, 25);
    assert.equal(core.stars, 2);
    assert.equal(core.barrel, true);
    assert.equal(core.root, true);
  });

  it('maps a build-output target to its source, by the dist → src convention, and says it guessed', () => {
    assert.equal(node(g, '@pip/core#.')!.guessed, true);
  });

  it('takes conditions in document order, the first with a tracked file', () => {
    assert.equal(node(g, '@pip/core#./util')!.file, 'packages/core/src/util-node.ts');
  });

  it('counts overload as re-exported modules × importing packages, with the packages behind it directly or not', () => {
    const core = node(g, '@pip/core#.')!;
    assert.deepEqual(core.importedBy, { packages: 3, files: null });
    assert.equal(core.overload, 75);
    // app, web and cli import it; site imports app.
    assert.equal(core.dependents, 4);
    assert.deepEqual(g.exports.worst, { id: '@pip/core#.', reexports: 25, importerPackages: 3, overload: 75, dependents: 4, packagesOf: 9, share: 0.4444 });
  });

  it('flags the overloaded entry and the root barrel, with their numbers and the threshold crossed', () => {
    const over = g.exports.flags.find((f) => f.kind === 'overloaded-entry')!;
    assert.equal(over.subject, '@pip/core#.');
    assert.deepEqual(over.numbers, { reexports: 25, importerPackages: 3, overload: 75, dependents: 4, packagesOf: 9 });
    assert.deepEqual(over.threshold, { reexports: 20, importerPackages: 3 });
    assert.ok(g.exports.flags.some((f) => f.kind === 'root-barrel' && f.subject === '@pip/core#.'));
    assert.equal(g.exports.flags.filter((f) => f.kind === 'overloaded-entry').length, 1);
  });

  it('keeps a `./*` pattern as one entry with the files it matches, unwalked, and leaves a `null` key out', () => {
    const icons = node(g, '@pip/core#./icons/*')!;
    assert.equal(icons.pattern, './icons/*');
    assert.equal(icons.subpaths, 2);
    assert.equal(icons.reexports, null);
    assert.equal(node(g, '@pip/core#./internal/*'), undefined);
  });

  it("marks an entry that resolves to no tracked file unknown, with why", () => {
    const broken = node(g, '@pip/broken#.')!;
    assert.equal(broken.file, null);
    assert.equal(broken.reexports, null);
    assert.match(broken.unknown!, /build output that isn't in the tree/);
  });

  it('marks an entry the depth bound cuts unknown, with what it found before the cut', () => {
    const deep = node(g, '@pip/deep#.')!;
    assert.equal(deep.reexports, null);
    assert.equal(deep.reexportsAtLeast, 9);
    assert.match(deep.unknown!, /d9\.ts, which it re-exports: the walk stops 8 re-exports deep/);
  });

  it('lets a failed read cost that entry alone', () => {
    const lost = node(g, '@pip/lost#.')!;
    assert.equal(lost.reexports, null);
    assert.match(lost.unknown!, /packages\/lost\/src\/index\.mjs: GitHub answered: Something went wrong/);
    assert.equal(node(g, '@pip/core#.')!.reexports, 25);
    assert.match(g.exports.unknown.join('\n'), /3 entries of 7 unknown/);
  });

  it('reads the entry files and task configs in one batch, then one batch per level of re-exports, and the manifests from memory', () => {
    assert.equal(batches[0]!.includes('turbo.json'), true);
    assert.equal(batches[0]!.includes('packages/core/src/index.ts'), true);
    assert.equal(batches.some((b) => b.some((p) => p.endsWith('package.json'))), false);
    // Level 0, then a/ b/ c, then their modules, then d1 … d8.
    assert.equal(batches.length, 9);
    assert.equal(g.read.files, batches.flat().length);
  });

  it("maps a single package's root `dist/` to `src/` too", () => {
    const { g: single } = graphs({
      'package.json': json({ name: 'solo', exports: { '.': { types: './dist/types/index.d.ts', import: './dist/index.js' }, './jsx': './dist/jsx/index.js' } }),
      'src/index.ts': "export * from './jsx/index.ts';\n",
      'src/jsx/index.ts': 'export const jsx = 1;\n',
    });
    assert.equal(node(single, 'solo#.')!.file, 'src/index.ts');
    assert.equal(node(single, 'solo#./jsx')!.file, 'src/jsx/index.ts');
    assert.equal(node(single, 'solo#.')!.reexports, 1);
  });

  it('stops at the files bound, marking what it cut', () => {
    const { g: small } = graphs(barrelRepo(), { limits: { files: 10 } });
    const core = node(small, '@pip/core#.')!;
    assert.equal(core.reexports, null);
    assert.match(core.unknown!, /the walk reads at most 10 files/);
    assert.ok(small.read.files <= 10);
  });
});

describe('graph 4: tasks', () => {
  it('reads Turborepo: tasks per package script, dependsOn edges, and tasks with no inputs or wide ones', () => {
    const { g } = graphs(barrelRepo());
    assert.deepEqual(g.tasks.runners, ['turbo', 'script']);
    const ids = g.tasks.nodes.map((n) => n.id);
    assert.ok(ids.includes('@pip/core#build') && ids.includes('@pip/app#test'));
    assert.ok(g.tasks.edges.some((e) => e.from === '@pip/app#build' && e.to === '@pip/core#build' && e.how === 'dependencies'));
    assert.ok(g.tasks.edges.some((e) => e.from === '@pip/core#test' && e.to === '@pip/core#build' && e.how === 'dependsOn'));
    const kinds = (kind: string) => g.tasks.flags.filter((f) => f.kind === kind).map((f) => f.subject).sort();
    assert.deepEqual(kinds('no-inputs'), ['@pip/app#test', '@pip/core#lint', '@pip/core#test']);
    assert.deepEqual(kinds('wide-inputs'), ['@pip/core#typecheck']);
    assert.equal(g.tasks.count.trackedFiles, Object.keys(barrelRepo()).length);
  });

  it('reads an Nx workspace: project.json targets with nx.json defaults and named inputs', () => {
    const { g } = graphs({
      'package.json': json({ name: 'nxroot', private: true, devDependencies: { nx: '19.0.0' } }),
      'nx.json': json({ namedInputs: { default: ['{projectRoot}/**/*'], prod: ['default', '!{projectRoot}/**/*.spec.ts'] }, targetDefaults: { build: { dependsOn: ['^build'], inputs: ['prod'], cache: true }, test: { cache: true } } }),
      'libs/core/project.json': json({ name: 'core', targets: { build: {}, test: {} } }),
      'libs/core/src/index.ts': 'export const x = 1;\n',
      'apps/web/project.json': json({ name: 'web', targets: { build: {}, test: {}, serve: { cache: false } } }),
      'apps/web/src/main.ts': 'export {};\n',
    });
    assert.deepEqual(g.tasks.runners, ['nx']);
    const build = g.tasks.nodes.find((n) => n.id === 'core#build')!;
    assert.deepEqual(build.inputs, { mode: 'declared', globs: ['libs/core/**/*', '!libs/core/**/*.spec.ts'], files: 2 });
    assert.deepEqual(g.tasks.flags.filter((f) => f.kind === 'no-inputs').map((f) => f.subject).sort(), ['core#test', 'web#test']);
    assert.equal(g.tasks.count.cached, 4);
  });

  it('reads a repo with no task runner as its package scripts, none cached, with nothing to flag', () => {
    const { g } = graphs({
      'package.json': json({ name: 'solo', main: 'index.js', scripts: { test: 'node --test', build: 'tsc', prebuild: 'rm -rf dist' } }),
      'index.js': 'module.exports = {};\n',
    });
    assert.deepEqual(g.tasks.runners, ['script']);
    assert.equal(g.tasks.count.nodes, 3);
    assert.equal(g.tasks.count.cached, 0);
    assert.ok(g.tasks.edges.some((e) => e.from === 'solo#build' && e.to === 'solo#prebuild' && e.how === 'lifecycle'));
    assert.deepEqual(g.tasks.flags, []);
    assert.deepEqual(node(g, 'solo#.'), { id: 'solo#.', pkg: 'solo', key: '.', root: true, importedBy: { packages: 0, files: null }, dependents: 0, loads: null, file: 'index.js', reexports: 0, stars: 0, barrel: false, overload: 0 });
    assert.match(graphsBlock(g), /nothing is cached, so no task runner keys these/);
  });
});

/** A Turborepo workspace of packages `app`, `ui` and `core`, with these scripts and this turbo.json. */
const turboRepo = (turbo: object, scripts: Record<string, Record<string, string>>, more: Record<string, string> = {}) => {
  const deps: Record<string, string[]> = { app: ['ui'], ui: ['core'], core: [] };
  const files: Record<string, string> = {
    'package.json': json({ name: 'root', private: true, workspaces: ['packages/*'], scripts: scripts.root ?? {} }),
    'turbo.json': json(turbo),
    ...more,
  };
  for (const name of ['app', 'ui', 'core'])
    files[`packages/${name}/package.json`] = json({ name, private: true, dependencies: Object.fromEntries(deps[name]!.map((d) => [d, 'workspace:*'])), scripts: scripts[name] ?? {} });
  for (const name of ['app', 'ui', 'core']) files[`packages/${name}/src/index.ts`] = 'export {};\n';
  return graphs(files).g;
};
const task = (g: ReturnType<typeof graphs>['g'], id: string) => g.tasks.nodes.find((n) => n.id === id);
const edgesFrom = (g: ReturnType<typeof graphs>['g'], id: string) => g.tasks.edges.filter((e) => e.from === id).map((e) => e.to).sort();

describe('graph 4: tasks, as each runner reads its config', () => {
  it("lets Turborepo's `pkg#task` replace the generic task, its dependsOn and inputs with it", () => {
    const g = turboRepo(
      { tasks: { build: { dependsOn: ['^build'], inputs: ['src/**'] }, 'app#build': { dependsOn: ['//#prep'], inputs: ['lib/**'] }, '//#prep': {} } },
      { root: { prep: 'node prep.js' }, app: { build: 'tsc' }, ui: { build: 'tsc' }, core: { build: 'tsc' } },
    );
    assert.deepEqual(edgesFrom(g, 'app#build'), ['root#prep']);
    assert.deepEqual(task(g, 'app#build')!.inputs.globs, ['packages/app/lib/**']);
    assert.deepEqual(edgesFrom(g, 'ui#build'), ['core#build']);
  });

  it('follows `^build` through a package with no build script to the packages behind it, as Turborepo does', () => {
    const g = turboRepo({ tasks: { build: { dependsOn: ['^build'] } } }, { app: { build: 'tsc' }, core: { build: 'tsc' } });
    assert.deepEqual(edgesFrom(g, 'app#build'), ['core#build']);
    assert.equal(task(g, 'ui#build'), undefined);
  });
});

describe('the graphs in the report', () => {
  const { g } = graphs(barrelRepo());

  it('puts the flags first, then a line per graph, and graph 3 points at scripts/graph/', () => {
    const lines = graphsBlock(g).split('\n');
    assert.equal(lines[0], 'Graphs (guide section 21; flags first):');
    assert.match(lines[1]!, /^ {2}⚠ Export paths +@pip\/core#\. re-exports 25 modules to 3 packages \(overload 75\); 4 of 9 packages depend on it, directly or not$/);
    assert.match(lines[2]!, /^ {2}⚠ Tasks +2 cached tasks with no declared inputs, such as @pip\/app#test, @pip\/core#test: the runner keys every file of the package, so any change there misses; 1 cached task with empty inputs, @pip\/core#lint: /);
    assert.ok(lines.some((l) => /^ {2}3 Layers +run `scripts\/graph\/` for layers and what triggers what$/.test(l)));
    assert.ok(lines.some((l) => /^ {2}2 Export paths +7 entries in 5 of 9 npm packages: 2 shared root barrels, 3 with `export \*`, 1 overloaded/.test(l)));
  });

  it('gives the <ci-report> block one line per flag, at most three', () => {
    const lines = graphPromptLines(g);
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /^Graph flag, export paths: @pip\/core#\. re-exports 25 modules/);
  });

  it('turns flags into fixes linked to section 21', () => {
    const fixes = graphsFixes(g);
    assert.match(fixes[0]!.text, /^Split @pip\/core#\.: it re-exports 25 modules to 3 packages/);
    assert.equal(fixes[0]!.page, '21-optimize-all-of-your-graphs.md#export-paths-what-an-edit-triggers');
    assert.ok(fixes.some((f) => f.page === '21-optimize-all-of-your-graphs.md#workspace-tasks'));
  });
});

describe('graphs read through GitHub', () => {
  it('reads the entry files and the re-exported modules in GraphQL batches by blob id, the manifests not again', () => {
    const REPO = 'pip/app';
    const files: Record<string, string> = {
      'package.json': json({ name: '@pip/core', exports: './src/index.ts' }),
      'src/index.ts': "export * from './a.ts';\nexport * from './b.ts';\n",
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': "export * from './c.ts';\n",
      'src/c.ts': 'export const c = 1;\n',
    };
    const routes: Routes = { [`repos/${REPO}/git/trees/main`]: { status: 200, json: { tree: Object.keys(files).map((path) => ({ path, type: 'blob', size: files[path]!.length, sha: blobSha(path) })) } } };
    for (const [p, raw] of Object.entries(files)) routes[`repos/${REPO}/contents/${p}?ref=main`] = { status: 200, raw };
    withStub(routes, {}, (log) => {
      const gh = new Gh();
      const source = remembered(githubSource(gh, REPO, 'main'));
      const stack = stackOf({ source, manifestPaths: manifestPaths(source.tree), workflows: { texts: [], complete: true }, languages: undefined, packages: { npm: 1 }, runners: undefined });
      const before = log().filter((c) => c.includes('graphql')).length;
      const g = graphsOf({ source, stack });
      const queries = log().filter((c) => c.includes('graphql')).slice(before);
      // src/index.ts; then a.ts and b.ts; then c.ts.
      assert.equal(queries.length, 3);
      assert.equal(g.exports.nodes[0]!.reexports, 3);
    });
  });
});
