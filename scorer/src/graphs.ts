// Guide section 21's five graphs, as far as the scorer sees them from outside: 1, the package graph, from the
// manifests the stack reads; 2, each npm package's export paths, from its `exports` and the entry files behind it,
// followed through their re-exports; 4, the workspace's tasks, from Turborepo, Nx, Vite+ and package scripts; 5, the
// CI job graph, from the job graph. Graph 3, layers inside a package, needs every file, so `scripts/graph/` measures it
// in a checkout. Each graph is `{ nodes, edges, flags }`, as `scripts/graph/`'s `--json` has them, and every count
// carries its denominator.
//
// Every file comes from the same GraphQL blob batches as the stack, at the tree's blob ids. The walk of re-exports is
// bounded, by depth and by files read; an entry the bound cuts, or whose file failed to read, is unknown, with why,
// and no failure stops the run.
import { posix } from 'node:path';
import {
  type Flag,
  type KeyMap,
  type Package,
  type PackageJson,
  type Parsed,
  depths,
  entryOf,
  excludes,
  exportKeys,
  fileFor,
  globToRegExp,
  keyMap,
  matchKey,
  MAX_MODULE_BYTES,
  MODULE,
  ownerOf,
  packagesOf,
  parseModule,
  pickBoth,
  readTaskGraph,
  REEXPORTS,
  taskFiles,
  targetsOf,
  taskShape,
  THRESHOLDS,
} from './graph-core.ts';
import { heavyBlocker, setupInPath, type JobGraph } from './job-graph.ts';
import type { Source } from './source.ts';
import type { Stack } from './stack.ts';
import { dirOf } from './workspace.ts';

/** Files the export walk and the task configs read at most, in all: ten GraphQL queries' worth. */
export const MAX_GRAPH_FILES = 1000;
/** Task config files read at most, of `MAX_GRAPH_FILES`: Nx's `project.json`s, mostly. */
export const MAX_TASK_FILES = 300;
/** Levels of re-exports followed from the entry files: an entry's chain deeper than this is cut. */
export const MAX_REEXPORT_DEPTH = 8;
/** Nodes and edges a graph lists at most; its counts say how many there are. */
export const MAX_LISTED = 300;
/** Input globs a listed task shows at most; `globsOf` says how many it has. */
const MAX_GLOBS = 12;
/** Flags of one kind a graph lists at most; `flagCounts` says how many there are. */
const MAX_FLAGS = THRESHOLDS.top;

export interface Limits {
  files: number;
  taskFiles: number;
  depth: number;
}

const LIMITS: Limits = { files: MAX_GRAPH_FILES, taskFiles: MAX_TASK_FILES, depth: MAX_REEXPORT_DEPTH };

const share = (n: number, of: number) => (of === 0 ? 0 : Math.round((n / of) * 10000) / 10000);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Flags kept to `MAX_FLAGS` a kind, with how many each kind had. */
const capped = (flags: Flag[]) => {
  const counts: Record<string, number> = {};
  const kept = flags.filter((f) => (counts[f.kind] = (counts[f.kind] ?? 0) + 1) <= MAX_FLAGS);
  return { flags: kept, flagCounts: counts };
};

const splitName = (spec: string) => {
  const parts = spec.split('/');
  const n = spec.startsWith('@') ? 2 : 1;
  return { name: parts.slice(0, n).join('/'), sub: parts.slice(n).join('/') };
};

// ---------- 1. packages ----------

const packagesGraph = (st: Stack) => {
  const g = st.graph;
  const key = (eco: string, name: string) => `${eco}:${name}`;
  const ids = g.packages.map((p) => key(p.ecosystem, p.name));
  const out = new Map(g.packages.map((p) => [key(p.ecosystem, p.name), p.internal.map((n) => key(p.ecosystem, n))]));
  const { depth, chain } = depths(ids, (id) => out.get(id) ?? []);
  const dependents = new Map<string, number>();
  for (const targets of out.values()) for (const t of targets) dependents.set(t, (dependents.get(t) ?? 0) + 1);
  const label = (id: string) => id.slice(id.indexOf(':') + 1);
  const nodes = g.packages.map((p) => {
    const id = key(p.ecosystem, p.name);
    return { id: p.name, dir: dirOf(p.path), ecosystem: p.ecosystem, dependencies: p.internal.length, dependents: dependents.get(id) ?? 0, depth: depth.get(id) ?? 0 };
  });
  nodes.sort((a, b) => b.dependents - a.dependents || a.id.localeCompare(b.id));
  const edges = g.packages.flatMap((p) => p.internal.map((to) => ({ from: p.name, to, ecosystem: p.ecosystem })));
  const flags: Flag[] = (g.cycles ?? []).map((c) => ({ kind: 'package-cycle', subject: c.packages.join(' ↔ '), numbers: { packages: c.packages.length, packagesOf: nodes.length }, threshold: null, detail: `${c.ecosystem} manifest dependencies` }));
  return {
    count: { nodes: g.count, edges: g.edges },
    nodes: nodes.slice(0, MAX_LISTED),
    edges: edges.slice(0, MAX_LISTED),
    ...capped(flags),
    depth: g.maxDepth,
    chain: g.count === null ? [] : chain.map((c) => c.split(' + ').map(label).join(' + ')),
    topFanIn: g.topFanIn,
    unknown: g.count === null ? ['Not every manifest, or a file that declares a workspace, was read, so packages or edges may be missing'] : [],
  };
};

