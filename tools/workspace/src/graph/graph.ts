/**
 * The declared package graph, and the folder layers inside a package, as pure checks over the
 * imports the command read. `command.ts` reads the workspace and prints what these return.
 *
 * - **The package graph.** Each package and app names what it may import of the others, by
 *   package and by entry point (an `exports` key without its `./`, `.` for the root, a pattern's
 *   folder for `./vectors/*.json`), and how: `values`, anything; `types`, only `import type`, which
 *   loads nothing; `tests`, anything, but only from tests and the `testing/` modules they share.
 *   Nothing imports an app. A relative path out of a package fails even into an allowed one, so
 *   every import goes through the target's `exports`, as a build does.
 * - **Folder layers.** A source folder's places (a folder, or a file at its top without its
 *   extension) stack from the bottom. A file imports its own place and any place in a layer below,
 *   never one beside or above. Tests are leaves nothing imports, so they import anything. Imports
 *   that break the layers when they're first written are exceptions, by file and module, and an
 *   exception no import needs fails, so the list only shrinks.
 *
 * Runs: imported by `command.ts`, and by the tests.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { posix } from 'node:path';

export type How = 'values' | 'types' | 'tests';

export const hows: ReadonlyArray<How> = ['values', 'types', 'tests'];

/** The entry points of one package another may import, by how. */
export type Edge = { readonly [Kind in How]?: ReadonlyArray<string> };

/** `package-graph.json`: the contract the command holds the workspace to. */
export interface Declared {
  /** Each package and app by name, to what it may import of the others. Every one is listed. */
  readonly graph: Readonly<Record<string, Readonly<Record<string, Edge>>>>;
  /** Files that run only in Node, by package, from its folder: they take values on a types edge. */
  readonly nodeFiles?: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Each source folder from the root, to its places' layers from the bottom. */
  readonly layers?: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>>;
  /** Imports allowed against the layers, by source, then file from it, to modules from it. */
  readonly layerExceptions?: Readonly<Record<string, Readonly<Record<string, ReadonlyArray<string>>>>>;
}

/** A workspace package: its folder from the root, and what the checks read of its manifest. */
export interface Package {
  readonly name: string;
  readonly directory: string;
  readonly app: boolean;
  readonly exports: ReadonlyArray<string>;
  readonly dependencies: ReadonlySet<string>;
}

/** One import a file makes: what it names, whether it loads nothing, and its line. */
export interface Import {
  readonly source: string;
  readonly typesOnly: boolean;
  readonly line: number;
}

/** A tracked source file and its imports. */
export interface SourceFile {
  readonly path: string;
  readonly imports: ReadonlyArray<Import>;
}

/** A finding, at a file and line when it has one. */
export interface Problem {
  readonly at: string;
  readonly line?: number;
  readonly message: string;
}

export const graphFile = 'package-graph.json';

const testFile = /\.(test|spec)(-d)?\.[cm]?[jt]sx?$/;

/** Code only tests run: a test, or a module in a `testing/` folder tests share. */
const testCode = (path: string) => testFile.test(path) || /\/testing\/[^/]+$/.test(path);

/** The package that holds a path: the deepest whose folder it's in. */
export const ownerOf = (path: string, packages: ReadonlyArray<Package>) =>
  packages
    .filter(({ directory }) => path.startsWith(`${directory}/`))
    .toSorted((a, b) => b.directory.length - a.directory.length)[0];

/** The workspace package an import names, such as `@pip/ui` for `@pip/ui/cast`. */
const packageNamed = (source: string, byName: ReadonlyMap<string, Package>) => {
  const parts = source.split('/');
  const name = source.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');

  return byName.get(name);
};

const matches = (pattern: string, subpath: string) => {
  const [before = '', after = ''] = pattern.split('*');

  return subpath.startsWith(before) && subpath.endsWith(after);
};

/** The entry point of `to` an import names: `cast`, `.`, `base.css` for `base.css?raw`, a pattern's folder. */
export const entryNamed = (to: Package, source: string) => {
  const subpath = `.${source.replace(/\?.*$/, '').slice(to.name.length)}`;
  const pattern = to.exports.find((key) => key.includes('*') && matches(key, subpath));
  const entry = pattern === undefined ? subpath : pattern.slice(0, pattern.indexOf('/*'));

  return entry === '.' ? entry : entry.slice(2);
};

/** Whether `to` exports `entry`, as the graph writes it. */
const exported = (to: Package, entry: string) =>
  to.exports.some((key) => key === (entry === '.' ? '.' : `./${entry}`) || key.startsWith(`./${entry}/*`));

const shown = (to: string, entry: string) => (entry === '.' ? to : `${to}/${entry}`);

const listed = (edge: Edge) =>
  hows
    .flatMap((how) => edge[how] ?? [])
    .toSorted()
    .map((entry) => `\`${entry}\``)
    .join(', ');

