/**
 * Holds the workspace to its declared package graph and folder layers, or prints the graph its
 * imports draw today.
 *
 *     node tools/workspace/src/bin.ts package-graph [--unused]
 *     node tools/workspace/src/bin.ts package-graph --generate > package-graph.json
 *
 * It reads `package-graph.json` at the root (see `graph.ts`), every `package.json` the
 * `packageGraph.packages` globs match, and the imports of each tracked `.ts`, `.tsx`, `.js` and
 * `.jsx` file in those packages. It fails, one line per finding with the file and line, on:
 *
 * - a package missing from the graph, an edge to an app, an entry the target doesn't export, or an
 *   edge whose package isn't in the importer's manifest;
 * - an import with no edge, through an entry its edge doesn't list, of a `tests` entry outside test
 *   code, or of a value on a `types` edge;
 * - a relative path out of its package, into another or into none;
 * - an import beside or above its place in a layered source, or a layer exception no import needs.
 *
 * `--unused` also lists the edges and entries no import uses, to tighten; they don't fail.
 * `--generate` prints the current graph as a first `package-graph.json`, and checks nothing.
 *
 * Runs: in CI's static job or as part of lint, and locally. Under GitHub Actions each finding is
 * also an annotation.
 * Configure: `packageGraph` in `workspace-tools.json`: the package globs, which of them are apps,
 * and the graph's file.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { env } from 'node:process';

import { currentGraph, graphProblems, importProblems, layerProblems, unusedEntries } from './graph.ts';
import type { Declared, Package, Problem, SourceFile } from './graph.ts';

export interface Options {
  /** Globs of folders that hold a `package.json`, from the root. */
  readonly packages: ReadonlyArray<string>;
  /** Globs of the folders among them that are apps, which nothing imports. */
  readonly apps: ReadonlyArray<string>;
  /** The declared graph, from the root. */
  readonly file: string;
}

const dependencyKinds = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const sourceFile = /\.[cm]?[jt]sx?$/;

/** The workspace's packages, from their manifests. */
export const readPackages = (root: string, { packages, apps }: Options): ReadonlyArray<Package> => {
  const folders = (globs: ReadonlyArray<string>) =>
    new Set(globs.flatMap((glob) => globSync(posix.join(glob, 'package.json'), { cwd: root })).map((path) => posix.dirname(path)));
  const appFolders = folders(apps);

  return [...folders(packages)]
    .filter((directory) => !directory.split('/').includes('node_modules'))
    .toSorted()
    .map((directory) => {
      const manifest = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'));
      const exports = manifest.exports;
      const keys = typeof exports === 'object' && exports !== null && Object.keys(exports).every((key) => key.startsWith('.')) ? Object.keys(exports) : ['.'];

      return {
        name: String(manifest.name),
        directory,
        app: appFolders.has(directory),
        exports: exports === undefined ? ['.'] : keys,
        dependencies: new Set(dependencyKinds.flatMap((kind) => Object.keys(manifest[kind] ?? {}))),
      };
    });
};

/** Each tracked source file in the packages, with its imports. */
const readFiles = async (root: string, packages: ReadonlyArray<Package>): Promise<ReadonlyArray<SourceFile>> => {
  const { importsOf } = await import('./imports.ts');
  const tracked = execFileSync('git', ['ls-files', '-z', '--', ...packages.map(({ directory }) => directory)], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
    .split('\0')
    .filter((path) => sourceFile.test(path) && !/(^|\/)(node_modules|dist)\//.test(path) && !path.endsWith('.d.ts'));

  return tracked.map((path) => ({ path, imports: importsOf(readFileSync(join(root, path), 'utf8'), path) }));
};

const print = (problem: Problem) => {
  const where = problem.line === undefined ? problem.at : `${problem.at}:${problem.line}`;
  console.error(`${where}: ${problem.message}`);

  if (env['GITHUB_ACTIONS'] === 'true') {
    console.log(`::error file=${problem.at}${problem.line === undefined ? '' : `,line=${problem.line}`}::${problem.message}`);
  }
};

export const packageGraph = async (root: string, options: Options, flags: { readonly generate: boolean; readonly unused: boolean }) => {
  const packages = readPackages(root, options);
  if (packages.length === 0) {
    console.error(`package-graph: no package.json in ${options.packages.join(' or ')}. Set packageGraph.packages in workspace-tools.json.`);

    return 1;
  }

  const files = await readFiles(root, packages);

  if (flags.generate) {
    console.log(JSON.stringify(currentGraph(packages, files), null, 2));

    return 0;
  }

  const path = join(root, options.file);
  if (!existsSync(path)) {
    console.error(`package-graph: no ${options.file}. Write the current one with --generate, then tighten it.`);

    return 1;
  }

  const declared: Declared = JSON.parse(readFileSync(path, 'utf8'));
  const found = [...graphProblems(declared, packages), ...importProblems(declared, packages, files), ...layerProblems(declared, files)];

  for (const problem of found) print(problem);

  if (flags.unused) {
    for (const edge of unusedEntries(declared, packages, files)) console.error(`unused: ${edge}`);
  }

  if (found.length > 0) return 1;

  console.error(`package-graph: ${packages.length} packages and ${files.length} files hold to ${options.file}`);

  return 0;
};
