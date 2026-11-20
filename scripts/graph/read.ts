/**
 * read.ts: a JavaScript or TypeScript workspace at one commit, read from Git: its packages and
 * their manifests, each package's `exports`, and the file-level import graph through them.
 *
 * Everything comes from committed trees (`git ls-tree`, `git cat-file --batch`), never the working
 * tree, so the same reader replays history. Nothing is installed or executed.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { posix } from 'node:path';

import { entryOf, excludes, exportKeys, fileFor, globList, globToRegExp, keyMap, matchKey, MODULE, modeOf, ownerOf, packagesOf, parseJsonc, parseModule, pickBoth, record, strings, targetsOf } from '../../scorer/src/graph-core.ts';
import type { KeyMap, Kind, Mode, Package, PackageJson, Parsed } from '../../scorer/src/graph-core.ts';

// Shared with the scorer, which reads the same `exports` and modules from GitHub: `scorer/src/graph-core.ts`.
export { DEPENDENCY_KINDS, exportKeys, globList, globToRegExp, keyMap, matchKey, MODULE, modeOf, ownerOf, parseJsonc, parseModule, REEXPORTS, stripComments } from '../../scorer/src/graph-core.ts';
export type { KeyMap, Kind, Mode, Package, Parsed, Target } from '../../scorer/src/graph-core.ts';
/** A package.json's fields this reader uses. */
export type Manifest = PackageJson;

// ---- Git ----------------------------------------------------------------------------------------

/** A repo on disk, read through `git`, with a cache of blobs by id. */
export interface Git {
  readonly dir: string;
  readonly run: (...args: ReadonlyArray<string>) => string;
  /** The text of each blob id, read in one batch; ids already read come from the cache. */
  readonly blobs: (ids: ReadonlyArray<string>) => ReadonlyMap<string, string>;
}

export const openGit = (dir: string): Git => {
  const cache = new Map<string, string>();
  const run = (...args: ReadonlyArray<string>) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

  const blobs = (ids: ReadonlyArray<string>) => {
    const wanted = [...new Set(ids)].filter((id) => !cache.has(id));
    if (wanted.length > 0) {
      const done = spawnSync('git', ['cat-file', '--batch'], { cwd: dir, input: wanted.join('\n') + '\n', maxBuffer: 2 * 1024 * 1024 * 1024 });
      if (done.status !== 0) throw new Error(`git cat-file failed: ${done.stderr.toString()}`);
      const out = done.stdout;
      let at = 0;
      for (const id of wanted) {
        const end = out.indexOf(0x0a, at);
        const header = out.subarray(at, end).toString('utf8');
        if (header.endsWith(' missing')) { cache.set(id, ''); at = end + 1; continue; }
        const size = Number(header.slice(header.lastIndexOf(' ') + 1));
        cache.set(id, out.subarray(end + 1, end + 1 + size).toString('utf8'));
        at = end + 1 + size + 1;
      }
    }
    return new Map([...new Set(ids)].map((id) => [id, cache.get(id) ?? '']));
  };

  return { dir, run, blobs };
};

/** Every tracked file at `rev`, with its blob id. Submodules are left out. */
export const treeAt = (git: Git, rev: string) => {
  const files = new Map<string, string>();
  for (const line of git.run('ls-tree', '-r', '-z', '--full-tree', rev).split('\0')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const [, type, id] = line.slice(0, tab).split(' ');
    if (type === 'blob' && id !== undefined) files.set(line.slice(tab + 1), id);
  }
  return files;
};

// ---- Workspace ----------------------------------------------------------------------------------

export type WorkspaceKind = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'single';

/** A YAML line without its comment: from a `#` outside quotes that starts the line or follows a space. */
const uncommented = (line: string) => {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
};

/**
 * The package globs of `pnpm-workspace.yaml`'s `packages:` list: flow style, or a block list whose
 * items are indented or not, with comments anywhere.
 */
