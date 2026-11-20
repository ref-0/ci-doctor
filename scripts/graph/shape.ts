/**
 * shape.ts: the four graphs, measured, each as `{ nodes, edges, flags }`:
 *
 * 1. `packages`: packages and their internal edges, fan-in, depth and cycles;
 * 2. `exports`: each package's entries, what imports them, barrels, export-path overload, and the
 *    files whose change reaches the most of the workspace;
 * 3. `layers`: the folder-to-folder import graph inside each package, its cycles, a proposed
 *    layering, and violations of declared layers;
 * 4. `tasks`: the task graph's depth, cycles, and tasks whose inputs are missing or cover most of
 *    the repo.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { exportKeys, REEXPORTS } from './read.ts';
import type { FileGraph, Package } from './read.ts';
import type { TaskGraph } from './tasks.ts';

/** A finding, for a person or a page to draw: what it is, about what, its numbers, and the threshold it crossed. */
export interface Flag {
  readonly kind: string;
  readonly subject: string;
  readonly numbers: Readonly<Record<string, number>>;
  readonly threshold: Readonly<Record<string, number>> | null;
  readonly detail?: string;
}

export interface Section<N, E> {
  readonly nodes: ReadonlyArray<N>;
  readonly edges: ReadonlyArray<E>;
  readonly flags: ReadonlyArray<Flag>;
}

/** The thresholds flags use. Change them here; each flag carries the one it crossed. */
export const THRESHOLDS = {
  /** An entry is overloaded when it re-exports at least this many modules to at least this many packages. */
  overloadModules: 20,
  overloadPackages: 3,
  /** How many overloaded entries and wide files to flag at most. */
  top: 20,
  /** A task's inputs are wide when they cover more than this share of the repo's tracked files. */
  wideInputs: 0.5,
  /** A task chain is deep at this many tasks. */
  deepChain: 6,
};

// ---- Graph helpers ------------------------------------------------------------------------------

/** Strongly connected components, by Tarjan's algorithm without recursion, each in the order found (sinks first). */
export const components = (nodes: ReadonlyArray<string>, next: (node: string) => Iterable<string>) => {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  let counter = 0;
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: Array<{ node: string; it: Iterator<string> }> = [];
    const open = (node: string) => {
      index.set(node, counter); low.set(node, counter); counter++;
      stack.push(node); onStack.add(node);
      work.push({ node, it: next(node)[Symbol.iterator]() });
    };
    open(start);
    while (work.length > 0) {
      const top = work[work.length - 1]!;
      const step = top.it.next();
      if (!step.done) {
        const to = step.value;
        if (!index.has(to)) open(to);
        else if (onStack.has(to)) low.set(top.node, Math.min(low.get(top.node)!, index.get(to)!));
        continue;
      }
      work.pop();
      if (work.length > 0) { const parent = work[work.length - 1]!.node; low.set(parent, Math.min(low.get(parent)!, low.get(top.node)!)); }
      if (low.get(top.node) === index.get(top.node)) {
        const scc: string[] = [];
        for (let n = stack.pop(); n !== undefined; n = stack.pop()) { onStack.delete(n); scc.push(n); if (n === top.node) break; }
        found.push(scc.sort());
      }
    }
  }
  return found;
};

/** Each node's longest chain of `next` steps below it (0 for a node with none), cycles condensed, and one longest chain. */
export const depths = (nodes: ReadonlyArray<string>, next: (node: string) => Iterable<string>) => {
  const sccs = components(nodes, next);
  const of = new Map<string, number>();
  sccs.forEach((scc, i) => { for (const n of scc) of.set(n, i); });
  const depth: number[] = [];
  const via: Array<number | undefined> = [];
  sccs.forEach((scc, i) => {
    let best = 0;
    let through: number | undefined;
    for (const n of scc) for (const to of next(n)) {
      const j = of.get(to)!;
      if (j !== i && depth[j]! + 1 > best) { best = depth[j]! + 1; through = j; }
    }
    depth[i] = best; via[i] = through;
  });
  const deepest = depth.reduce((b, d, i) => (d > depth[b]! ? i : b), 0);
  const chain: string[] = [];
  for (let i: number | undefined = sccs.length > 0 ? deepest : undefined; i !== undefined; i = via[i]) chain.push(sccs[i]!.join(' + '));
  return { depth: new Map(nodes.map((n) => [n, depth[of.get(n)!]!])), cycles: sccs.filter((s) => s.length > 1), chain };
};

