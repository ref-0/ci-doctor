/**
 * graph.ts's tests, on fixture workspaces copied into temporary Git repos: exports conditions, a
 * barrel and its overload, cycles between packages and folders, a layer violation, the task graph,
 * and replayed commits. `node --test graph.test.ts`, from this folder.
 */
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { headline, readable, report } from '../graph.ts';
import { DEFAULT_TESTS, globList, parseModule } from '../read.ts';
import { scriptCalls } from '../tasks.ts';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const made: string[] = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Pip', '-c', 'user.email=pip@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A fixture as a repo on `main` with one commit, then each change as a commit of its own. */
const repo = (fixture: string, changes: ReadonlyArray<Readonly<Record<string, string>>> = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-test-'));
  made.push(dir);
  cpSync(join(fixtures, fixture), dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'start');
  for (const change of changes) {
    for (const [path, text] of Object.entries(change)) writeFileSync(join(dir, path), text);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'change');
  }
  return dir;
};

const layers = JSON.parse(readFileSync(join(fixtures, 'mono-layers.json'), 'utf8'));
const options = { tests: DEFAULT_TESTS, conditions: [] as string[], rev: 'main', commits: 0 };

describe('imports', () => {
  it('reads each kind, and none from comments or multi-line strings', () => {
    const parsed = parseModule([
      "// import nope from 'comment'",
      "import a from './a.ts';",
      "import type { T } from './t.ts';",
      "import { type U } from './u.ts';",
      "export * from './star.ts';",
      "export { b } from './b.ts';",
      "export const c = 'not-an-import';",
      'const sample = `',
      "import fake from 'fake'",
      '`;',
      "const lazy = import('./lazy.ts');",
      'const computed = import(name);',
      "const url = new URL('./w.wasm', import.meta.url);",
      "const pages = import.meta.glob('./pages/*.ts');",
    ].join('\n'));
    deepStrictEqual(parsed.specs.map((s) => `${s.kind} ${s.spec}`), [
      'static ./a.ts', 'type ./t.ts', 'type ./u.ts', 'star ./star.ts', 'reexport ./b.ts', 'dynamic ./lazy.ts', 'url ./w.wasm', 'glob ./pages/*.ts',
    ]);
    strictEqual(parsed.computed, 1);
    strictEqual(parseModule("export * from './a.ts';\nexport { b } from './b.ts';\n").barrel, true);
    strictEqual(parsed.barrel, false);
  });

  it('matches globs with exclusions in order', () => {
    const match = globList(['src/**', '!src/**/*.test.ts']);
    deepStrictEqual(['src/a.ts', 'src/x/a.test.ts', 'lib/a.ts'].map(match), [true, false, false]);
  });
});