export const pnpmGlobs = (text: string) => {
  const lines = text.split('\n').map(uncommented);
  const start = lines.findIndex((l) => /^packages:/.test(l));
  if (start === -1) return [];
  const unquote = (g: string) => g.trim().replace(/^['"]|['"]$/g, '');
  const inline = lines[start]!.slice('packages:'.length).trim();
  if (inline.startsWith('[')) return inline.slice(1, inline.lastIndexOf(']')).split(',').map(unquote).filter(Boolean);

  const found: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    const item = /^\s*-\s+(.+)$/.exec(line)?.[1];
    if (item !== undefined) { found.push(unquote(item)); continue; }
    if (/^\S/.test(line)) break;
  }
  return found;
};

/** The workspace's kind and packages at a commit, the root among them. */
export const readWorkspace = (files: ReadonlyMap<string, string>, git: Git) => {
  const text = (path: string) => { const id = files.get(path); return id === undefined ? undefined : git.blobs([id]).get(id); };
  const rootManifest = (parseJsonc(text('package.json') ?? '{}') ?? {}) as Manifest;
  const workspaces = rootManifest.workspaces;
  const declared = files.has('pnpm-workspace.yaml')
    ? pnpmGlobs(text('pnpm-workspace.yaml') ?? '')
    : Array.isArray(workspaces) ? strings(workspaces) : strings(record(workspaces).packages);
  const kind: WorkspaceKind = declared.length === 0 ? 'single'
    : files.has('pnpm-workspace.yaml') ? 'pnpm'
    : files.has('bun.lock') || files.has('bun.lockb') ? 'bun'
    : files.has('yarn.lock') ? 'yarn' : 'npm';

  const include = declared.filter((g) => !g.startsWith('!')).map((g) => globToRegExp(g.replace(/^\.\//, '').replace(/\/$/, '')));
  const exclude = declared.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1).replace(/^\.\//, '').replace(/\/$/, '')));
  const dirs = [...files.keys()]
    .filter((path) => path.endsWith('/package.json') && !path.includes('node_modules/'))
    .map((path) => path.slice(0, -'/package.json'.length))
    .filter((dir) => include.some((re) => re.test(dir)) && !exclude.some((re) => re.test(dir)));
  const manifests = new Map<string, Manifest>([['', rootManifest]]);
  const blobs = git.blobs(dirs.map((dir) => files.get(`${dir}/package.json`) ?? ''));
  for (const dir of dirs) manifests.set(`${dir}/`, (parseJsonc(blobs.get(files.get(`${dir}/package.json`) ?? '') ?? '') ?? {}) as Manifest);

  const packages = packagesOf(manifests);
  return { kind, packages };
};

// ---- Imports ------------------------------------------------------------------------------------

// ---- tsconfig paths -----------------------------------------------------------------------------

interface PathsConfig { readonly base: string; readonly paths: ReadonlyArray<readonly [string, ReadonlyArray<string>]>; readonly baseUrl?: string }

/** Each folder's nearest tsconfig's `paths` and `baseUrl`, following relative and workspace `extends`. */
const tsconfigs = (files: ReadonlyMap<string, string>, git: Git, packages: ReadonlyArray<Package>) => {
  const configs = [...files.keys()].filter((p) => /(^|\/)tsconfig\.json$/.test(p) && !p.includes('node_modules/'));
  const parent = (dir: string) => (posix.dirname(dir) === '.' ? '' : posix.dirname(dir));
  // TypeScript resolves `paths` against the effective `baseUrl`, inherited or not, else against the config declaring them.
  const read = (path: string, seen: Set<string>): { paths?: Record<string, unknown>; pathsDir?: string; baseUrl?: string } => {
    const id = files.get(path);
    if (seen.has(path) || id === undefined) return {};

    seen.add(path);
    const json = record(parseJsonc(git.blobs([id]).get(id) ?? ''));
    const dir = parent(path);
    let inherited = {};
    for (const ext of typeof json.extends === 'string' ? [json.extends] : strings(json.extends)) {
      let target: string | undefined;
      if (ext.startsWith('.')) target = posix.normalize(posix.join(dir, ext));
      else {
        const pkg = packages.find((p) => p.dir !== '' && (ext === p.name || ext.startsWith(`${p.name}/`)));
        if (pkg) target = posix.join(pkg.dir, ext.slice(pkg.name.length + 1) || 'tsconfig.json');
      }
      if (target && !target.endsWith('.json')) target += files.has(`${target}.json`) ? '.json' : '/tsconfig.json';
      if (target) inherited = { ...inherited, ...read(target, seen) };
    }
    const options = record(json.compilerOptions);
    const baseUrl = typeof options.baseUrl === 'string' ? posix.normalize(posix.join(dir, options.baseUrl)).replace(/^\.$/, '') : undefined;

    return {
      ...inherited,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(options.paths ? { paths: record(options.paths), pathsDir: dir } : {}),
    };
  };

  const byDir = new Map<string, PathsConfig>();
  for (const path of configs) {
    const found = read(path, new Set());
    byDir.set(parent(path), {
      base: found.baseUrl ?? found.pathsDir ?? parent(path),
      paths: Object.entries(found.paths ?? {}).map(([k, v]) => [k, strings(v)] as const),
      ...(found.baseUrl !== undefined ? { baseUrl: found.baseUrl } : {}),
    });
  }

  const cache = new Map<string, PathsConfig | undefined>();
  const nearest = (dir: string): PathsConfig | undefined => {
    if (cache.has(dir)) return cache.get(dir);
    const found = byDir.get(dir) ?? (dir === '' ? undefined : nearest(parent(dir)));
    cache.set(dir, found);
    return found;
  };
  return nearest;
};

// ---- Resolution ---------------------------------------------------------------------------------

/** Why a specifier didn't land on a tracked file. */
export type Unresolved = 'unparsed' | 'computed' | 'context' | 'glob-empty' | 'missing' | 'not-exported' | 'built-only' | 'too-large';

export const UNRESOLVED_NOTES: Readonly<Record<Unresolved, string>> = {
  unparsed: '`import` or `export` statements the scanner couldn\'t read',
  computed: '`import()` or `require()` of a computed value',
  context: '`require.context` folder patterns',
  'glob-empty': 'globs that matched no tracked file',
  missing: 'relative or aliased paths with no tracked file (generated, or broken)',
  'not-exported': 'workspace subpaths the package\'s `exports` doesn\'t name',
  'built-only': 'workspace entries whose every target is build output, with no source to map to',
  'too-large': 'files over 1 MiB, not parsed (bundles, generated code)',
};

export interface Resolution {
  readonly file?: string;
  /** Other runtime files the same entry names: its CommonJS target beside its ESM one, or the reverse. */
  readonly also?: ReadonlyArray<string>;
  /** For a workspace package specifier: the package, and the entry it loads (a pattern's concrete subpath). */
  readonly pkg?: string;
  readonly entry?: string;
  /** The `exports` pattern key the entry matched, when it matched one. */
  readonly pattern?: string;
  readonly external?: 'builtin' | 'package';
  readonly unresolved?: Unresolved;
  /** A build-output target mapped to its source by the `dist` → `src` convention. */
  readonly guessed?: boolean;
  readonly via?: 'relative' | 'paths' | 'workspace' | 'imports' | 'baseUrl';
}

const BUILTINS = new Set(builtinModules);

const splitName = (spec: string) => {
  const parts = spec.split('/');
  const n = spec.startsWith('@') ? 2 : 1;
  return { name: parts.slice(0, n).join('/'), sub: parts.slice(n).join('/') };
};

export interface Resolver {
  readonly resolve: (from: string, spec: string, mode?: Mode) => Resolution;
  /** The file a workspace package's entry loads at runtime, or null. */
  readonly entry: (pkg: string, key: string) => string | null;
}

/**
 * A resolver over one commit's tracked paths, manifests and tsconfigs. It builds each package's
 * `exports` and `imports` maps once and caches by folder, specifier and mode, so commits whose
 * paths and JSON files match can share it.
 */
export const makeResolver = (
  files: ReadonlyMap<string, string>,
  git: Git,
  packages: ReadonlyArray<Package>,
  conditions: ReadonlyArray<string>,
): Resolver => {
  const tracked = new Set(files.keys());
  const byName = new Map(packages.map((p) => [p.name, p]));
  const pathsFor = tsconfigs(files, git, packages);
  const cache = new Map<string, Resolution>();
  const exportMaps = new Map<string, KeyMap>();
  const importMaps = new Map<string, KeyMap>();
  const entries = new Map<string, Resolution>();
  const exportsOf = (pkg: Package) => exportMaps.get(pkg.name) ?? exportMaps.set(pkg.name, keyMap(exportKeys(pkg.manifest))).get(pkg.name)!;
  const importsOf = (pkg: Package) => importMaps.get(pkg.name) ?? importMaps.set(pkg.name, keyMap(Object.entries(pkg.manifest.imports ?? {}))).get(pkg.name)!;

  const uncachedEntry = (pkg: Package, sub: string, mode: Mode): Resolution => {
    const at = { pkg: pkg.name, entry: sub === '' ? '.' : `./${sub}`, via: 'workspace' as const };
    return { ...entryOf(pkg, exportsOf(pkg), sub, mode, tracked, conditions), ...at };
  };

  const workspaceEntry = (pkg: Package, sub: string, mode: Mode) => {
    const key = `${pkg.name}\0${sub}\0${mode}`;
    let found = entries.get(key);
    if (!found) { found = uncachedEntry(pkg, sub, mode); entries.set(key, found); }
    return found;
  };

  const uncached = (fromDir: string, spec: string, mode: Mode): Resolution => {
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const base = spec.startsWith('/') ? ownerOf(`${fromDir}/x`, packages).dir + spec.slice(1) : posix.join(fromDir, spec);
      const path = posix.normalize(base.split('?')[0]!);
      const file = fileFor(path, tracked);
      return file ? { file, via: 'relative' } : { unresolved: 'missing', via: 'relative' };
    }
    if (spec.startsWith('#')) {
      // A `#` specifier is the importing package's own: with no `imports` match it names nothing.
      const pkg = ownerOf(`${fromDir}/x`, packages);
      const match = matchKey(importsOf(pkg), spec);
      if (!match || excludes(match.target)) return { unresolved: 'missing', via: 'imports' };
      const local = targetsOf(match.target).some((t) => t.path.startsWith('.'));
      if (local) {
        const picked = pickBoth(pkg.dir, match.target, match.star, tracked, conditions, mode);
        return picked ? { ...picked, via: 'imports' } : { unresolved: 'missing', via: 'imports' };
      }
      const bare = targetsOf(match.target)[0]!.path;
      return uncached(fromDir, match.star === undefined ? bare : bare.replaceAll('*', match.star), mode);
    }
    const config = pathsFor(fromDir);
    if (config) {
      let best: { prefix: number; targets: ReadonlyArray<string>; star: string } | undefined;
      for (const [key, targets] of config.paths) {
        const at = key.indexOf('*');
        if (at === -1 ? key === spec : spec.startsWith(key.slice(0, at)) && spec.endsWith(key.slice(at + 1))) {
          const prefix = at === -1 ? Infinity : at;
          if (!best || prefix > best.prefix) best = { prefix, targets, star: at === -1 ? '' : spec.slice(at, spec.length - (key.length - at - 1)) };
        }
      }
      if (best) {
        for (const target of best.targets) {
          const file = fileFor(posix.normalize(posix.join(config.base, target.replace('*', best.star))), tracked);
          if (file) {
            const { name } = splitName(spec);
            const pkg = byName.get(name);
            return { file, via: 'paths', ...(pkg ? { pkg: pkg.name, entry: spec === name ? '.' : `./${spec.slice(name.length + 1)}` } : {}) };
          }
        }
        if (!byName.has(splitName(spec).name)) return { unresolved: 'missing', via: 'paths' };
      }
    }
    const { name, sub } = splitName(spec);
    const pkg = byName.get(name);
    if (pkg) return workspaceEntry(pkg, sub, mode);
    if (spec.startsWith('node:') || BUILTINS.has(name)) return { external: 'builtin' };
    if (config?.baseUrl !== undefined) {
      const file = fileFor(posix.join(config.baseUrl, spec), tracked);
      if (file) return { file, via: 'baseUrl' };
    }
    return { external: 'package' };
  };

  return {
    resolve: (from, spec, mode = 'esm') => {
      const dir = posix.dirname(from) === '.' ? '' : posix.dirname(from);
      const key = `${dir}\0${spec}\0${mode}`;
      let found = cache.get(key);
      if (!found) { found = uncached(dir, spec, mode); cache.set(key, found); }
      return found;
    },
    entry: (name, key) => {
      const pkg = byName.get(name);
      return pkg ? workspaceEntry(pkg, key === '.' ? '' : key.replace(/^\.\//, ''), 'esm').file ?? null : null;
    },
  };
};

/** What a resolver reads from a commit: its tracked paths, every JSON file's blob, and the conditions. */
export const resolverKey = (files: ReadonlyMap<string, string>, conditions: ReadonlyArray<string>) => {
  const hash = createHash('sha1').update(conditions.join(',')).update('\0');
  for (const [path, id] of files) hash.update(path.endsWith('.json') || path.endsWith('.yaml') ? `${path}\0${id}\n` : `${path}\n`);
  return hash.digest('hex');
};

// ---- The graph ----------------------------------------------------------------------------------

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly kind: Kind;
  readonly pkg?: string;
  readonly entry?: string;
  /** The `exports` pattern key `entry` matched. */
  readonly pattern?: string;
}

/** One commit's workspace: packages, modules, edges and what didn't resolve. */
export interface FileGraph {
  readonly rev: string;
  readonly kind: WorkspaceKind;
  readonly packages: ReadonlyArray<Package>;
  /** Every tracked path, with its blob id. */
  readonly files: ReadonlyMap<string, string>;
  /** The parsed modules, and what each names. */
  readonly modules: ReadonlyMap<string, Parsed>;
  readonly edges: ReadonlyArray<Edge>;
  /** Each file's importers, through runtime edges (not `import type`). */
  readonly importers: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Each file's runtime imports. */
  readonly imports: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly owner: (path: string) => Package;
  /** The file a workspace package's entry loads at runtime, or null. */
  readonly entry: (pkg: string, key: string) => string | null;
  /** The `exports` conditions preferred, in order; empty for document order. */
  readonly conditions: ReadonlyArray<string>;
  readonly isTest: (path: string) => boolean;
  readonly specifiers: { total: number; resolved: number; external: number; builtin: number; workspace: number; guessed: number; crossRelative: number; undeclared: number };
  readonly unresolved: ReadonlyMap<Unresolved, { count: number; examples: string[] }>;
}

export interface ReadOptions {
  readonly tests: RegExp;
  readonly conditions: ReadonlyArray<string>;
}

export const DEFAULT_TESTS = /(?:\.|_|-)(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\//;

/**
 * The workspace at `rev`. Callers replaying commits share `parsed`, modules by blob id, and
 * `resolvers`, by `resolverKey`, so a commit that adds or removes no path and edits no JSON
 * reuses its parent's resolutions.
 */
export const readGraph = (
  git: Git,
  rev: string,
  options: ReadOptions,
  parsed: Map<string, Parsed> = new Map(),
  files: ReadonlyMap<string, string> = treeAt(git, rev),
  resolvers: Map<string, Resolver> = new Map(),
): FileGraph => {
  const { kind, packages } = readWorkspace(files, git);
  const owners = new Map<string, Package>();
  const owner = (path: string) => owners.get(path) ?? owners.set(path, ownerOf(path, packages)).get(path)!;
  const key = resolverKey(files, options.conditions);
  const resolver = resolvers.get(key) ?? makeResolver(files, git, packages, options.conditions);
  resolvers.delete(key);
  resolvers.set(key, resolver);
  while (resolvers.size > 2) resolvers.delete(resolvers.keys().next().value!);
  const modulePaths = [...files.keys()].filter((p) => MODULE.test(p) && !p.includes('node_modules/'));
  const fresh = modulePaths.map((p) => files.get(p)!).filter((id) => !parsed.has(id));
  if (fresh.length > 0) for (const [id, text] of git.blobs(fresh)) parsed.set(id, parseModule(text));

  const modules = new Map(modulePaths.map((p) => [p, parsed.get(files.get(p)!)!]));
  const edges: Edge[] = [];
  const unresolved = new Map<Unresolved, { count: number; examples: string[] }>();
  const miss = (why: Unresolved, where: string) => {
    const entry = unresolved.get(why) ?? { count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < 5) entry.examples.push(where);
    unresolved.set(why, entry);
  };
  const specifiers = { total: 0, resolved: 0, external: 0, builtin: 0, workspace: 0, guessed: 0, crossRelative: 0, undeclared: 0 };
  const tracked = [...files.keys()];

  for (const [path, mod] of modules) {
    if (mod.tooLarge) { miss('too-large', path); continue; }
    for (let i = 0; i < mod.computed; i++) miss('computed', path);
    for (let i = 0; i < mod.contexts; i++) miss('context', path);
    for (const line of mod.unparsed) miss('unparsed', `${path}: ${line}`);
    specifiers.total += mod.computed + mod.contexts + mod.unparsed.length;
    const from = owner(path);
    for (const { spec, kind } of mod.specs) {
      specifiers.total++;
      if (kind === 'glob') {
        // One call's patterns in order, relative to the file (or to its package for `/…`), `!` ones excluding.
        const patterns = spec.split('\n').filter(Boolean).map((g) => {
          const out = g.startsWith('!');
          const bare = out ? g.slice(1) : g;
          const full = bare.startsWith('/') ? posix.join(from.dir, bare.slice(1)) : posix.normalize(posix.join(posix.dirname(path), bare));
          return out ? `!${full}` : full;
        });
        const matches = globList(patterns);
        const hits = tracked.filter((p) => p !== path && matches(p));
        if (hits.length === 0) miss('glob-empty', `${path}: ${spec}`);
        else specifiers.resolved++;
        for (const to of hits) edges.push({ from: path, to, kind });
        continue;
      }
      const found = resolver.resolve(path, spec, modeOf(kind));
      if (found.external === 'builtin') { specifiers.builtin++; continue; }
      if (found.external === 'package') { specifiers.external++; continue; }
      if (found.unresolved) { miss(found.unresolved, `${path}: ${spec}`); continue; }
      if (!found.file) continue;
      specifiers.resolved++;
      if (found.guessed) specifiers.guessed++;
      const to = owner(found.file);
      if (found.pkg !== undefined && to.name !== from.name) {
        specifiers.workspace++;
        const declared = [...from.deps.values()].some((set) => set.has(to.name));
        if (!declared && from.dir !== '') specifiers.undeclared++;
      } else if (to.name !== from.name) specifiers.crossRelative++;
      const through = found.pkg !== undefined ? { pkg: found.pkg, entry: found.entry!, ...(found.pattern ? { pattern: found.pattern } : {}) } : {};
      for (const to of [found.file, ...(found.also ?? [])]) edges.push({ from: path, to, kind, ...through });
    }
  }

  const importers = new Map<string, string[]>();
  const imports = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind === 'type' || e.from === e.to) continue;
    (importers.get(e.to) ?? importers.set(e.to, []).get(e.to)!).push(e.from);
    (imports.get(e.from) ?? imports.set(e.from, []).get(e.from)!).push(e.to);
  }

  return { rev, kind, packages, files, modules, edges, importers, imports, owner, entry: resolver.entry, conditions: options.conditions, isTest: (p) => options.tests.test(p), specifiers, unresolved };
};