/** Every file the changed ones reach through importers, the changed ones included. */
export const reach = (graph: FileGraph, changed: Iterable<string>) => {
  const found = new Set<string>();
  const waiting = [...changed];
  for (let f = waiting.pop(); f !== undefined; f = waiting.pop()) {
    if (found.has(f)) continue;
    found.add(f);
    for (const i of graph.importers.get(f) ?? []) if (!found.has(i)) waiting.push(i);
  }
  return found;
};

/** The graph's nodes: parsed modules and the files they import. */
const nodeCache = new WeakMap<FileGraph, string[]>();
export const nodesOf = (graph: FileGraph) => {
  const cached = nodeCache.get(graph);
  if (cached) return cached;
  const nodes = new Set(graph.modules.keys());
  for (const e of graph.edges) nodes.add(e.to);
  const sorted = [...nodes].sort();
  nodeCache.set(graph, sorted);
  return sorted;
};

const share = (count: number, of: number) => (of === 0 ? 0 : Math.round((count / of) * 10000) / 10000);

// ---- 1. Packages --------------------------------------------------------------------------------

export interface PackageNode {
  readonly id: string;
  readonly dir: string;
  readonly files: number;
  readonly tests: number;
  /** Internal packages its manifest names, and that name it. */
  readonly dependencies: number;
  readonly dependents: number;
  /** Other packages, and their files, that import it. */
  readonly importedBy: { readonly packages: number; readonly files: number };
  /** The longest chain of internal manifest dependencies below it. */
  readonly depth: number;
}

export interface PackageEdge {
  readonly from: string;
  readonly to: string;
  /** The manifest fields that declare it; empty when only imports do. */
  readonly declared: ReadonlyArray<string>;
  /** Files of `from` that import `to`. */
  readonly importingFiles: number;
}