// ---------- 2. export paths, and 4. tasks: one batch of entry files and task configs, then each level of re-exports ----------

export interface EntryNode {
  id: string;
  pkg: string;
  key: string;
  /** The `exports` pattern key, such as `./*`: each subpath it matches is an entry of its own, so it isn't walked. */
  pattern?: string;
  /** Tracked files a pattern's target matches. */
  subpaths?: number;
  file: string | null;
  root: boolean;
  /**
   * Other packages that import this entry. `packages` is exact when `exports` gives the package this one entry, so
   * each importer of the package imports it, or when each was seen importing it. Otherwise it's null: `atLeast` counts the packages seen importing this
   * entry in the files read, and `atMost` every package that imports the package, by manifests, an upper bound.
   * `files` needs the import graph.
   */
  importedBy: { packages: number | null; atLeast?: number; atMost?: number; files: null };
  /** Packages that depend on this one, directly or not: how far an edit behind this entry can reach. */
  dependents: number | null;
  /** Workspace modules it re-exports, directly or through `export *` and `export { } from` chains; null when unknown. */
  reexports: number | null;
  /** Re-exported modules found before the walk was cut, for an entry it cut. */
  reexportsAtLeast?: number;
  stars: number | null;
  barrel: boolean | null;
  /** Workspace files loading it loads: needs the import graph, so `scripts/graph/` has it. */
  loads: null;
  /** `reexports` × `importedBy.packages`, when both are exact. */
  overload: number | null;
  /** `reexports` × `importedBy.atLeast` and × `importedBy.atMost`, when the importers aren't exact. */
  overloadAtLeast?: number;
  overloadAtMost?: number;
  /** The file came by the `dist` → `src` convention. */
  guessed?: boolean;
  unknown?: string;
}

interface Inputs {
  source: Source;
  stack: Stack;
  jobGraph?: JobGraph | undefined;
  limits?: Partial<Limits>;
}