describe('the four graphs, measured', () => {
  const dir = repo('mono');
  const r = report(dir, { ...options, layers });

  it('reads a pnpm workspace and counts what it could not resolve', () => {
    strictEqual(r.repo.workspace, 'pnpm');
    strictEqual(r.denominators.packages, 4);
    strictEqual(r.denominators.tests, 4);
    deepStrictEqual(Object.fromEntries(Object.entries(r.unresolved.reasons).map(([k, v]) => [k, v!.count])), { computed: 1, missing: 1 });
    strictEqual(r.unresolved.specifiers.external, 1);
    strictEqual(r.unresolved.specifiers.builtin, 1);
  });

  it('1: finds the manifest cycle between packages, and each package\'s depth', () => {
    deepStrictEqual(r.packages.flags.map((f) => `${f.kind} ${f.subject}`), ['package-cycle @pip/app ↔ @pip/ui']);
    strictEqual(r.packages.nodes.find((n) => n.id === '@pip/core')!.importedBy.packages, 2);
    strictEqual(r.packages.depth, 1);
  });

  it('2: resolves exports conditions in document order, or as asked', () => {
    const edge = (rr: typeof r) => rr.exports.nodes.find((n) => n.id === '@pip/core#./util')!.file;
    strictEqual(r.exports.nodes.find((n) => n.id === '@pip/core#.')!.file, 'packages/core/src/index.ts');
    strictEqual(edge(r), 'packages/core/src/util-node.ts');
    strictEqual(edge(report(dir, { ...options, conditions: ['import'] })), 'packages/core/src/util.ts');
  });

  it('2: measures the barrel\'s export-path overload, and the entry nothing imports', () => {
    const root = r.exports.nodes.find((n) => n.id === '@pip/core#.')!;
    deepStrictEqual({ barrel: root.barrel, stars: root.stars, reexports: root.reexports, packages: root.importedBy.packages, overload: root.overload }, { barrel: true, stars: 2, reexports: 3, packages: 2, overload: 6 });
    deepStrictEqual(r.exports.flags.filter((f) => f.kind === 'unused-entry').map((f) => f.subject), ['@pip/core#./unused']);
    const widest = r.exports.flags.find((f) => f.kind === 'wide-file')!;
    strictEqual(widest.subject, 'packages/core/src/a/helper.ts');
    deepStrictEqual(widest.numbers, { files: 10, filesOf: 15, packages: 3, packagesOf: 4, tests: 3, testsOf: 4 });
  });

  it('3: finds the folder cycle, and the import that goes against declared layers', () => {
    deepStrictEqual(r.layers.flags.map((f) => `${f.kind} ${f.subject}`), ['folder-cycle packages/core/src: a ↔ b', 'layer-violation packages/core/src: a → b']);
    const proposed = report(dir, options);
    deepStrictEqual(proposed.layers.flags.map((f) => f.kind), ['folder-cycle']);
    deepStrictEqual(proposed.layers.nodes.filter((n) => n.source === 'packages/core/src').map((n) => `${n.place}:${n.layer}`).sort(), ['a:0', 'b:0', 'index:1', 'util-node:0', 'util:0']);
  });

  it('4: expands turbo\'s tasks over packages, and flags missing and empty inputs', () => {
    deepStrictEqual(r.tasks.runners, ['turbo', 'script']);
    deepStrictEqual(r.tasks.edges.filter((e) => e.from === '@pip/app#build').map((e) => e.to).sort(), ['@pip/core#build', '@pip/ui#build']);
    deepStrictEqual(r.tasks.flags.filter((f) => f.kind === 'no-inputs').map((f) => f.subject), ['@pip/app#test', '@pip/core#lint', '@pip/core#test', '@pip/ui#test']);
    deepStrictEqual(r.tasks.flags.filter((f) => f.kind === 'task-cycle').map((f) => f.subject), ['@pip/app#build ↔ @pip/ui#build']);
    ok(r.tasks.edges.some((e) => e.from === 'mono#test' && e.to === '@pip/core#test' && e.how === 'fan-out'));
    strictEqual(r.tasks.nodes.find((n) => n.id === '@pip/core#build')!.inputs.files, 7);
  });

  it('prints a headline line per graph, in order', () => {
    const lines = headline(r);
    deepStrictEqual(lines.slice(2).map((l) => l.split(':')[0]), ['1 Packages', '2 Exports', '3 Layers', '4 Tasks']);
    ok(readable(r).includes('## 4. Tasks'));
  });
});