export const packagesSection = (graph: FileGraph): Section<PackageNode, PackageEdge> & { depth: number; chain: string[] } => {
  const { packages } = graph;
  const nodes = nodesOf(graph);
  const edges = new Map<string, { from: string; to: string; declared: Set<string>; files: Set<string> }>();
  const edge = (from: string, to: string) => {
    const key = `${from}\0${to}`;
    return edges.get(key) ?? edges.set(key, { from, to, declared: new Set(), files: new Set() }).get(key)!;
  };
  for (const p of packages) for (const [kind, names] of p.deps) for (const n of names) edge(p.name, n).declared.add(kind);
  for (const e of graph.edges) {
    const from = graph.owner(e.from).name;
    const to = graph.owner(e.to).name;
    if (from !== to) edge(from, to).files.add(e.from);
  }
  const manifestNext = (name: string) => [...(packages.find((p) => p.name === name)?.deps.values() ?? [])].flatMap((s) => [...s]);
  const { depth, chain } = depths(packages.map((p) => p.name), manifestNext);
  // Import cycles through runtime code: test files and the root of a monorepo (its scripts and shared configs) left out.
  const monorepo = packages.length > 1;
  const counted = (name: string) => !(monorepo && packages.find((p) => p.name === name)?.dir === '');
  const runtime = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    const [from, to] = [graph.owner(e.from).name, graph.owner(e.to).name];
    if (from !== to && !graph.isTest(e.from) && e.kind !== 'type' && counted(from) && counted(to)) (runtime.get(from) ?? runtime.set(from, new Set()).get(from)!).add(to);
  }
  const importCycles = components(packages.map((p) => p.name).filter(counted), (n) => runtime.get(n) ?? []).filter((s) => s.length > 1);
  const manifestCycles = components(packages.map((p) => p.name), manifestNext).filter((s) => s.length > 1);

  const fileCount = new Map<string, number>();
  const testCount = new Map<string, number>();
  for (const f of nodes) {
    const o = graph.owner(f).name;
    fileCount.set(o, (fileCount.get(o) ?? 0) + 1);
    if (graph.isTest(f)) testCount.set(o, (testCount.get(o) ?? 0) + 1);
  }
  const list = [...edges.values()];
  const packageNodes: PackageNode[] = packages.map((p) => ({
    id: p.name,
    dir: p.dir,
    files: fileCount.get(p.name) ?? 0,
    tests: testCount.get(p.name) ?? 0,
    dependencies: list.filter((e) => e.from === p.name && e.declared.size > 0).length,
    dependents: list.filter((e) => e.to === p.name && e.declared.size > 0).length,
    importedBy: { packages: list.filter((e) => e.to === p.name && e.files.size > 0).length, files: list.filter((e) => e.to === p.name).reduce((n, e) => n + e.files.size, 0) },
    depth: depth.get(p.name) ?? 0,
  })).sort((a, b) => b.importedBy.files - a.importedBy.files || a.id.localeCompare(b.id));

  const flags: Flag[] = [
    ...manifestCycles.map((c) => ({ kind: 'package-cycle', subject: c.join(' ↔ '), numbers: { packages: c.length }, threshold: null, detail: 'manifest dependencies' })),
    ...importCycles.filter((c) => !manifestCycles.some((m) => m.join() === c.join())).map((c) => ({ kind: 'package-cycle', subject: c.join(' ↔ '), numbers: { packages: c.length }, threshold: null, detail: 'imports' })),
    ...list.filter((e) => e.declared.size === 0 && e.files.size > 0 && counted(e.from) && counted(e.to)).map((e) => ({
      kind: 'undeclared-import', subject: `${e.from} → ${e.to}`, numbers: { files: e.files.size, testFiles: [...e.files].filter(graph.isTest).length }, threshold: null, detail: `e.g. ${[...e.files][0]}`,
    })),
  ];
  return {
    nodes: packageNodes,
    edges: list.map((e) => ({ from: e.from, to: e.to, declared: [...e.declared].sort(), importingFiles: e.files.size })).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    flags,
    depth: Math.max(0, ...depth.values()),
    chain,
  };
};

// ---- 2. Export paths and the file graph ---------------------------------------------------------

export interface EntryNode {
  readonly id: string;
  readonly pkg: string;
  readonly key: string;
  /** The `exports` pattern key a subpath entry matched. */
  readonly pattern?: string;
  readonly file: string | null;
  /** Other packages, and their files, that import this entry. */
  readonly importedBy: { readonly packages: number; readonly files: number };
  /** Workspace modules it re-exports, directly or through `export *` and `export { } from` chains. */
  readonly reexports: number;
  readonly stars: number;
  readonly barrel: boolean;
  /** Workspace files loading it loads, itself included. */
  readonly loads: number;
  /** `reexports` × `importedBy.packages`: how many package-module pairs one entry ties together. */
  readonly overload: number;
}

export interface EntryEdge {
  readonly from: string;
  readonly to: string;
  readonly files: number;
}

interface Entry { readonly pkg: Package; readonly key: string; file: string | null; readonly pattern?: string }
const entryCache = new WeakMap<FileGraph, ReadonlyMap<string, Entry>>();

/**
 * Each workspace entry: every exact `exports` key with its runtime file, each subpath an import
 * loads through a `*` pattern (with the pattern it matched), and `.` for a package without
 * `exports` that something imports. Cached per graph.
 */