export const graphsOf = ({ source, stack, jobGraph, limits: given = {} }: Inputs) => {
  const limits = { ...LIMITS, ...given };
  const unknown: string[] = [];
  const blobs = source.tree.blobs;
  const tracked = new Set(blobs.map((b) => b.path));
  const sizeOf = new Map(blobs.map((b) => [b.path, b.size]));

  // The npm members of the package graph, from the manifests the stack read: the same reads, remembered.
  const members = stack.graph.packages.filter((p) => p.ecosystem === 'npm');
  const read0 = source.readMany(members.map((m) => m.path));
  const manifests = new Map<string, PackageJson>();
  const labelOfDir = new Map<string, string>();
  for (const m of members) {
    const text = read0.texts.get(m.path);
    let json: unknown;
    try {
      json = text === undefined ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (json === undefined || json === null || typeof json !== 'object') continue;
    const dir = dirOf(m.path);
    manifests.set(dir === '' ? '' : `${dir}/`, json as PackageJson);
    labelOfDir.set(dir === '' ? '' : `${dir}/`, m.name);
  }
  const packages = packagesOf(manifests);
  // Nx and Turborepo read the root's config even with no root package.json.
  if (!packages.some((p) => p.dir === '')) packages.push({ name: '(root)', dir: '', manifest: {}, deps: new Map() });
  const owner = (path: string) => ownerOf(path, packages);
  const byName = new Map(packages.filter((p) => p.manifest.name !== undefined).map((p) => [p.manifest.name!, p]));
  const exportMaps = new Map<Package, KeyMap>();
  const mapOf = (pkg: Package) => exportMaps.get(pkg) ?? exportMaps.set(pkg, keyMap(exportKeys(pkg.manifest))).get(pkg)!;
  const importMaps = new Map<Package, KeyMap>();
  const importsOf = (pkg: Package) => importMaps.get(pkg) ?? importMaps.set(pkg, keyMap(Object.entries(pkg.manifest.imports ?? {}))).get(pkg)!;

  // Who depends on whom, by the package graph's npm edges: directly, for overload, and in all, for reach.
  const npmCount = members.length;
  const graphKnown = stack.graph.count !== null;
  const directOf = new Map<string, Set<string>>();
  for (const m of members) for (const t of m.internal) (directOf.get(t) ?? directOf.set(t, new Set()).get(t)!).add(m.name);
  const allOf = (label: string) => {
    const seen = new Set<string>();
    const waiting = [...(directOf.get(label) ?? [])];
    for (let p = waiting.pop(); p !== undefined; p = waiting.pop()) if (!seen.has(p) && p !== label) (seen.add(p), waiting.push(...(directOf.get(p) ?? [])));
    return seen.size;
  };

  // The entries: each exact `exports` key, each pattern key, or `.` from `main`, `module` or `source`.
  interface Entry {
    pkg: Package;
    label: string;
    key: string;
    pattern?: string;
    subpaths?: number;
    file?: string;
    also?: ReadonlyArray<string>;
    guessed?: boolean;
    miss?: string;
  }
  const entries: Entry[] = [];
  for (const pkg of packages) {
    const label = labelOfDir.get(pkg.dir);
    if (label === undefined) continue;
    const keys = exportKeys(pkg.manifest);
    const m = pkg.manifest;
    const named = keys.size > 0 ? [...keys] : typeof m.main === 'string' || typeof m.module === 'string' || typeof m.source === 'string' ? [['.', null] as const] : [];
    for (const [key, target] of named) {
      if (keys.size > 0 && excludes(target)) continue;
      if (key.includes('*')) {
        const first = targetsOf(target!).find((t) => t.path.includes('*'));
        const re = first ? globToRegExp(posix.normalize(posix.join(pkg.dir, first.path)).replace(/\*/g, '**')) : undefined;
        entries.push({ pkg, label, key, pattern: key, subpaths: re ? blobs.filter((b) => re.test(b.path)).length : 0 });
        continue;
      }
      const r = entryOf(pkg, mapOf(pkg), key === '.' ? '' : key.replace(/^\.\//, ''), 'esm', tracked, []);
      if (r.unresolved !== undefined)
        entries.push({ pkg, label, key, miss: r.unresolved === 'built-only' ? "every target is build output that isn't in the tree, with no source beside it" : `it resolves to no tracked file (${r.unresolved})` });
      else entries.push({ pkg, label, key, file: r.file, ...(r.also ? { also: r.also } : {}), ...(r.guessed ? { guessed: true } : {}) });
    }
  }

  // What a re-export names: a file of this package by a relative path or `#` import, or another package's entry.
  // Undefined when it names a workspace file or entry that resolves to nothing; none for a package outside it.
  const resolveSpec = (from: string, spec: string): string[] | undefined => {
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const base = spec.startsWith('/') ? owner(from).dir + spec.slice(1) : posix.join(posix.dirname(from), spec);
      const f = fileFor(posix.normalize(base.split('?')[0]!), tracked);
      return f ? [f] : undefined;
    }
    if (spec.startsWith('#')) {
      const pkg = owner(from);
      const match = matchKey(importsOf(pkg), spec);
      if (!match || excludes(match.target)) return undefined;
      if (targetsOf(match.target).some((t) => t.path.startsWith('.'))) {
        const p = pickBoth(pkg.dir, match.target, match.star, tracked, [], 'esm');
        return p ? [p.file, ...(p.also ?? [])] : undefined;
      }
      const bare = targetsOf(match.target)[0]!.path;
      return resolveSpec(from, match.star === undefined ? bare : bare.replaceAll('*', match.star));
    }
    const { name, sub } = splitName(spec);
    const pkg = byName.get(name);
    if (!pkg) return [];
    const r = entryOf(pkg, mapOf(pkg), sub, 'esm', tracked, []);
    return r.unresolved === undefined ? [r.file, ...(r.also ?? [])] : undefined;
  };

  // Level 0 reads the entry files and the task configs in one batch; each next level, the modules the last re-exported.
  const parsed = new Map<string, Parsed>();
  const failed = new Map<string, string>();
  const cut = new Map<string, string>();
  const next = new Map<string, string[]>();
  /** A module's first re-export that names a workspace file or entry resolving to nothing. */
  const missed = new Map<string, string>();
  const configs = taskFiles(tracked, packages);
  const configsRead = configs.slice(0, limits.taskFiles);
  if (configs.length > limits.taskFiles) unknown.push(`Read the first ${limits.taskFiles} of ${configs.length} task config files`);
  let budget = limits.files - configsRead.length;
  let frontier = [...new Set(entries.flatMap((e) => (e.file ? [e.file, ...(e.also ?? [])] : [])))].filter((f) => MODULE.test(f));
  let texts = new Map<string, string>();
  let filesRead = 0;
  for (let level = 0; level === 0 || frontier.length > 0; level++) {
    if (level > limits.depth) {
      for (const f of frontier) cut.set(f, `the walk stops ${limits.depth} re-exports deep`);
      break;
    }
    const large = frontier.filter((f) => (sizeOf.get(f) ?? 0) > MAX_MODULE_BYTES);
    for (const f of large) failed.set(f, 'it is over 1 MiB, so not parsed');
    const wanted = frontier.filter((f) => !large.includes(f));
    const now = wanted.slice(0, Math.max(0, budget));
    for (const f of wanted.slice(now.length)) cut.set(f, `the walk reads at most ${limits.files} files`);
    budget -= now.length;
    const got = source.readMany(level === 0 ? [...configsRead, ...now] : now);
    filesRead += (level === 0 ? configsRead.length : 0) + now.length;
    if (level === 0) texts = got.texts;
    const found = new Set<string>();
    for (const f of now) {
      const text = got.texts.get(f);
      if (text === undefined) {
        failed.set(f, got.failed.get(f) ?? "it couldn't be found");
        continue;
      }
      const mod = parseModule(text);
      parsed.set(f, mod);
      const targets: string[] = [];
      for (const s of mod.specs.filter((s) => REEXPORTS.has(s.kind))) {
        const to = resolveSpec(f, s.spec);
        if (to !== undefined) targets.push(...to);
        else if (!missed.has(f)) missed.set(f, s.spec);
      }
      next.set(f, targets);
      for (const t of targets) if (MODULE.test(t) && !parsed.has(t) && !failed.has(t) && !cut.has(t)) found.add(t);
    }
    frontier = [...found].filter((f) => !parsed.has(f));
  }

  // Which entry each import in the files read names, so an entry's importers count by what they import.
  const seenBy = new Map<string, Set<string>>();
  for (const [f, mod] of parsed) {
    const from = labelOfDir.get(owner(f).dir);
    if (from === undefined) continue;
    for (const { spec, kind } of mod.specs) {
      if (kind === 'url' || kind === 'glob' || /^[.#/]/.test(spec)) continue;
      const { name, sub } = splitName(spec);
      const pkg = byName.get(name);
      const label = pkg === undefined ? undefined : labelOfDir.get(pkg.dir);
      if (pkg === undefined || label === undefined || label === from) continue;
      const key = exportKeys(pkg.manifest).size === 0 ? (sub === '' ? '.' : undefined) : matchKey(mapOf(pkg), sub === '' ? '.' : `./${sub}`)?.key;
      if (key === undefined) continue;
      const id = `${label}#${key}`;
      (seenBy.get(id) ?? seenBy.set(id, new Set()).get(id)!).add(from);
    }
  }
  // A package whose `exports` gives one entry: each of its importers imports that one.
  const entryCount = new Map<Package, number>();
  for (const e of entries) if (e.key !== './package.json') entryCount.set(e.pkg, (entryCount.get(e.pkg) ?? 0) + 1);
  const importersOf = (e: Entry, id: string): EntryNode['importedBy'] => {
    const seen = seenBy.get(id) ?? new Set<string>();
    const all = graphKnown ? new Set([...(directOf.get(e.label) ?? []), ...seen]).size : undefined;
    // Exact, too, when every importer of the package was seen importing this entry.
    if (all !== undefined && (all === seen.size || (exportKeys(e.pkg.manifest).size > 0 && entryCount.get(e.pkg) === 1))) return { packages: all, files: null };
    return { packages: null, atLeast: seen.size, ...(all !== undefined ? { atMost: all } : {}), files: null };
  };
  const overloads = (reexports: number | null, by: EntryNode['importedBy']) =>
    reexports === null
      ? { overload: null }
      : by.packages !== null
        ? { overload: reexports * by.packages }
        : { overload: null, overloadAtLeast: reexports * (by.atLeast ?? 0), ...(by.atMost !== undefined ? { overloadAtMost: reexports * by.atMost } : {}) };

  // Each entry's re-exported modules, from what was read: unknown when the walk reaches a file it couldn't read.
  // An entry with `import` and `require` targets in different files re-exports the union of both.
  // Breadth first, by this entry's own depth: a module the shared walk reached early, from another entry, still
  // stops this one at the bound, and a module past it that re-exports more makes the count unknown.
  const walk = (files: ReadonlyArray<string>) => {
    const start = new Set(files);
    const depth = new Map(files.map((f) => [f, 0]));
    const queue = [...files];
    const reexports = new Set<string>();
    let why: string | undefined;
    const say = (f: string, reason: string) => (why ??= start.has(f) ? `${f}: ${reason}` : `${f}, which it re-exports: ${reason}`);
    for (let i = 0; i < queue.length; i++) {
      const f = queue[i]!;
      const d = depth.get(f)!;
      const reason = failed.get(f) ?? cut.get(f);
      if (d > limits.depth) {
        if (MODULE.test(f) && (reason !== undefined || (next.get(f) ?? []).some((t) => !depth.has(t)))) say(f, reason ?? `the walk stops ${limits.depth} re-exports deep`);
        continue;
      }
      if (reason !== undefined) {
        say(f, reason);
        continue;
      }
      // What it re-exports from there is unknown, so what's found is a lower bound.
      const miss = missed.get(f);
      if (miss !== undefined) say(f, `it re-exports \`${miss}\`, which resolves to no tracked file`);
      // A cycle back to the entry doesn't count the entry itself.
      for (const t of next.get(f) ?? []) if (!depth.has(t)) (depth.set(t, d + 1), queue.push(t), reexports.add(t));
    }
    return { reexports: reexports.size, why };
  };

  const entryNodes: EntryNode[] = entries.map((e) => {
    const id = `${e.label}#${e.key}`;
    const importedBy = importersOf(e, id);
    const dependents = graphKnown ? allOf(e.label) : null;
    const base = { id, pkg: e.label, key: e.key, root: e.key === '.', importedBy, dependents, loads: null } as const;
    if (e.pattern !== undefined) return { ...base, pattern: e.pattern, subpaths: e.subpaths ?? 0, file: null, reexports: null, stars: null, barrel: null, overload: null };
    if (e.file === undefined) return { ...base, file: null, reexports: null, stars: null, barrel: null, overload: null, unknown: e.miss! };
    const mod = parsed.get(e.file);
    const w = MODULE.test(e.file) ? walk([e.file, ...(e.also ?? []).filter((f) => MODULE.test(f))]) : { reexports: 0, why: undefined };
    const reexports = w.why === undefined ? w.reexports : null;
    return {
      ...base,
      file: e.file,
      ...(e.guessed ? { guessed: true } : {}),
      reexports,
      ...(w.why !== undefined ? { reexportsAtLeast: w.reexports, unknown: w.why } : {}),
      stars: mod ? mod.specs.filter((s) => s.kind === 'star').length : MODULE.test(e.file) ? null : 0,
      barrel: mod ? mod.barrel : MODULE.test(e.file) ? null : false,
      ...overloads(reexports, importedBy),
    };
  });
  // Ranked and flagged by what's shown: exact importers, or those seen; the manifests' upper bound alone flags nothing.
  const importers = (n: EntryNode) => n.importedBy.packages ?? n.importedBy.atLeast ?? 0;
  const known = (n: EntryNode) => n.overload ?? n.overloadAtLeast ?? null;
  entryNodes.sort((a, b) => (known(b) ?? -1) - (known(a) ?? -1) || (b.overloadAtMost ?? -1) - (a.overloadAtMost ?? -1) || (b.reexports ?? -1) - (a.reexports ?? -1) || a.id.localeCompare(b.id));
  const bounds = (n: EntryNode): Record<string, number> => (n.importedBy.packages === null && n.importedBy.atMost !== undefined ? { importerPackagesAtMost: n.importedBy.atMost } : {});
  const atLeast = 'importers seen in the files read, so at least that many; more may import it in files not read';

  const overloaded = entryNodes.filter((n) => n.reexports !== null && n.reexports >= THRESHOLDS.overloadModules && importers(n) >= THRESHOLDS.overloadPackages);
  const rootBarrels = entryNodes.filter((n) => n.root && n.barrel === true && (n.stars ?? 0) > 0 && importers(n) > 0);
  const exportFlags: Flag[] = [
    ...overloaded.map((n) => ({
      kind: 'overloaded-entry',
      subject: n.id,
      numbers: { reexports: n.reexports!, importerPackages: importers(n), ...bounds(n), overload: known(n)!, ...(n.dependents !== null ? { dependents: n.dependents } : {}), packagesOf: npmCount } as Record<string, number>,
      threshold: { reexports: THRESHOLDS.overloadModules, importerPackages: THRESHOLDS.overloadPackages },
      ...(n.importedBy.packages === null ? { detail: atLeast } : {}),
    })),
    ...rootBarrels.map((n) => ({
      kind: 'root-barrel',
      subject: n.id,
      numbers: { stars: n.stars!, ...(n.reexports !== null ? { reexports: n.reexports } : {}), importerPackages: importers(n), ...bounds(n), packagesOf: npmCount },
      threshold: null,
      detail: "a shared package's root re-exports with `export *`, so each importer reaches every module behind it",
    })),
  ];
  const worst = entryNodes.find((n) => (known(n) ?? 0) > 0);
  const bounded = entryNodes.filter((n) => n.importedBy.packages === null && n.importedBy.atMost !== undefined && n.reexports !== null);
  const unknownEntries = entryNodes.filter((n) => n.unknown !== undefined);
  const exportsUnknown = [
    ...(graphKnown ? [] : ["The package graph is unknown, so each entry's importers and overload count only what the files read show"]),
    ...(bounded.length
      ? [`${plural(bounded.length, 'entry', 'entries')} of ${entryNodes.length} belong to packages with more than one entry, so which entry each importer imports shows only in the files read: their importers are at least those seen, at most the package's, and only those seen raise a flag`]
      : []),
    ...(unknownEntries.length ? [`${plural(unknownEntries.length, 'entry', 'entries')} of ${entryNodes.length} unknown, such as ${unknownEntries[0]!.id}: ${unknownEntries[0]!.unknown}`] : []),
  ];
  const exportsGraph = {
    count: { nodes: entryNodes.length, edges: graphKnown ? [...directOf.values()].reduce((a, s) => a + s.size, 0) : null, packages: npmCount, packagesWithEntries: new Set(entryNodes.map((n) => n.pkg)).size, filesRead },
    nodes: entryNodes.slice(0, MAX_LISTED),
    // A package importing another, by its manifest: which entry it imports needs the import graph.
    edges: [...directOf].flatMap(([to, froms]) => [...froms].map((from) => ({ from, to, files: null }))).slice(0, MAX_LISTED),
    ...capped(exportFlags),
    rootBarrels: rootBarrels.length,
    withStars: entryNodes.filter((n) => (n.stars ?? 0) > 0).length,
    worst: worst
      ? {
          id: worst.id,
          reexports: worst.reexports!,
          importerPackages: importers(worst),
          ...(worst.importedBy.packages === null && worst.importedBy.atMost !== undefined ? { importerPackagesAtMost: worst.importedBy.atMost } : {}),
          exact: worst.importedBy.packages !== null,
          overload: known(worst)!,
          dependents: worst.dependents,
          packagesOf: npmCount,
          share: worst.dependents === null ? null : share(worst.dependents, npmCount),
        }
      : null,
    unknown: exportsUnknown,
  };

  // 4. Tasks: the configs from the batch above, the scripts from the manifests.
  const configFailed = configsRead.filter((p) => !texts.has(p));
  const taskGraph = readTaskGraph({ paths: tracked, text: (p) => texts.get(p), packages, owner });
  const shape = taskShape(taskGraph, tracked, { partial: source.tree.truncated });
  const tasksUnknown = [
    ...(configFailed.length ? [`${plural(configFailed.length, 'task config file')} couldn't be read, such as ${configFailed[0]}`] : []),
    ...(source.tree.truncated ? ["GitHub cut the file tree short, so how many files each task's inputs cover is unknown, and none is flagged wide"] : []),
    ...taskGraph.unread.slice(0, 3),
  ];
  const tasksGraph = {
    count: { nodes: shape.nodes.length, edges: shape.edges.length, cached: shape.cached, trackedFiles: source.tree.truncated ? null : tracked.size },
    // Nx's inputs expand to dozens of globs a task: the first few, and how many there are.
    nodes: shape.nodes.slice(0, MAX_LISTED).map((n) => (n.inputs.globs.length > MAX_GLOBS ? { ...n, inputs: { ...n.inputs, globs: n.inputs.globs.slice(0, MAX_GLOBS), globsOf: n.inputs.globs.length } } : n)),
    edges: shape.edges.slice(0, MAX_LISTED),
    ...capped([...shape.flags]),
    depth: shape.depth,
    chain: shape.chain,
    runners: taskGraph.runners,
    unread: taskGraph.unread,
    unknown: tasksUnknown,
  };

  return {
    schema: 1,
    packages: packagesGraph(stack),
    exports: exportsGraph,
    layers: { nodes: null, edges: null, flags: [], note: 'Layers inside a package need every file: run `scripts/graph/` in a checkout for layers and what triggers what' },
    tasks: tasksGraph,
    jobs: jobsGraph(jobGraph),
    thresholds: { ...THRESHOLDS, maxFiles: limits.files, maxTaskFiles: limits.taskFiles, maxReexportDepth: limits.depth },
    /** Files the graphs read besides the manifests, and the calls that took: `calls` is set by the caller that counts them. */
    read: { files: filesRead, calls: null as number | null },
    unknown,
  };
};

export type Graphs = ReturnType<typeof graphsOf>;

// ---------- 5. CI jobs ----------

const jobsGraph = (g: JobGraph | undefined) => {
  if (!g) return null;
  const run = g.perRun.find((r) => r.fits) ?? g.perRun[0];
  const nodes = (run?.jobs ?? []).map((j) => ({ id: j.name, needs: j.needs, onPath: run!.path.includes(j.name), blockedMin: j.blockedMin, queueMin: j.queueMin, workMin: j.workMin }));
  const edges = nodes.flatMap((n) => n.needs.map((to) => ({ from: n.id, to })));
  const flags: Flag[] = [];
  const b = heavyBlocker(g);
  if (b) flags.push({ kind: 'top-blocker', subject: b.name, numbers: { heldJobs: b.heldJobs, jobs: b.jobs, heldJobMin: b.heldJobMin ?? 0, runs: b.runs, runsOf: g.runsUsed }, threshold: null });
  const setup = setupInPath(g);
  if (setup !== undefined) flags.push({ kind: 'setup-in-path', subject: g.chain.map((l) => l.name).join(' → '), numbers: { setupMin: setup, pathMin: g.pathMinP50 ?? 0 }, threshold: { setupMin: 1, shareOfPath: 0.1 } });
  if (g.hidden.runs) flags.push({ kind: 'hidden-wait', subject: g.hidden.jobs.map((j) => j.name).join(', '), numbers: { runs: g.hidden.runs, runsOf: g.runsUsed }, threshold: { lateMin: 2 } });
  return {
    count: { nodes: g.jobs ?? nodes.length, edges: g.edges ?? edges.length, runs: g.runsUsed, runsOf: g.runsSampled },
    nodes,
    edges,
    flags,
    chain: g.chain.map((l) => l.name),
    pathMinP50: g.pathMinP50,
    unknown: g.unknown,
  };
};

// ---------- the report ----------

const GRAPH_NAMES = { packages: '1 Packages', exports: '2 Export paths', tasks: '4 Tasks', jobs: '5 CI jobs' } as const;
type Shown = keyof typeof GRAPH_NAMES;

/** Each kind of flag as one line, most costly kinds first, with up to three subjects. */
const ORDER = ['overloaded-entry', 'package-cycle', 'no-inputs', 'root-barrel', 'wide-inputs', 'deep-chain', 'task-cycle', 'top-blocker', 'setup-in-path', 'hidden-wait'];

const kindLine = (kind: string, fs: Flag[], total: number): string => {
  const f = fs[0]!;
  const n = f.numbers;
  const more = total > 1 ? `, and ${total - 1} more` : '';
  const such = (k: number) => fs.slice(0, k).map((x) => x.subject).join(', ');
  switch (kind) {
    case 'overloaded-entry': {
      const least = n.importerPackagesAtMost !== undefined || f.detail !== undefined ? 'at least ' : '';
      return `${f.subject} re-exports ${n.reexports} modules to ${least}${n.importerPackages} packages (overload ${least}${n.overload})${n.dependents !== undefined ? `; ${n.dependents} of ${n.packagesOf} packages depend on it, directly or not` : ''}${total > 1 ? `; ${plural(total - 1, 'more entry', 'more entries')} over the threshold` : ''}`;
    }
    case 'root-barrel':
      return `${plural(total, 'root barrel')} with \`export *\` that other packages import: ${such(3)}${total > 3 ? ', …' : ''}`;
    case 'package-cycle':
      return `${plural(total, 'cycle')} between packages: ${f.subject} (${n.packages} of ${n.packagesOf} packages)${more}`;
    case 'no-inputs': {
      // Two modes share the kind: no inputs declared, or `inputs: []`.
      const empty = fs.filter((x) => x.detail?.startsWith('inputs are empty'));
      const none = fs.filter((x) => !empty.includes(x));
      const list = (xs: Flag[]) => xs.slice(0, 3).map((x) => x.subject).join(', ');
      const shownMore = total > fs.length ? ` (${total} in all)` : '';
      return [
        none.length ? `${plural(none.length, 'cached task')} with no declared inputs, such as ${list(none)}: the runner keys every file of the package, so any change there misses` : '',
        empty.length ? `${plural(empty.length, 'cached task')} with empty inputs, ${list(empty)}: only the command and env key it, so a source change hits the cache wrongly` : '',
      ].filter(Boolean).join('; ') + shownMore;
    }
    case 'wide-inputs':
      return `${plural(total, 'cached task')} with inputs over ${Math.round(THRESHOLDS.wideInputs * 100)}% of the repo, such as ${f.subject} (${n.files} of ${n.filesOf} files)`;
    case 'deep-chain':
      return `a chain of ${n.tasks} tasks, which no cache shortens on a miss: ${f.subject}`;
    case 'task-cycle':
      return `${plural(total, 'task cycle')}: ${f.subject}`;
    case 'top-blocker':
      return `"${f.subject}" holds up ${n.heldJobs} of ${n.jobs} jobs, ${n.heldJobMin} job-min past their other needs (${n.runs} of ${n.runsOf} runs)`;
    case 'setup-in-path':
      return `${n.setupMin} min of setup on the critical path, of ${n.pathMin}, in jobs that first wait on others`;
    case 'hidden-wait':
      return `${n.runs} of ${n.runsOf} runs had a job queued over 2 minutes after its needs finished: ${f.subject}`;
    default:
      return `${kind}: ${f.subject}`;
  }
};

/** Every flag, grouped by kind and ranked: `{ graph, kind, text }`. */
export const flagLines = (g: Graphs, graphs: Shown[] = ['packages', 'exports', 'tasks', 'jobs']) =>
  graphs
    .flatMap((name) => {
      const graph = g[name];
      if (!graph) return [];
      const counts = 'flagCounts' in graph ? (graph.flagCounts as Record<string, number>) : {};
      const kinds = [...new Set(graph.flags.map((f) => f.kind))];
      return kinds.map((kind) => {
        const fs = graph.flags.filter((f) => f.kind === kind);
        return { graph: name, kind, text: kindLine(kind, fs, counts[kind] ?? fs.length) };
      });
    })
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));

/** The `<ci-report>` lines: one per flag of graphs 1, 2 and 4, at most three. Graph 5 has its own two lines. */
export const graphPromptLines = (g: Graphs | undefined) =>
  g ? flagLines(g, ['packages', 'exports', 'tasks']).slice(0, 3).map((l) => `Graph flag, ${GRAPH_NAMES[l.graph].slice(2).toLowerCase()}: ${l.text}`) : [];

const pc = (x: number) => `${Math.round(x * 100)}%`;

/** The text report's "Graphs" block: the flags first, then a line per graph. */
export const graphsBlock = (g: Graphs) => {
  const flags = flagLines(g);
  const p = g.packages;
  const e = g.exports;
  const t = g.tasks;
  const width = 16;
  const row = (name: string, text: string) => `  ${name.padEnd(width)}${text}`;
  const packagesText =
    p.count.nodes === null
      ? 'unknown'
      : `${plural(p.count.nodes, 'package')}, ${plural(p.count.edges ?? 0, 'internal edge')}, depth ${p.depth}, ${plural(p.flagCounts['package-cycle'] ?? 0, 'cycle')}${p.topFanIn?.length ? `; most depended on: ${p.topFanIn.slice(0, 3).map((x) => `${x.name} (${x.dependents} of ${p.count.nodes})`).join(', ')}` : ''}`;
  const exportsText = e.count.packages === 0
    ? 'no npm packages'
    : e.count.nodes === 0
      ? `none of the ${plural(e.count.packages, 'npm package')} declares \`exports\`, \`main\` or \`module\``
      : `${plural(e.count.nodes, 'entry', 'entries')} in ${e.count.packagesWithEntries} of ${plural(e.count.packages, 'npm package')}: ${plural(e.rootBarrels, 'shared root barrel')}, ${e.withStars} with \`export *\`, ${e.flagCounts['overloaded-entry'] ?? 0} overloaded (≥ ${THRESHOLDS.overloadModules} modules × ≥ ${THRESHOLDS.overloadPackages} packages)${
          e.worst
            ? `; worst ${e.worst.id}, ${e.worst.reexports} × ${e.worst.exact ? '' : '≥ '}${e.worst.importerPackages} = ${e.worst.exact ? '' : '≥ '}${e.worst.overload}${
                e.worst.importerPackagesAtMost !== undefined ? ` (${e.worst.importerPackagesAtMost} import the package)` : ''
              }${e.worst.dependents !== null && e.worst.share !== null ? `, with ${e.worst.dependents} of ${e.worst.packagesOf} packages (${pc(e.worst.share)}) behind it` : ''}`
            : ''
        }`;
  const cachedNoInputs = t.flagCounts['no-inputs'] ?? 0;
  const tasksText = t.count.nodes === 0
    ? 'no tasks: no package scripts or task runner config'
    : `${t.runners.join(', ') || 'none'}: ${plural(t.count.nodes, 'task')} (${t.count.cached} cached), ${plural(t.count.edges, 'edge')}, depth ${t.depth}; ${cachedNoInputs} cached with no declared inputs, ${t.count.trackedFiles === null ? 'input coverage unknown, as the file tree was cut short' : `${t.flagCounts['wide-inputs'] ?? 0} with inputs over ${pc(THRESHOLDS.wideInputs)} of the ${t.count.trackedFiles} files`}${
        t.count.cached === 0 ? '; nothing is cached, so no task runner keys these' : ''
      }`;
  const j = g.jobs;
  const jobsText = j ? `${plural(j.count.nodes, 'job')}, ${plural(j.count.edges, 'needs edge')}; the chain that sets the wait, p50 ${j.pathMinP50 ?? '–'} min: ${j.chain.join(' → ') || 'unknown'} (the "Job graph" block has the rest)` : 'no sampled runs, so no job graph';
  const unknowns = [...g.unknown, ...p.unknown, ...e.unknown, ...t.unknown].map((u) => `  Unknown because: ${u}.`);
  return [
    'Graphs (guide section 21; flags first):',
    ...(flags.length ? flags.map((f) => row(`⚠ ${GRAPH_NAMES[f.graph].slice(2)}`, f.text)) : ['  No flags.']),
    row(GRAPH_NAMES.packages, packagesText),
    row(GRAPH_NAMES.exports, exportsText),
    row('3 Layers', 'run `scripts/graph/` for layers and what triggers what'),
    row(GRAPH_NAMES.tasks, tasksText),
    row(GRAPH_NAMES.jobs, jobsText),
    ...unknowns,
  ].join('\n');
};

/** Fixes the graphs show, in `fixesOf`'s shape, linked to section 21's headings. */
export const graphsFixes = (g: Graphs | undefined) => {
  if (!g) return [];
  const page = (anchor: string) => `21-optimize-all-of-your-graphs.md#${anchor}`;
  const fixes: { text: string; page: string; weight: number }[] = [];
  const over = g.exports.flags.find((f) => f.kind === 'overloaded-entry');
  if (over)
    fixes.push({
      text: `Split ${over.subject}: it re-exports ${over.numbers.reexports} modules to ${over.detail ? 'at least ' : ''}${over.numbers.importerPackages} packages, so an edit to any of them reaches all of those packages' checks; give each area its own entry, listed by name, not \`export *\``,
      page: page('export-paths-what-an-edit-triggers'),
      weight: 5,
    });
  const barrel = g.exports.flags.find((f) => f.kind === 'root-barrel' && f.subject !== over?.subject);
  if (barrel && !over)
    fixes.push({ text: `${barrel.subject} is a root barrel with \`export *\` that other packages import: export by name, and split it by area`, page: page('export-paths-what-an-edit-triggers'), weight: 3 });
  const noInputs = g.tasks.flagCounts['no-inputs'];
  const first = g.tasks.flags.find((f) => f.kind === 'no-inputs');
  if (noInputs && first) fixes.push({ text: `${plural(noInputs, 'cached task')} declare${noInputs === 1 ? 's' : ''} no inputs, such as ${first.subject}: declare each one's inputs, so an edit it doesn't read keeps its cache`, page: page('workspace-tasks'), weight: 4 });
  const wide = g.tasks.flags.find((f) => f.kind === 'wide-inputs');
  if (wide) fixes.push({ text: `${wide.subject}'s inputs cover ${wide.numbers.files} of ${wide.numbers.filesOf} files: narrow them to what it reads`, page: page('workspace-tasks'), weight: 3 });
  const cycle = g.packages.flags[0];
  if (cycle) fixes.push({ text: `Packages depend on each other in a cycle, ${cycle.subject}: break it, so an edit to one stops reaching the rest`, page: page('package-dependencies-declared-and-checked'), weight: 3 });
  const deep = g.tasks.flags.find((f) => f.kind === 'deep-chain');
  if (deep) fixes.push({ text: `A chain of ${deep.numbers.tasks} tasks runs one after another on a cache miss: cut the \`dependsOn\` edges a task doesn't need`, page: page('workspace-tasks'), weight: 2 });
  return fixes;
};