describe('what a change triggers', () => {
  const dir = repo('mono', [
    { 'packages/core/src/util.ts': "export const util = 'two';\n" },
    { 'packages/core/src/b/three.ts': 'export const three = 33;\n' },
    { 'NOTES.md': '# Notes\n' },
    { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" },
  ]);
  const r = report(dir, { ...options, conditions: ['import'], commits: 10 });
  const commits = r.replay!.perCommit;

  it('replays each first-parent commit, oldest first', () => {
    strictEqual(r.replay!.commits, 4);
    strictEqual(r.replay!.asked, 10);
  });

  it('reaches a module\'s importers across packages through the entry, not the whole package', () => {
    const [util] = commits;
    deepStrictEqual(util!.reached, { files: 6, packages: 3, entries: 3, tests: 3 });
    strictEqual(util!.packageLevelTests, 4);
    deepStrictEqual(util!.through, ['@pip/core#./util', '@pip/app#.']);
    deepStrictEqual(util!.tasks, { touched: 2, withDependents: 6 });
  });

  it('counts commits whose reach went through each entry', () => {
    deepStrictEqual(r.exports.replay!.through, { '@pip/app#.': 2, '@pip/core#./util': 1, '@pip/core#.': 1 });
    const flag = r.exports.flags.find((f) => f.kind === 'overloaded-entry');
    strictEqual(flag, undefined);
  });

  it('reaches nothing for docs, and everything for the lockfile', () => {
    deepStrictEqual(commits[2]!.reached, { files: 0, packages: 0, entries: 0, tests: 0 });
    strictEqual(commits[3]!.everything, true);
    strictEqual(commits[3]!.widest!.path, 'pnpm-lock.yaml');
    deepStrictEqual(r.replay!.everything, { count: 1, of: 4 });
  });

  it('reports quantiles by nearest rank', () => {
    deepStrictEqual(r.exports.replay!.tests, { p50: 0.75, p90: 1 });
  });
});

describe('a single package with Vite+ tasks and scripts', () => {
  const r = report(repo('single'), options);

  it('reads it as one package', () => {
    strictEqual(r.repo.workspace, 'single');
    strictEqual(r.denominators.packages, 1);
    deepStrictEqual(r.exports.nodes.map((n) => [n.id, n.barrel, n.reexports]), [['mo#.', true, 1]]);
  });

  it('reads Vite+ tasks, scripts that call each other, and pre scripts', () => {
    deepStrictEqual(r.tasks.runners, ['vite-plus', 'script']);
    const edges = r.tasks.edges.map((e) => `${e.from.slice(3)} ${e.how} ${e.to.slice(3)}`).sort();
    deepStrictEqual(edges, ['all calls build', 'all calls test', 'build lifecycle postbuild', 'build lifecycle prebuild', 'check calls build', 'check calls test', 'docs dependsOn types', 'types dependsOn gen']);
    const inputs = Object.fromEntries(r.tasks.nodes.filter((n) => n.cached).map((n) => [n.name, n.inputs.mode]));
    deepStrictEqual(inputs, { docs: 'auto', gen: 'empty', types: 'declared' });
    strictEqual(r.tasks.depth, 3);
    deepStrictEqual(r.tasks.flags.map((f) => `${f.kind} ${f.subject}`), ['no-inputs mo#gen']);
  });
});

describe('script commands', () => {
  it('names the scripts a command runs, and which run in every package', () => {
    deepStrictEqual(scriptCalls('pnpm run build && yarn lint; npm test; pnpm install'), [{ name: 'build', recursive: false }, { name: 'lint', recursive: false }, { name: 'test', recursive: false }]);
    deepStrictEqual(scriptCalls('pnpm -r --filter ./packages/* test'), [{ name: 'test', recursive: true }]);
    deepStrictEqual(scriptCalls('turbo run build lint'), [{ name: 'build', recursive: true }, { name: 'lint', recursive: true }]);
    deepStrictEqual(scriptCalls('nx run-many -t build,test'), [{ name: 'build', recursive: true }, { name: 'test', recursive: true }]);
    deepStrictEqual(scriptCalls('run-s clean build:*'), [{ name: 'clean', recursive: false }, { name: 'build:*', recursive: false }]);
  });
});

describe('an Nx workspace of project.json projects', () => {
  const r = report(repo('nx'), options);
  const task = (id: string) => r.tasks.nodes.find((n) => n.id === id)!;

  it('infers project dependencies from imports, through tsconfig paths', () => {
    deepStrictEqual(r.tasks.edges.map((e) => `${e.from} ${e.how} ${e.to}`).sort(), ['web#build dependencies core#build', 'web#serve dependsOn web#build']);
  });

  it('expands named inputs, `^` inputs over dependencies, and workspace files', () => {
    deepStrictEqual(task('core#build').inputs.globs, ['libs/core/**/*', '!libs/core/**/*.spec.ts']);
    deepStrictEqual(task('web#build').inputs.globs, ['apps/web/**/*', '!apps/web/**/*.spec.ts', 'libs/core/**/*', '!libs/core/**/*.spec.ts']);
    strictEqual(task('core#test').inputs.files, 5);
    deepStrictEqual(r.tasks.flags.filter((f) => f.kind === 'no-inputs').map((f) => f.subject), ['core#lint']);
    strictEqual(task('web#serve').cached, false);
  });
});