export const entriesOf = (graph: FileGraph) => {
  const cached = entryCache.get(graph);
  if (cached) return cached;

  const found = new Map<string, Entry>();
  const byName = new Map(graph.packages.map((p) => [p.name, p]));
  for (const pkg of graph.packages) {
    for (const key of exportKeys(pkg.manifest).keys()) if (!key.includes('*')) found.set(`${pkg.name}#${key}`, { pkg, key, file: graph.entry(pkg.name, key) });
  }
  for (const e of graph.edges) {
    if (e.pkg === undefined || e.entry === undefined) continue;
    const id = `${e.pkg}#${e.entry}`;
    const entry = found.get(id) ?? found.set(id, { pkg: byName.get(e.pkg)!, key: e.entry, file: null, ...(e.pattern ? { pattern: e.pattern } : {}) }).get(id)!;
    if (e.kind !== 'type') entry.file ??= e.to;
  }
  // An entry only `import type` reaches still names its runtime file, or the types it loads.
  for (const e of graph.edges) {
    const entry = e.pkg !== undefined && e.kind === 'type' ? found.get(`${e.pkg}#${e.entry}`) : undefined;
    if (entry && entry.file === null) entry.file = (entry.pattern ? null : graph.entry(entry.pkg.name, entry.key)) ?? e.to;
  }
  entryCache.set(graph, found);
  return found;
};


/** Each entry's runtime closure and re-exported modules. */
const closures = (graph: FileGraph, file: string, byFrom: ReadonlyMap<string, ReadonlyArray<string>>) => {
  const loads = new Set<string>();
  const waiting = [file];
  for (let f = waiting.pop(); f !== undefined; f = waiting.pop()) { if (loads.has(f)) continue; loads.add(f); waiting.push(...(graph.imports.get(f) ?? [])); }
  const reexports = new Set<string>();
  const through = [file];
  for (let f = through.pop(); f !== undefined; f = through.pop()) for (const to of byFrom.get(f) ?? []) if (!reexports.has(to)) { reexports.add(to); through.push(to); }
  return { loads: loads.size, reexports: reexports.size };
};

export interface WideFile {
  readonly file: string;
  readonly reaches: { readonly files: number; readonly packages: number; readonly tests: number };
}

/**
 * The files whose change reaches the most of the workspace, by the files that import them
 * directly or not. Each component's reach is the union of its importers' reaches, as bitsets,
 * freed once every component it reaches has read it.
 */
export const widestFiles = (graph: FileGraph, top: number): WideFile[] => {
  const nodes = nodesOf(graph);
  const id = new Map(nodes.map((n, i) => [n, i]));
  const words = Math.ceil(nodes.length / 32);
  const sccs = components(nodes, (n) => graph.imports.get(n) ?? []);
  const of = new Int32Array(nodes.length);
  sccs.forEach((s, i) => { for (const n of s) of[id.get(n)!] = i; });
  const importersOf: Array<Set<number>> = sccs.map(() => new Set());
  const readers = new Int32Array(sccs.length);
  sccs.forEach((s, i) => { for (const n of s) for (const imp of graph.importers.get(n) ?? []) { const j = of[id.get(imp)!]!; if (j !== i && !importersOf[i]!.has(j)) { importersOf[i]!.add(j); readers[j]!++; } } });
  const tests = new Uint32Array(words);
  nodes.forEach((n, i) => { if (graph.isTest(n)) tests[i >>> 5]! |= 1 << (i & 31); });
  const pop = (x: number) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
  const sets: Array<Uint32Array | undefined> = [];
  const best: Array<{ scc: number; files: number; set: Uint32Array }> = [];
  // Tarjan finds sinks first, so importers come later: walk from the last found.
  for (let i = sccs.length - 1; i >= 0; i--) {
    const set = new Uint32Array(words);
    for (const n of sccs[i]!) { const k = id.get(n)!; set[k >>> 5]! |= 1 << (k & 31); }
    for (const j of importersOf[i]!) {
      const other = sets[j]!;
      for (let w = 0; w < words; w++) set[w]! |= other[w]!;
      if (--readers[j]! === 0) sets[j] = undefined;
    }
    let files = 0;
    for (let w = 0; w < words; w++) files += pop(set[w]!);
    if (best.length < top || files > best[best.length - 1]!.files) {
      best.push({ scc: i, files, set: set.slice() });
      best.sort((a, b) => b.files - a.files);
      if (best.length > top) best.pop();
    }
    sets[i] = readers[i]! > 0 ? set : undefined;
  }
  return best.flatMap(({ scc, files, set }) => {
    let testCount = 0;
    const pkgs = new Set<string>();
    for (let w = 0; w < words; w++) {
      testCount += pop(set[w]! & tests[w]!);
      for (let bits = set[w]!; bits !== 0; bits &= bits - 1) pkgs.add(graph.owner(nodes[w * 32 + (31 - Math.clz32(bits & -bits))]!).name);
    }
    return sccs[scc]!.slice(0, 3).map((file) => ({ file, reaches: { files, packages: pkgs.size, tests: testCount } }));
  }).slice(0, top);
};