/** What's wrong with the graph itself: names, apps, entries and manifests. */
export const graphProblems = (declared: Declared, packages: ReadonlyArray<Package>): ReadonlyArray<Problem> => {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const found: Array<Problem> = [];

  for (const pkg of packages) {
    if (declared.graph[pkg.name] === undefined) {
      found.push({ at: graphFile, message: `${pkg.name} isn't in the graph. Add it, with {} if it imports no workspace package.` });
    }
  }

  for (const [from, edges] of Object.entries(declared.graph)) {
    const source = byName.get(from);
    if (source === undefined) {
      found.push({ at: graphFile, message: `${from} is no workspace package. Remove it.` });
      continue;
    }

    for (const [to, edge] of Object.entries(edges)) {
      const target = byName.get(to);
      if (target === undefined) {
        found.push({ at: graphFile, message: `${from}'s edge names ${to}, which is no workspace package.` });
        continue;
      }

      if (target.app) {
        found.push({ at: graphFile, message: `${from}'s edge names ${to}, an app. Nothing imports an app: move what it needs into a package.` });
        continue;
      }

      if (!source.dependencies.has(to)) {
        found.push({ at: `${source.directory}/package.json`, message: `${from} imports ${to} in the graph but doesn't list it as a dependency. Add it.` });
      }

      for (const entry of hows.flatMap((how) => edge[how] ?? [])) {
        if (!exported(target, entry)) {
          found.push({ at: graphFile, message: `${from}'s edge lists ${shown(to, entry)}, which ${to}'s exports don't have.` });
        }
      }
    }
  }

  return found;
};

/** What `file`, in `from`, breaks by importing `to` through `entry`, or by a relative path when there's none. */
const importProblem = (declared: Declared, from: Package, to: Package, entry: string | undefined, file: string, typesOnly: boolean) => {
  if (to.app) return `Nothing imports an app, and ${to.name} is one. Move what ${from.name} needs into a package.`;

  const edge = declared.graph[from.name]?.[to.name];
  if (edge === undefined) return `${from.name} doesn't import ${to.name}: ${graphFile} has no such edge.`;

  if (entry === undefined) return `This relative path leaves ${from.name} for ${to.name}. Import ${to.name} by its name, through its exports.`;

  const how = hows.find((kind) => edge[kind]?.includes(entry) === true);
  if (how === undefined) {
    return `${from.name} doesn't import ${shown(to.name, entry)}: its edge to ${to.name} lists ${listed(edge)}. To import another entry point, add it to that edge.`;
  }

  if (how === 'tests' && !testCode(file)) return `${from.name} imports ${shown(to.name, entry)} only in its tests, as ${graphFile} says.`;

  const nodeOnly = (declared.nodeFiles?.[from.name] ?? []).some((path) => `${from.directory}/${path}` === file);
  if (how === 'types' && !typesOnly && !testFile.test(file) && !nodeOnly) {
    return `${from.name} takes only types from ${shown(to.name, entry)}. Write \`import type\`, which loads nothing: \`import { type … }\` still loads it.`;
  }

  return undefined;
};

/** Each import across packages that the declared graph doesn't allow. */
export const importProblems = (
  declared: Declared,
  packages: ReadonlyArray<Package>,
  files: ReadonlyArray<SourceFile>,
): ReadonlyArray<Problem> => {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const found: Array<Problem> = [];

  for (const { path, imports } of files) {
    const from = ownerOf(path, packages);
    if (from === undefined) continue;

    for (const { source, typesOnly, line } of imports) {
      const relativePath = source.startsWith('.');
      const to = relativePath
        ? ownerOf(posix.join(posix.dirname(path), source.replace(/\?.*$/, '')), packages)
        : packageNamed(source, byName);
      if (to === from) continue;

      if (to === undefined) {
        if (relativePath) found.push({ at: path, line, message: `This relative path leaves ${from.name} for a file no package holds.` });
        continue;
      }

      const message = importProblem(declared, from, to, relativePath ? undefined : entryNamed(to, source), path, typesOnly);
      if (message !== undefined) found.push({ at: path, line, message });
    }
  }

  return found;
};

/** The module a path names, without its extension. */
const moduleNamed = (path: string) => path.replace(/\.[cm]?[jt]sx?$/, '');

const placeOf = (module: string) => module.split('/')[0] ?? module;

