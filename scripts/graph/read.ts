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

// ---- Lenient JSON -------------------------------------------------------------------------------

/** JSON with comments and trailing commas, as tsconfig and turbo.json allow, or undefined. */
export const parseJsonc = (text: string): unknown => {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) break;
      i++;
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return undefined;
  }
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

// ---- Globs --------------------------------------------------------------------------------------

/** A glob as a RegExp over `/`-separated paths: `**`, `*`, `?`, `{a,b}` and `[...]`, compiled once per glob. */
export const globToRegExp = (glob: string): RegExp => {
  const known = compiledGlobs.get(glob);
  if (known) return known;

  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? '';
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) { source += '\\{'; continue; }
      source += `(?:${glob.slice(i + 1, end).split(',').map((part) => globToRegExp(part).source.slice(1, -1)).join('|')})`;
      i = end;
    } else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end === -1) { source += '\\['; continue; }
      source += `[${glob.slice(i + 1, end).replace(/^!/, '^')}]`;
      i = end;
    } else source += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  const re = new RegExp(`^${source}$`);
  compiledGlobs.set(glob, re);
  return re;
};
const compiledGlobs = new Map<string, RegExp>();

/** A matcher for a list of globs, `!` ones taking paths back out, in order. */
export const globList = (globs: ReadonlyArray<string>) => {
  const compiled = globs.map((glob) => ({ out: glob.startsWith('!'), re: globToRegExp(glob.replace(/^!/, '').replace(/^\.\//, '')) }));
  return (path: string) => {
    let hit = false;
    for (const { out, re } of compiled) if (out ? hit : !hit) if (re.test(path)) hit = !out;
    return hit;
  };
};

// ---- Workspace ----------------------------------------------------------------------------------

/** What an `exports` or `imports` key names: a path, conditions that each name one, a list, or nothing. */
export type Target = string | null | ReadonlyArray<Target> | { readonly [condition: string]: Target };

export interface Manifest {
  readonly name?: string;
  readonly main?: string;
  readonly module?: string;
  readonly types?: string;
  readonly source?: string;
  readonly exports?: Target;
  readonly imports?: { readonly [key: string]: Target };
  readonly scripts?: Readonly<Record<string, string>>;
  readonly workspaces?: unknown;
  readonly nx?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

export const DEPENDENCY_KINDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

/** A workspace package: its name, its directory (`''` for the root, else with a trailing `/`) and manifest. */
export interface Package {
  readonly name: string;
  readonly dir: string;
  readonly manifest: Manifest;
  /** Workspace packages it names in its manifest, by kind. */
  readonly deps: ReadonlyMap<string, ReadonlySet<string>>;
}

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

  const names = new Map<string, string>();
  for (const [dir, manifest] of manifests) {
    const name = manifest.name ?? (dir === '' ? '(root)' : dir.slice(0, -1));
    names.set(dir, names.has(name) || [...names.values()].includes(name) ? `${name} (${dir || 'root'})` : name);
  }
  const byName = new Set(names.values());
  const packages: Package[] = [...manifests].map(([dir, manifest]) => ({
    name: names.get(dir)!,
    dir,
    manifest,
    deps: new Map(DEPENDENCY_KINDS.map((kind) => [kind, new Set(Object.keys(manifest[kind] ?? {}).filter((n) => byName.has(n) && n !== names.get(dir)))])),
  }));
  // Deepest directory first, so ownerOf finds a nested package before its parent.
  packages.sort((a, b) => b.dir.length - a.dir.length || a.name.localeCompare(b.name));
  return { kind, packages };
};

/** The package that holds a path: the deepest whose directory it's in, the root last. */
export const ownerOf = (path: string, packages: ReadonlyArray<Package>) =>
  packages.find((p) => path.startsWith(p.dir)) ?? packages[packages.length - 1]!;

// ---- Imports ------------------------------------------------------------------------------------

export const MODULE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;
const MAX_BYTES = 1024 * 1024;

/**
 * How a file names another: a runtime import, a type-only one, a named re-export
 * (`export { a } from`), `export *`, a dynamic `import()`, `require`, `new URL(…, import.meta.url)`
 * or a glob.
 */
export type Kind = 'static' | 'type' | 'reexport' | 'star' | 'dynamic' | 'require' | 'url' | 'glob';

/** The kinds that re-export what they name, so an entry's re-exported modules follow them. */
export const REEXPORTS: ReadonlySet<Kind> = new Set(['reexport', 'star']);

export interface Parsed {
  readonly specs: ReadonlyArray<{ readonly spec: string; readonly kind: Kind }>;
  /** `import()` and `require()` of something that isn't a plain string. */
  readonly computed: number;
  /** `require.context` calls, which name folders by a pattern this reader doesn't follow. */
  readonly contexts: number;
  /** `import` or `export` statements the scanner couldn't read, each with its first line. */
  readonly unparsed: ReadonlyArray<string>;
  /** Whether every statement is an import or a re-export: a barrel. */
  readonly barrel: boolean;
  readonly tooLarge: boolean;
}

/**
 * The source with comments removed and multi-line template literals blanked, so an import in a
 * comment or in a code sample held in a string doesn't count. Strings and single-line templates stay.
 */
export const stripComments = (text: string) => {
  let out = '';
  let last = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const body = text.slice(i, end === -1 ? text.length : end + 2);
      out += body.replace(/[^\n]/g, ' ');
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const start = i;
      for (i++; i < text.length && text[i] !== c; i++) {
        if (text[i] === '\\') i++;
        else if (c !== '`' && text[i] === '\n') break;
      }
      const literal = text.slice(start, i + 1);
      out += c === '`' && literal.includes('\n') ? '`' + literal.slice(1, -1).replace(/[^\n]/g, ' ') + '`' : literal;
      last = c;
      continue;
    }
    if (c === '/' && (last === '' || /[(,=:[!&|?{};]/.test(last))) {
      // A regex literal: skip to its closing slash, outside a character class.
      const start = i;
      let inClass = false;
      for (i++; i < text.length && text[i] !== '\n'; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        else if (text[i] === '/' && !inClass) break;
      }
      out += text.slice(start, i + 1);
      last = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) last = c;
  }
  return out;
};

const DYNAMIC = /\bimport\(\s*(?:(['"])([^'"\n]+)\1|`([^`$\n]+)`)\s*[,)]/g;
const COMPUTED = /\bimport\(\s*(?!(['"])[^'"\n]*\1\s*[,)]|`[^`$\n]*`\s*[,)])(?=[^)\s])|\brequire\(\s*(?!(['"])[^'"\n]*\2\s*\))(?=[^)\s])/g;
const REQUIRE = /\brequire\(\s*(['"])([^'"\n]+)\1\s*\)/g;
const URL_REF = /\bnew URL\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g;
const GLOB = /\bimport\.meta\.glob(?:Eager)?\b[^(]*\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/g;
/** Where an identifier ends, from `at`. */
const wordAt = (source: string, at: number) => /^[A-Za-z_$][\w$]*/.exec(source.slice(at, at + 200))?.[0];

const skipSpace = (source: string, at: number) => { while (at < source.length && /\s/.test(source[at]!)) at++; return at; };

/** A string literal's value and end, starting at a quote. */
const stringAt = (source: string, at: number) => {
  const quote = source[at];
  if (quote !== "'" && quote !== '"') return undefined;
  const end = source.indexOf(quote, at + 1);
  return end === -1 || source.slice(at + 1, end).includes('\n') ? undefined : { value: source.slice(at + 1, end), end: end + 1 };
};

/**
 * Each `import` and `export` statement, read by a scanner rather than one pattern, so spacing
 * (`import{x}from"./x"`) and keywords used as names (`import { async as run }`) read as any other.
 * A statement it can't read is returned as `unparsed`, never dropped.
 */
const scanStatements = (source: string) => {
  const specs: Array<{ spec: string; kind: Kind }> = [];
  const unparsed: string[] = [];
  for (const m of source.matchAll(/\b(import|export)\b/g)) {
    const word = m[1] as 'import' | 'export';
    const at = m.index;
    // A statement starts the text, a line, or follows `;`, `{` or `}`; never `.import` or `x.export`.
    let back = at - 1;
    while (back >= 0 && /[ \t]/.test(source[back]!)) back--;
    if (back >= 0 && !/[\n;{}]/.test(source[back]!)) continue;
    let i = skipSpace(source, at + word.length);
    if (source[i] === '(' || source[i] === '.' || source[i] === '=' || source[i] === ':' || source[i] === ',') continue;
    const fail = () => unparsed.push(source.slice(at, source.indexOf('\n', at) === -1 ? undefined : source.indexOf('\n', at)).trim().slice(0, 120));

    let typeOnly = false;
    const first = wordAt(source, i);
    if (first === 'type') {
      const after = skipSpace(source, i + 4);
      const next = wordAt(source, after);
      // `import type from './x'` imports a default named `type`.
      if (!(next === 'from' && stringAt(source, skipSpace(source, after + 4)))) { typeOnly = true; i = after; }
    }
    // After `export` (or `export type`), only `{` or `*` starts a re-export: anything else declares.
    if (word === 'export' && !/[{*]/.test(source[i] ?? '')) continue;

    const side = stringAt(source, i);
    if (side) {
      if (word === 'import') specs.push({ spec: side.value, kind: typeOnly ? 'type' : 'static' });
      else fail();
      continue;
    }

    // The clause: names, `as`, `*`, commas and braced lists (names may be keywords or strings).
    let star = false;
    let read = false;
    let found: string | undefined;
    for (let guard = 0; guard < 400 && i < source.length; guard++) {
      i = skipSpace(source, i);
      const c = source[i]!;
      if (c === '{') {
        const end = source.indexOf('}', i);
        // A braced list holds names, `as`, `type`, commas and quoted names: nothing else.
        if (end === -1 || !/^[\s\w$,]*(?:(['"])[^'"\n]*\1[\s\w$,]*)*$/.test(source.slice(i + 1, end))) break;
        i = end + 1; read = true; continue;
      }
      if (c === '*') { star = !read; i++; read = true; continue; }
      if (c === ',') { i++; continue; }
      const w = wordAt(source, i);
      if (w === undefined) break;
      if (w === 'from' && read) {
        const str = stringAt(source, skipSpace(source, i + 4));
        if (str) { found = str.value; break; }
      }
      if (word === 'import' && read && source[skipSpace(source, i + w.length)] === '=') break;
      i += w.length; read = true;
      // `import x = require('y')`: the require pattern reads it.
      if (word === 'import' && source[skipSpace(source, i)] === '=') { found = ''; break; }
    }
    if (found === '') continue;
    if (found === undefined) {
      // `export { a, b }` exports local names; anything else is a statement it couldn't read.
      if (word === 'export' && !star && /^\s*(?:type\s+)?\{[^}]*\}/.test(source.slice(skipSpace(source, at + 6)))) continue;
      fail();
      continue;
    }
    specs.push({ spec: found, kind: typeOnly ? 'type' : word === 'export' ? (star ? 'star' : 'reexport') : 'static' });
  }
  return { specs, unparsed };
};

const BARREL_STATEMENT = /^(?:import\b|export\s+(?:type\s+)?(?:\*|\{)[^]*?\bfrom\b|export\s+(?:type\s+)?\{[^}]*\}$|['"]use [a-z]+['"]$)/;

/** What a module names, by kind. */
export const parseModule = (text: string): Parsed => {
  if (text.length > MAX_BYTES) return { specs: [], computed: 0, contexts: 0, unparsed: [], barrel: false, tooLarge: true };
  const source = stripComments(text);
  // Only `import type` and `export type` load nothing: `import { type X }` keeps its import under
  // `verbatimModuleSyntax`, so it loads the module and counts as a value.
  const { specs, unparsed } = scanStatements(source);
  for (const m of source.matchAll(DYNAMIC)) specs.push({ spec: m[2] ?? m[3] ?? '', kind: 'dynamic' });
  for (const m of source.matchAll(REQUIRE)) specs.push({ spec: m[2] ?? '', kind: 'require' });
  for (const m of source.matchAll(URL_REF)) specs.push({ spec: m[2] ?? '', kind: 'url' });
  // One glob call's patterns, in order, as one specifier: its `!` patterns take paths back out.
  for (const m of source.matchAll(GLOB)) specs.push({ spec: [...(m[1] ?? '').matchAll(/'([^']*)'|"([^"]*)"/g)].map((g) => g[1] ?? g[2] ?? '').join('\n'), kind: 'glob' });

  const computed = [...source.matchAll(COMPUTED)].length;
  const contexts = [...source.matchAll(/\brequire\.context\(/g)].length;
  const statements = source.split(/;|\n(?=\s*(?:import|export)\b)/).map((s) => s.trim()).filter(Boolean);
  const barrel = specs.some((s) => REEXPORTS.has(s.kind)) && statements.every((s) => BARREL_STATEMENT.test(s));

  return { specs, computed, contexts, unparsed, barrel, tooLarge: false };
};

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

const EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.vue', '.svelte'];
const JS_TO_TS: ReadonlyArray<readonly [RegExp, ReadonlyArray<string>]> = [[/\.js$/, ['.ts', '.tsx', '.d.ts']], [/\.jsx$/, ['.tsx']], [/\.mjs$/, ['.mts', '.d.mts']], [/\.cjs$/, ['.cts', '.d.cts']]];

/** The tracked file a path names as TypeScript and bundlers look it up: itself, with an extension, `.js` for `.ts`, or a folder's index. */
const fileFor = (path: string, tracked: ReadonlySet<string>) => {
  if (tracked.has(path)) return path;
  for (const ext of EXTENSIONS) if (tracked.has(path + ext)) return path + ext;
  for (const [re, exts] of JS_TO_TS) if (re.test(path)) for (const ext of exts) { const p = path.replace(re, ext); if (tracked.has(p)) return p; }
  for (const ext of EXTENSIONS) if (tracked.has(`${path}/index${ext}`)) return `${path}/index${ext}`;
  return undefined;
};

/** Build output whose source sits beside it by convention: `dist/x.js` for `src/x.ts`. */
const sourceGuess = (path: string, tracked: ReadonlySet<string>) => {
  const swapped = path.replace(/\/(dist|build|lib|out)\//, '/src/').replace(/\.d\.[cm]?ts$/, '.js');
  return swapped === path ? undefined : fileFor(swapped, tracked);
};

/** Each condition path and target an `exports` value names, in document order. */
const targetsOf = (target: Target, conditions: ReadonlyArray<string> = []): Array<{ conditions: ReadonlyArray<string>; path: string }> => {
  if (typeof target === 'string') return [{ conditions, path: target }];
  if (target === null) return [];
  if (Array.isArray(target)) return target.flatMap((t) => targetsOf(t, conditions));
  return Object.entries(target).flatMap(([c, t]) => targetsOf(t as Target, [...conditions, c]));
};

/** The `exports` map as keys, a bare-string or condition-only value as the `.` key. */
export const exportKeys = (manifest: Manifest): ReadonlyMap<string, Target> => {
  const exports = manifest.exports;
  if (exports === undefined) return new Map();
  if (typeof exports === 'string' || Array.isArray(exports) || exports === null) return new Map([['.', exports]]);
  const keys = Object.keys(exports);
  if (keys.length > 0 && keys.every((k) => !k.startsWith('.'))) return new Map([['.', exports]]);
  return new Map(Object.entries(exports).filter(([k]) => k.startsWith('.')) as Array<[string, Target]>);
};

/** A map like `exports` or `imports`, built once: exact keys, and `*` patterns in the order Node tries them. */
export interface KeyMap {
  readonly exact: ReadonlyMap<string, Target>;
  readonly patterns: ReadonlyArray<{ readonly key: string; readonly before: string; readonly after: string; readonly target: Target }>;
}

export const keyMap = (entries: Iterable<readonly [string, Target]>): KeyMap => {
  const exact = new Map<string, Target>();
  const patterns: Array<KeyMap['patterns'][number]> = [];
  for (const [key, target] of entries) {
    const at = key.indexOf('*');
    if (at === -1) exact.set(key, target);
    else patterns.push({ key, before: key.slice(0, at), after: key.slice(at + 1), target });
  }
  // Node's PATTERN_KEY_COMPARE: the longest prefix before `*` first, then the longest key.
  patterns.sort((a, b) => b.before.length - a.before.length || b.key.length - a.key.length);
  return { exact, patterns };
};

/** The key a subpath matches: exact first, then the first pattern in Node's order whose `*` stands for something. */
export const matchKey = (map: KeyMap, subpath: string): { key: string; target: Target; star?: string } | undefined => {
  if (map.exact.has(subpath)) return { key: subpath, target: map.exact.get(subpath)! };
  for (const p of map.patterns) {
    if (subpath.length > p.before.length + p.after.length && subpath.startsWith(p.before) && subpath.endsWith(p.after)) {
      return { key: p.key, target: p.target, star: subpath.slice(p.before.length, subpath.length - p.after.length) };
    }
  }
  return undefined;
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

/** What an import loads: runtime code through `import` or `require`, or only types through `import type`. */
export type Mode = 'esm' | 'cjs' | 'types';

export const modeOf = (kind: Kind): Mode => (kind === 'type' ? 'types' : kind === 'require' ? 'cjs' : 'esm');

const TYPES = ['types', 'typings'];
const NOT_IN: Readonly<Record<Mode, ReadonlyArray<string>>> = { esm: ['require', ...TYPES], cjs: ['import', 'module', ...TYPES], types: [] };

const BUILTINS = new Set(builtinModules);

const splitName = (spec: string) => {
  const parts = spec.split('/');
  const n = spec.startsWith('@') ? 2 : 1;
  return { name: parts.slice(0, n).join('/'), sub: parts.slice(n).join('/') };
};

/**
 * The tracked file a target names for `mode`. Targets go in document order (or `preferred`
 * conditions' order when given), each tried as itself and then by extension before the next.
 * A runtime import skips `types` and the other format's conditions, falling back to a `types`
 * target only when it names source, and only as a guess; `import type` tries `types` first.
 */
const pickTarget = (pkgDir: string, target: Target, star: string | undefined, tracked: ReadonlySet<string>, preferred: ReadonlyArray<string>, mode: Mode) => {
  const all = targetsOf(target).map((t) => ({ ...t, path: posix.normalize(posix.join(pkgDir, star === undefined ? t.path : t.path.replaceAll('*', star))) }));
  const rank = (t: { conditions: ReadonlyArray<string> }) => {
    if (mode === 'types' && t.conditions.some((c) => TYPES.includes(c))) return -1;
    const i = preferred.findIndex((c) => t.conditions.includes(c));
    return i === -1 ? preferred.length : i;
  };
  const ordered = [...all].sort((a, b) => rank(a) - rank(b));
  const runtime = ordered.filter((t) => !t.conditions.some((c) => NOT_IN[mode].includes(c)));
  const typesOnly = mode === 'types' ? [] : ordered.filter((t) => t.conditions.some((c) => TYPES.includes(c)) && !runtime.includes(t));

  for (const t of runtime) { const f = fileFor(t.path, tracked); if (f) return { file: f }; }
  for (const t of runtime) { const f = sourceGuess(t.path, tracked); if (f) return { file: f, guessed: true }; }
  for (const t of typesOnly) {
    const f = fileFor(t.path, tracked) ?? sourceGuess(t.path, tracked);
    if (f && !/\.d\.[cm]?ts$/.test(f)) return { file: f, guessed: true };
  }
  return undefined;
};

/** Whether a target excludes the subpath: `null`, or conditions that are all `null`. */
const excluded = (target: Target) => target === null || targetsOf(target).length === 0;

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

  /** The pick for `mode`, plus the other runtime format's file when the entry names a different one. */
  const pickBoth = (pkgDir: string, target: Target, star: string | undefined, mode: Mode) => {
    const picked = pickTarget(pkgDir, target, star, tracked, conditions, mode);
    if (!picked || mode === 'types') return picked;
    const other = pickTarget(pkgDir, target, star, tracked, conditions, mode === 'esm' ? 'cjs' : 'esm');
    return other && other.file !== picked.file && !other.guessed ? { ...picked, also: [other.file] } : picked;
  };

  const fromFields = (pkg: Package, mode: Mode) => {
    const m = pkg.manifest;
    const runtime = mode === 'cjs' ? [m.source, m.main, m.module] : [m.source, m.module, m.main];
    const fields = mode === 'types' ? [m.types, ...runtime] : runtime;
    for (const field of fields) if (typeof field === 'string') { const f = pickTarget(pkg.dir, field, undefined, tracked, [], mode); if (f) return f; }
    if (mode !== 'types' && typeof m.types === 'string') {
      const f = sourceGuess(posix.join(pkg.dir, m.types), tracked);
      if (f) return { file: f, guessed: true };
    }
    const index = fileFor(posix.join(pkg.dir, 'src/index'), tracked) ?? fileFor(posix.join(pkg.dir, 'index'), tracked);
    return index ? { file: index } : undefined;
  };

  const uncachedEntry = (pkg: Package, sub: string, mode: Mode): Resolution => {
    const map = exportsOf(pkg);
    const subpath = sub === '' ? '.' : `./${sub}`;
    const at = { pkg: pkg.name, entry: subpath, via: 'workspace' as const };
    if (map.exact.size > 0 || map.patterns.length > 0) {
      const match = matchKey(map, subpath);
      if (!match || excluded(match.target)) return { ...at, unresolved: 'not-exported' };
      const picked = pickBoth(pkg.dir, match.target, match.star, mode);
      const pattern = match.star === undefined ? {} : { pattern: match.key };
      return picked ? { ...picked, ...at, ...pattern } : { ...at, ...pattern, unresolved: 'built-only' };
    }
    if (sub !== '') {
      const own = fileFor(posix.join(pkg.dir, sub), tracked);
      const f = own ?? sourceGuess(posix.join(pkg.dir, sub), tracked);
      return f ? { file: f, ...at, ...(own ? {} : { guessed: true }) } : { ...at, unresolved: 'missing' };
    }
    const picked = fromFields(pkg, mode);
    return picked ? { ...picked, ...at } : { ...at, unresolved: 'built-only' };
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
      if (!match || excluded(match.target)) return { unresolved: 'missing', via: 'imports' };
      const local = targetsOf(match.target).some((t) => t.path.startsWith('.'));
      if (local) {
        const picked = pickBoth(pkg.dir, match.target, match.star, mode);
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