export const exportsSection = (graph: FileGraph, commitsThrough: ReadonlyMap<string, number> | undefined): Section<EntryNode, EntryEdge> & { wide: WideFile[] } => {
  const entries = entriesOf(graph);
  const edgeFiles = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.pkg === undefined || e.entry === undefined || graph.owner(e.from).name === e.pkg) continue;
    const key = `${graph.owner(e.from).name}\0${e.pkg}#${e.entry}`;
    (edgeFiles.get(key) ?? edgeFiles.set(key, new Set()).get(key)!).add(e.from);
  }
  const byFrom = new Map<string, string[]>();
  for (const e of graph.edges) if (REEXPORTS.has(e.kind)) (byFrom.get(e.from) ?? byFrom.set(e.from, []).get(e.from)!).push(e.to);
  const edges = [...edgeFiles].map(([k, files]) => { const [from, to] = k.split('\0') as [string, string]; return { from, to, files: files.size }; });
  const nodes: EntryNode[] = [...entries].map(([id, { pkg, key, file, pattern }]) => {
    const into = edges.filter((e) => e.to === id);
    const mod = file ? graph.modules.get(file) : undefined;
    const { loads, reexports } = file ? closures(graph, file, byFrom) : { loads: 0, reexports: 0 };
    const packages = into.length;
    return {
      id, pkg: pkg.name, key, ...(pattern ? { pattern } : {}), file,
      importedBy: { packages, files: into.reduce((n, e) => n + e.files, 0) },
      reexports, stars: mod?.specs.filter((s) => s.kind === 'star').length ?? 0, barrel: mod?.barrel ?? false, loads,
      overload: reexports * packages,
    };
  }).sort((a, b) => b.overload - a.overload || b.importedBy.files - a.importedBy.files || a.id.localeCompare(b.id));

  const wide = widestFiles(graph, THRESHOLDS.top);
  const total = nodesOf(graph);
  const testTotal = total.filter(graph.isTest).length;
  const flags: Flag[] = [
    ...nodes.filter((n) => n.reexports >= THRESHOLDS.overloadModules && n.importedBy.packages >= THRESHOLDS.overloadPackages).slice(0, THRESHOLDS.top).map((n) => ({
      kind: 'overloaded-entry', subject: n.id,
      numbers: { reexports: n.reexports, importerPackages: n.importedBy.packages, overload: n.overload, ...(commitsThrough ? { commitsThrough: commitsThrough.get(n.id) ?? 0 } : {}) },
      threshold: { reexports: THRESHOLDS.overloadModules, importerPackages: THRESHOLDS.overloadPackages },
    })),
    ...wide.map((w) => ({
      kind: 'wide-file', subject: w.file,
      numbers: { files: w.reaches.files, filesOf: total.length, packages: w.reaches.packages, packagesOf: graph.packages.length, tests: w.reaches.tests, testsOf: testTotal },
      threshold: { top: THRESHOLDS.top },
    })),
    ...graph.packages.filter((p) => (p.manifest as { private?: boolean }).private === true).flatMap((p) => nodes.filter((n) => n.pkg === p.name && n.importedBy.packages === 0 && p.dir !== '' && !n.key.includes('*')).map((n) => ({
      kind: 'unused-entry', subject: n.id, numbers: { importerPackages: 0 }, threshold: null, detail: 'a private package\'s entry no other package imports',
    }))),
  ];
  return { nodes, edges, flags, wide };
};

// ---- 3. Layers inside packages ------------------------------------------------------------------

/** Declared layers: for a source folder, its places from the bottom, each layer a list of places. */
export type Layers = Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>>;