/** Each import inside a layered source that goes beside or above, and each exception no import needs. */
export const layerProblems = (declared: Declared, files: ReadonlyArray<SourceFile>): ReadonlyArray<Problem> => {
  const found: Array<Problem> = [];
  const used = new Set<string>();

  for (const [source, stack] of Object.entries(declared.layers ?? {})) {
    const rank = new Map(stack.flatMap((layer, at) => layer.map((place) => [place, at] as const)));
    const exceptions = declared.layerExceptions?.[source] ?? {};

    for (const { path, imports } of files) {
      if (!path.startsWith(`${source}/`) || testFile.test(path)) continue;

      const file = path.slice(source.length + 1);
      const from = placeOf(moduleNamed(file));

      for (const { source: imported, line } of imports) {
        if (!imported.startsWith('.')) continue;

        const target = posix.join(posix.dirname(path), imported.replace(/\?.*$/, ''));
        if (!target.startsWith(`${source}/`)) continue;

        const module = moduleNamed(target.slice(source.length + 1));
        const to = placeOf(module);
        if (from === to) continue;

        const fromRank = rank.get(from);
        const toRank = rank.get(to);
        if (fromRank === undefined || toRank === undefined) {
          found.push({ at: path, line, message: `${fromRank === undefined ? from : to} is in no layer of ${source}. Add it to the layer it belongs in.` });
          continue;
        }

        if (toRank < fromRank) continue;

        if (exceptions[file]?.includes(module) === true) {
          used.add(`${source}\0${file}\0${module}`);
          continue;
        }

        found.push({
          at: path,
          line,
          message:
            toRank === fromRank
              ? `${from} and ${to} sit in one layer of ${source}, so neither imports the other. Move what it needs down, or join the two from a place above both.`
              : `${from} sits below ${to} in ${source}, so it imports nothing of it. Move what it needs down, to where both can import it.`,
        });
      }
    }

    for (const [file, modules] of Object.entries(exceptions)) {
      for (const module of modules) {
        if (!used.has(`${source}\0${file}\0${module}`)) {
          found.push({ at: graphFile, message: `${source}'s exception for ${file} importing ${module} is no longer needed. Delete it.` });
        }
      }
    }
  }

  return found;
};

/**
 * The graph the workspace's imports draw today, for a first `package-graph.json`: each entry under
 * `tests` when only test code imports it, `types` when every import of it is `import type`, and
 * `values` otherwise. An edge to an app is drawn too, and the check then names it to move.
 */
export const currentGraph = (packages: ReadonlyArray<Package>, files: ReadonlyArray<SourceFile>) => {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const uses = new Map<string, Map<string, Map<string, Set<How>>>>();

  for (const { path, imports } of files) {
    const from = ownerOf(path, packages);
    if (from === undefined) continue;

    for (const { source, typesOnly } of imports) {
      const to = source.startsWith('.') ? undefined : packageNamed(source, byName);
      if (to === undefined || to === from) continue;

      const entries = uses.get(from.name) ?? new Map<string, Map<string, Set<How>>>();
      const kinds = entries.get(to.name) ?? new Map<string, Set<How>>();
      const entry = entryNamed(to, source);
      const seen = kinds.get(entry) ?? new Set<How>();

      seen.add(testCode(path) ? 'tests' : typesOnly ? 'types' : 'values');
      kinds.set(entry, seen);
      entries.set(to.name, kinds);
      uses.set(from.name, entries);
    }
  }

  const graph: Record<string, Record<string, Record<string, Array<string>>>> = {};

  for (const pkg of packages.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const edges: Record<string, Record<string, Array<string>>> = {};

    for (const [to, kinds] of [...(uses.get(pkg.name) ?? [])].toSorted(([a], [b]) => a.localeCompare(b))) {
      const edge: Record<string, Array<string>> = {};

      for (const [entry, seen] of [...kinds].toSorted(([a], [b]) => a.localeCompare(b))) {
        const how: How = seen.has('values') ? 'values' : seen.has('types') ? (seen.has('tests') ? 'values' : 'types') : 'tests';
        (edge[how] ??= []).push(entry);
      }

      edges[to] = Object.fromEntries(hows.flatMap((how) => (edge[how] === undefined ? [] : [[how, edge[how]] as const])));
    }

    graph[pkg.name] = edges;
  }

  return { graph };
};

/** Edges and entries the graph declares that no import uses, for tightening. */
export const unusedEntries = (declared: Declared, packages: ReadonlyArray<Package>, files: ReadonlyArray<SourceFile>) => {
  const { graph } = currentGraph(packages, files);
  const unused: Array<string> = [];

  for (const [from, edges] of Object.entries(declared.graph)) {
    for (const [to, edge] of Object.entries(edges)) {
      const now = graph[from]?.[to];
      if (now === undefined) {
        unused.push(`${from} -> ${to}`);
        continue;
      }

      const usedEntries = new Set(Object.values(now).flat());
      for (const entry of hows.flatMap((how) => edge[how] ?? [])) {
        if (!usedEntries.has(entry)) unused.push(`${from} -> ${shown(to, entry)}`);
      }
    }
  }

  return unused;
};