export interface PlaceNode {
  readonly id: string;
  readonly source: string;
  readonly place: string;
  readonly files: number;
  /** The place's layer, from the bottom: declared, or proposed from the imports, a cycle's places sharing one. */
  readonly layer: number | null;
  readonly declared: boolean;
}

export interface PlaceEdge {
  readonly source: string;
  readonly from: string;
  readonly to: string;
  readonly imports: number;
  readonly example: string;
}

/** A package's source folder: `src/` when it holds modules, else the package's own folder. */
const sourceOf = (graph: FileGraph, pkg: Package) =>
  [...graph.modules.keys()].some((f) => f.startsWith(`${pkg.dir}src/`) && graph.owner(f).name === pkg.name) ? `${pkg.dir}src` : pkg.dir.replace(/\/$/, '');

/** A file's place in a source: its first folder, or its own name without the extension at the top. */
const placeIn = (source: string, file: string) => {
  const rest = source === '' ? file : file.slice(source.length + 1);
  const first = rest.split('/')[0]!;
  return rest.includes('/') ? first : first.replace(/\.[^.]+$/, '').replace(/\.d$/, '');
};

export const layersSection = (graph: FileGraph, declared: Layers = {}): Section<PlaceNode, PlaceEdge> => {
  // Each package's source, and each declared one; a file belongs to the deepest that holds it and is its package's.
  const sources = new Map<string, string>();
  for (const pkg of graph.packages) sources.set(sourceOf(graph, pkg), pkg.name);
  for (const source of Object.keys(declared)) sources.set(source, graph.owner(`${source}/x`).name);
  const ordered = [...sources].sort(([a], [b]) => b.length - a.length);
  const cache = new Map<string, string | undefined>();
  const sourceFor = (file: string) => {
    if (cache.has(file)) return cache.get(file);
    const owner = graph.owner(file).name;
    const found = ordered.find(([s, pkg]) => pkg === owner && (s === '' || file.startsWith(`${s}/`)))?.[0];
    cache.set(file, found);
    return found;
  };

  const files = new Map<string, Map<string, number>>();
  const edges = new Map<string, PlaceEdge & { imports: number }>();
  for (const file of graph.modules.keys()) {
    const source = sourceFor(file);
    if (source === undefined || graph.isTest(file)) continue;
    const place = placeIn(source, file);
    const counts = files.get(source) ?? files.set(source, new Map()).get(source)!;
    counts.set(place, (counts.get(place) ?? 0) + 1);
  }
  for (const e of graph.edges) {
    if (graph.isTest(e.from)) continue;
    const source = sourceFor(e.from);
    if (source === undefined || sourceFor(e.to) !== source) continue;
    const from = placeIn(source, e.from);
    const to = placeIn(source, e.to);
    if (from === to) continue;
    const key = `${source}\0${from}\0${to}`;
    const found = edges.get(key) ?? edges.set(key, { source, from, to, imports: 0, example: `${e.from} → ${e.to}` }).get(key)!;
    found.imports++;
  }

  const nodes: PlaceNode[] = [];
  const flags: Flag[] = [];
  for (const [source, places] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (places.size < 2 && !declared[source]) continue;
    const local = [...edges.values()].filter((e) => e.source === source);
    const next = (p: string) => local.filter((e) => e.from === p).map((e) => e.to);
    const { depth, cycles } = depths([...places.keys()], next);
    const stack = declared[source];
    const rank = new Map(stack?.flatMap((layer, r) => layer.map((p) => [p, r] as const)) ?? []);
    for (const [place, count] of places) nodes.push({ id: `${source}:${place}`, source, place, files: count, layer: stack ? (rank.get(place) ?? null) : depth.get(place) ?? 0, declared: stack !== undefined });
    for (const c of cycles) flags.push({ kind: 'folder-cycle', subject: `${source}: ${c.join(' ↔ ')}`, numbers: { places: c.length, imports: local.filter((e) => c.includes(e.from) && c.includes(e.to)).reduce((n, e) => n + e.imports, 0) }, threshold: null });
    if (!stack) continue;
    for (const place of places.keys()) if (!rank.has(place)) flags.push({ kind: 'unplaced-folder', subject: `${source}: ${place}`, numbers: { files: places.get(place)! }, threshold: null });
    for (const e of local) {
      const [from, to] = [rank.get(e.from), rank.get(e.to)];
      if (from === undefined || to === undefined || to < from) continue;
      flags.push({ kind: 'layer-violation', subject: `${source}: ${e.from} → ${e.to}`, numbers: { imports: e.imports, fromLayer: from, toLayer: to }, threshold: null, detail: `${to === from ? 'beside' : 'above'}; e.g. ${e.example}` });
    }
  }
  return { nodes, edges: [...edges.values()].sort((a, b) => a.source.localeCompare(b.source) || b.imports - a.imports), flags };
};

// ---- 4. Tasks -----------------------------------------------------------------------------------

export interface TaskNode {
  readonly id: string;
  readonly pkg: string;
  readonly name: string;
  readonly runner: string;
  readonly cached: boolean;
  readonly inputs: { readonly mode: string; readonly globs: ReadonlyArray<string>; readonly files: number | null };
  readonly outputs: ReadonlyArray<string>;
  /** The longest chain of tasks it waits on. */
  readonly depth: number;
}

export const tasksSection = (graph: FileGraph, tasks: TaskGraph): Section<TaskNode, { from: string; to: string; how: string }> & { depth: number; chain: string[]; cached: number } => {
  const ids = [...tasks.tasks.keys()];
  const next = (id: string) => tasks.edges.filter((e) => e.from === id).map((e) => e.to);
  const out = new Map<string, string[]>();
  for (const e of tasks.edges) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  const { depth, cycles, chain } = depths(ids, (id) => out.get(id) ?? []);
  void next;
  const tracked = [...graph.files.keys()].sort();
  const counted = new Map<string, number | null>();
  for (const t of tasks.tasks.values()) {
    if (!t.cached || t.mode === 'unknown') { counted.set(t.id, null); continue; }
    let n = 0;
    for (const f of tracked) if (f.startsWith(t.prefix) && t.matches(f)) n++;
    counted.set(t.id, n);
  }
  const nodes: TaskNode[] = [...tasks.tasks.values()].map((t) => ({
    id: t.id, pkg: t.pkg, name: t.name, runner: t.runner, cached: t.cached,
    inputs: { mode: t.mode, globs: t.inputs, files: counted.get(t.id) ?? null }, outputs: t.outputs, depth: depth.get(t.id) ?? 0,
  })).sort((a, b) => a.id.localeCompare(b.id));
  const maxDepth = Math.max(0, ...depth.values());
  const flags: Flag[] = [
    ...cycles.map((c) => ({ kind: 'task-cycle', subject: c.join(' ↔ '), numbers: { tasks: c.length }, threshold: null })),
    ...(maxDepth + 1 >= THRESHOLDS.deepChain ? [{ kind: 'deep-chain', subject: chain.join(' → '), numbers: { tasks: maxDepth + 1 }, threshold: { tasks: THRESHOLDS.deepChain } }] : []),
    ...nodes.filter((n) => n.cached && (n.inputs.mode === 'package-default' || n.inputs.mode === 'empty')).map((n) => ({
      kind: 'no-inputs', subject: n.id, numbers: { files: n.inputs.files ?? 0, filesOf: tracked.length }, threshold: null,
      detail: n.inputs.mode === 'empty' ? 'inputs are empty: only the command and env key the cache, so a source change hits it wrongly' : `no declared inputs: ${n.runner}'s default keys every file of the package, so any change there misses`,
    })),
    ...nodes.filter((n) => n.cached && n.inputs.mode !== 'auto' && n.inputs.files !== null && share(n.inputs.files, tracked.length) > THRESHOLDS.wideInputs).map((n) => ({
      kind: 'wide-inputs', subject: n.id, numbers: { files: n.inputs.files!, filesOf: tracked.length, share: share(n.inputs.files!, tracked.length) }, threshold: { share: THRESHOLDS.wideInputs },
    })),
  ];
  return { nodes, edges: tasks.edges, flags, depth: maxDepth + (ids.length > 0 ? 1 : 0), chain, cached: nodes.filter((n) => n.cached).length };
};

