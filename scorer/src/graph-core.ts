// What the scorer and `scripts/graph/` both read the same way: package manifests' `exports` resolved to files by
// Node's rules, modules' imports and re-exports, the task graph from Turborepo, Nx, Vite+ and package scripts, the
// graph helpers and the thresholds flags use. Each function takes paths and text, never Git or GitHub, so the scorer
// feeds it files from GitHub's blob batches and the tool feeds it committed trees.
//
// `scripts/graph/` runs with Node alone and no install, so this file imports nothing but Node's own modules and uses
// only TypeScript that Node strips: the tool imports it by path, and the scorer builds it with the rest of `src/`.
import { posix } from 'node:path';

// ---------- lenient JSON ----------

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

export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The strings of an array; anything else is none. */
export const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** The strings of an array, or a single string as one. */
const stringOrList = (value: unknown): string[] => (typeof value === 'string' ? [value] : strings(value));

// ---------- globs ----------

const compiledGlobs = new Map<string, RegExp>();

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
      if (end === -1) {
        source += '\\{';
        continue;
      }
      source += `(?:${glob.slice(i + 1, end).split(',').map((part) => globToRegExp(part).source.slice(1, -1)).join('|')})`;
      i = end;
    } else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end === -1) {
        source += '\\[';
        continue;
      }
      source += `[${glob.slice(i + 1, end).replace(/^!/, '^')}]`;
      i = end;
    } else source += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  const re = new RegExp(`^${source}$`);
  compiledGlobs.set(glob, re);
  return re;
};

/** A matcher for a list of globs, `!` ones taking paths back out, in order. */
export const globList = (globs: ReadonlyArray<string>) => {
  const compiled = globs.map((glob) => ({ out: glob.startsWith('!'), re: globToRegExp(glob.replace(/^!/, '').replace(/^\.\//, '')) }));
  return (path: string) => {
    let hit = false;
    for (const { out, re } of compiled) if (out ? hit : !hit) if (re.test(path)) hit = !out;
    return hit;
  };
};

// ---------- packages ----------

/** What an `exports` or `imports` key names: a path, conditions that each name one, a list, or nothing. */
export type Target = string | null | ReadonlyArray<Target> | { readonly [condition: string]: Target };

/** The package.json fields read here. */
export interface PackageJson {
  readonly name?: string;
  readonly private?: boolean;
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
  readonly manifest: PackageJson;
  /** Workspace packages it names in its manifest, by kind. */
  readonly deps: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Packages from their manifests, by directory (`''` or `dir/`): each named by its `name`, else `(root)` or its
 * directory, with a second of a name told apart by its directory, and its dependencies on the others by kind. Deepest
 * directory first, so `ownerOf` finds a nested package before its parent.
 */
export const packagesOf = (manifests: ReadonlyMap<string, PackageJson>): Package[] => {
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
    deps: new Map(DEPENDENCY_KINDS.map((kind) => [kind, new Set(Object.keys(record(manifest[kind])).filter((n) => byName.has(n) && n !== names.get(dir)))])),
  }));
  packages.sort((a, b) => b.dir.length - a.dir.length || a.name.localeCompare(b.name));
  return packages;
};

/** The package that holds a path: the deepest whose directory it's in, the root last. */
export const ownerOf = (path: string, packages: ReadonlyArray<Package>) => packages.find((p) => path.startsWith(p.dir)) ?? packages[packages.length - 1]!;

// ---------- modules: what each names ----------

export const MODULE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;
/** Files over this many bytes aren't parsed: bundles and generated code. */
export const MAX_MODULE_BYTES = 1024 * 1024;

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
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
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

const skipSpace = (source: string, at: number) => {
  while (at < source.length && /\s/.test(source[at]!)) at++;
  return at;
};

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
      if (!(next === 'from' && stringAt(source, skipSpace(source, after + 4)))) {
        typeOnly = true;
        i = after;
      }
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
        i = end + 1;
        read = true;
        continue;
      }
      if (c === '*') {
        star = !read;
        i++;
        read = true;
        continue;
      }
      if (c === ',') {
        i++;
        continue;
      }
      const w = wordAt(source, i);
      if (w === undefined) break;
      if (w === 'from' && read) {
        const str = stringAt(source, skipSpace(source, i + 4));
        if (str) {
          found = str.value;
          break;
        }
      }
      if (word === 'import' && read && source[skipSpace(source, i + w.length)] === '=') break;
      i += w.length;
      read = true;
      // `import x = require('y')`: the require pattern reads it.
      if (word === 'import' && source[skipSpace(source, i)] === '=') {
        found = '';
        break;
      }
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
  if (text.length > MAX_MODULE_BYTES) return { specs: [], computed: 0, contexts: 0, unparsed: [], barrel: false, tooLarge: true };
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

// ---------- entry points: `exports`, by Node's rules ----------

const EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.vue', '.svelte'];
const JS_TO_TS: ReadonlyArray<readonly [RegExp, ReadonlyArray<string>]> = [[/\.js$/, ['.ts', '.tsx', '.d.ts']], [/\.jsx$/, ['.tsx']], [/\.mjs$/, ['.mts', '.d.mts']], [/\.cjs$/, ['.cts', '.d.cts']]];

/** The tracked file a path names as TypeScript and bundlers look it up: itself, with an extension, `.js` for `.ts`, or a folder's index. */
export const fileFor = (path: string, tracked: ReadonlySet<string>) => {
  if (tracked.has(path)) return path;
  for (const ext of EXTENSIONS) if (tracked.has(path + ext)) return path + ext;
  for (const [re, exts] of JS_TO_TS)
    if (re.test(path))
      for (const ext of exts) {
        const p = path.replace(re, ext);
        if (tracked.has(p)) return p;
      }
  for (const ext of EXTENSIONS) if (tracked.has(`${path}/index${ext}`)) return `${path}/index${ext}`;
  return undefined;
};

/** Build output whose source sits beside it by convention: `dist/x.js` for `src/x.ts`, in a package's folder or at the root. */
export const sourceGuess = (path: string, tracked: ReadonlySet<string>) => {
  const swapped = path.replace(/(^|\/)(dist|build|lib|out)\//, '$1src/').replace(/\.d\.[cm]?ts$/, '.js');
  return swapped === path ? undefined : fileFor(swapped, tracked);
};

/** Each condition path and target an `exports` value names, in document order. */
export const targetsOf = (target: Target, conditions: ReadonlyArray<string> = []): Array<{ conditions: ReadonlyArray<string>; path: string }> => {
  if (typeof target === 'string') return [{ conditions, path: target }];
  if (target === null) return [];
  if (Array.isArray(target)) return target.flatMap((t) => targetsOf(t, conditions));
  return Object.entries(target).flatMap(([c, t]) => targetsOf(t as Target, [...conditions, c]));
};

/** The `exports` map as keys, a bare-string or condition-only value as the `.` key. */
export const exportKeys = (manifest: PackageJson): ReadonlyMap<string, Target> => {
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

/** What an import loads: runtime code through `import` or `require`, or only types through `import type`. */
export type Mode = 'esm' | 'cjs' | 'types';

export const modeOf = (kind: Kind): Mode => (kind === 'type' ? 'types' : kind === 'require' ? 'cjs' : 'esm');

const TYPES = ['types', 'typings'];
const NOT_IN: Readonly<Record<Mode, ReadonlyArray<string>>> = { esm: ['require', ...TYPES], cjs: ['import', 'module', ...TYPES], types: [] };

/** The file one entry or `imports` key loads: `guessed` when it came by the `dist` → `src` convention. */
export interface Pick {
  readonly file: string;
  readonly guessed?: boolean;
  /** Other runtime files the same entry names: its CommonJS target beside its ESM one, or the reverse. */
  readonly also?: ReadonlyArray<string>;
}

/**
 * The tracked file a target names for `mode`. Targets go in document order (or `preferred`
 * conditions' order when given), each tried as itself and then by extension before the next.
 * A runtime import skips `types` and the other format's conditions, falling back to a `types`
 * target only when it names source, and only as a guess; `import type` tries `types` first.
 */
export const pickTarget = (pkgDir: string, target: Target, star: string | undefined, tracked: ReadonlySet<string>, preferred: ReadonlyArray<string>, mode: Mode): Pick | undefined => {
  const all = targetsOf(target).map((t) => ({ ...t, path: posix.normalize(posix.join(pkgDir, star === undefined ? t.path : t.path.replaceAll('*', star))) }));
  const rank = (t: { conditions: ReadonlyArray<string> }) => {
    if (mode === 'types' && t.conditions.some((c) => TYPES.includes(c))) return -1;
    const i = preferred.findIndex((c) => t.conditions.includes(c));
    return i === -1 ? preferred.length : i;
  };
  const ordered = [...all].sort((a, b) => rank(a) - rank(b));
  const runtime = ordered.filter((t) => !t.conditions.some((c) => NOT_IN[mode].includes(c)));
  const typesOnly = mode === 'types' ? [] : ordered.filter((t) => t.conditions.some((c) => TYPES.includes(c)) && !runtime.includes(t));

  for (const t of runtime) {
    const f = fileFor(t.path, tracked);
    if (f) return { file: f };
  }
  for (const t of runtime) {
    const f = sourceGuess(t.path, tracked);
    if (f) return { file: f, guessed: true };
  }
  for (const t of typesOnly) {
    const f = fileFor(t.path, tracked) ?? sourceGuess(t.path, tracked);
    if (f && !/\.d\.[cm]?ts$/.test(f)) return { file: f, guessed: true };
  }
  return undefined;
};

/** Whether a target excludes the subpath: `null`, or conditions that are all `null`. */
export const excludes = (target: Target) => target === null || targetsOf(target).length === 0;

/** The pick for `mode`, plus the other runtime format's file when the entry names a different one. */
export const pickBoth = (pkgDir: string, target: Target, star: string | undefined, tracked: ReadonlySet<string>, preferred: ReadonlyArray<string>, mode: Mode): Pick | undefined => {
  const picked = pickTarget(pkgDir, target, star, tracked, preferred, mode);
  if (!picked || mode === 'types') return picked;
  const other = pickTarget(pkgDir, target, star, tracked, preferred, mode === 'esm' ? 'cjs' : 'esm');
  return other && other.file !== picked.file && !other.guessed ? { ...picked, also: [other.file] } : picked;
};

/** The root entry of a package without `exports`: `source`, `module` or `main` as `mode` orders them, then `types` as a guess, then an index. */
const fromFields = (pkg: { readonly dir: string; readonly manifest: PackageJson }, tracked: ReadonlySet<string>, mode: Mode): Pick | undefined => {
  const m = pkg.manifest;
  const runtime = mode === 'cjs' ? [m.source, m.main, m.module] : [m.source, m.module, m.main];
  const fields = mode === 'types' ? [m.types, ...runtime] : runtime;
  for (const field of fields)
    if (typeof field === 'string') {
      const f = pickTarget(pkg.dir, field, undefined, tracked, [], mode);
      if (f) return f;
    }
  if (mode !== 'types' && typeof m.types === 'string') {
    const f = sourceGuess(posix.join(pkg.dir, m.types), tracked);
    if (f) return { file: f, guessed: true };
  }
  const index = fileFor(posix.join(pkg.dir, 'src/index'), tracked) ?? fileFor(posix.join(pkg.dir, 'index'), tracked);
  return index ? { file: index } : undefined;
};

/** Why an entry names no tracked file. */
export type EntryMiss = 'not-exported' | 'built-only' | 'missing';

export type EntryResult = (Pick & { readonly pattern?: string; readonly unresolved?: undefined }) | { readonly unresolved: EntryMiss; readonly pattern?: string };

/**
 * The file a package's subpath (`''` for the root) loads for `mode`: through its `exports`, by Node's rules, with a
 * `null` target excluding; without `exports`, the subpath's own file, or for the root its fields. `map` is
 * `keyMap(exportKeys(manifest))`, built once by the caller.
 */
export const entryOf = (pkg: { readonly dir: string; readonly manifest: PackageJson }, map: KeyMap, sub: string, mode: Mode, tracked: ReadonlySet<string>, conditions: ReadonlyArray<string>): EntryResult => {
  const subpath = sub === '' ? '.' : `./${sub}`;
  if (map.exact.size > 0 || map.patterns.length > 0) {
    const match = matchKey(map, subpath);
    if (!match || excludes(match.target)) return { unresolved: 'not-exported' };
    const picked = pickBoth(pkg.dir, match.target, match.star, tracked, conditions, mode);
    const pattern = match.star === undefined ? {} : { pattern: match.key };
    return picked ? { ...picked, ...pattern } : { ...pattern, unresolved: 'built-only' };
  }
  if (sub !== '') {
    const own = fileFor(posix.join(pkg.dir, sub), tracked);
    const f = own ?? sourceGuess(posix.join(pkg.dir, sub), tracked);
    return f ? { file: f, ...(own ? {} : { guessed: true }) } : { unresolved: 'missing' };
  }
  return fromFields(pkg, tracked, mode) ?? { unresolved: 'built-only' };
};

// ---------- graph helpers and thresholds ----------

/** A finding, for a person or a page to draw: what it is, about what, its numbers, and the threshold it crossed. */
export interface Flag {
  readonly kind: string;
  readonly subject: string;
  readonly numbers: Readonly<Record<string, number>>;
  readonly threshold: Readonly<Record<string, number>> | null;
  readonly detail?: string;
}

/**
 * The thresholds flags use, in the scorer and `scripts/graph/` alike; each flag carries the one it crossed.
 *
 * An entry is overloaded at 20 modules re-exported to 3 packages. Under 3 importing packages, splitting the entry
 * spares at most 2 packages' checks per edit, which a package-level selector already pays; under 20 modules, most
 * importers use most of it, which is guide section 21's "skip when". At both, every edit to one of those 20 modules
 * reaches every importer's checks, 60 package-module pairs at the least, and the section's split cut that kind of
 * selection by two thirds (502 test files to 164).
 */
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
      index.set(node, counter);
      low.set(node, counter);
      counter++;
      stack.push(node);
      onStack.add(node);
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
      if (work.length > 0) {
        const parent = work[work.length - 1]!.node;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.node)!));
      }
      if (low.get(top.node) === index.get(top.node)) {
        const scc: string[] = [];
        for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
          onStack.delete(n);
          scc.push(n);
          if (n === top.node) break;
        }
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
  sccs.forEach((scc, i) => {
    for (const n of scc) of.set(n, i);
  });
  const depth: number[] = [];
  const via: Array<number | undefined> = [];
  sccs.forEach((scc, i) => {
    let best = 0;
    let through: number | undefined;
    for (const n of scc)
      for (const to of next(n)) {
        const j = of.get(to)!;
        if (j !== i && depth[j]! + 1 > best) {
          best = depth[j]! + 1;
          through = j;
        }
      }
    depth[i] = best;
    via[i] = through;
  });
  const deepest = depth.reduce((b, d, i) => (d > depth[b]! ? i : b), 0);
  const chain: string[] = [];
  for (let i: number | undefined = sccs.length > 0 ? deepest : undefined; i !== undefined; i = via[i]) chain.push(sccs[i]!.join(' + '));
  return { depth: new Map(nodes.map((n) => [n, depth[of.get(n)!]!])), cycles: sccs.filter((s) => s.length > 1), chain };
};

const share = (count: number, of: number) => (of === 0 ? 0 : Math.round((count / of) * 10000) / 10000);

// ---------- tasks: Turborepo, Nx, Vite+ and package scripts ----------

export type Runner = 'turbo' | 'nx' | 'vite-plus' | 'script';

/** How a task's inputs are known: globs it declares, its runner's whole-package default, automatic tracking, none at all, or unreadable config. */
export type InputMode = 'declared' | 'package-default' | 'auto' | 'empty' | 'unknown';

export interface Task {
  readonly id: string;
  readonly pkg: string;
  readonly name: string;
  readonly runner: Runner;
  readonly command?: string;
  readonly cached: boolean;
  readonly mode: InputMode;
  /** Repo-relative globs the task declares, `!` ones excluding. */
  readonly inputs: ReadonlyArray<string>;
  readonly outputs: ReadonlyArray<string>;
  /** Whether a path is one of the task's inputs, its runner's global inputs included. */
  readonly matches: (path: string) => boolean;
  /** A path prefix every input sits under, so a caller scans only those files; `''` for anywhere. */
  readonly prefix: string;
}

export type How = 'dependsOn' | 'dependencies' | 'calls' | 'fan-out' | 'lifecycle';

export interface TaskEdge {
  readonly from: string;
  readonly to: string;
  readonly how: How;
}

export interface TaskGraph {
  readonly runners: ReadonlyArray<Runner>;
  readonly tasks: ReadonlyMap<string, Task>;
  readonly edges: ReadonlyArray<TaskEdge>;
  /** Config the reader couldn't follow: a Vite+ config that isn't a literal, Nx plugins, a filter it can't read. */
  readonly unread: ReadonlyArray<string>;
}

/**
 * The object literal that starts at `text[at]` (a `{`), as JSON data, or undefined when it holds
 * anything but literals: a variable, a call, a spread, a function or a template with `${`.
 */
export const objectLiteral = (text: string, at: number): unknown => {
  let i = at;
  let json = '';
  let depth = 0;
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text.startsWith('//', i)) {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        i = end === -1 ? text.length : end + 2;
        continue;
      }
      break;
    }
  };
  for (;;) {
    skip();
    const c = text[i];
    if (c === undefined) return undefined;
    if (c === '{' || c === '[') {
      depth++;
      json += c;
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      depth--;
      json = json.replace(/,$/, '') + c;
      i++;
      if (depth === 0) break;
      continue;
    }
    if (c === ',' || c === ':') {
      json += c;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let value = '';
      for (i++; i < text.length && text[i] !== c; i++) {
        if (text[i] === '\\') {
          value += text[i + 1] ?? '';
          i++;
          continue;
        }
        if (c === '`' && text[i] === '$' && text[i + 1] === '{') return undefined;
        value += text[i];
      }
      i++;
      json += JSON.stringify(value);
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*|^-?\d+(?:\.\d+)?/.exec(text.slice(i, i + 200))?.[0];
    if (word === undefined) return undefined;
    i += word.length;
    skip();
    if (text[i] === ':') json += JSON.stringify(word);
    else if (/^(?:true|false|null|-?\d)/.test(word)) json += word;
    else return undefined;
  }
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

/** The `run` block of a Vite+ config, when it's a literal: `{ tasks, cache }`, or `'unreadable'`. */
export const vitePlusRun = (text: string): Record<string, unknown> | 'unreadable' | undefined => {
  const at = /\brun\s*:\s*\{/.exec(text);
  if (!at) return undefined;
  const value = objectLiteral(text, at.index + at[0].length - 1);
  return value === undefined ? 'unreadable' : (value as Record<string, unknown>);
};

const PM_COMMANDS = new Set(['install', 'i', 'add', 'remove', 'rm', 'exec', 'dlx', 'x', 'publish', 'pack', 'link', 'why', 'outdated', 'update', 'up', 'init', 'create', 'config', 'store', 'audit', 'list', 'ls']);

/** A command's parts between `&&`, `||`, `;`, `|` and `&`, outside quotes. */
const segments = (command: string) => {
  const parts: string[] = [];
  let quote = '';
  let part = '';
  for (const c of command) {
    if (quote) {
      if (c === quote) quote = '';
      part += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      part += c;
      continue;
    }
    if (c === '&' || c === '|' || c === ';') {
      parts.push(part);
      part = '';
      continue;
    }
    part += c;
  }
  parts.push(part);
  return parts.filter((p) => p.trim() !== '');
};

/** The scripts a command runs: `{ name, recursive }` for each, `name` possibly a `pkg#task`, or a glob for `run-s build:*`. */
export const scriptCalls = (command: string) => {
  const found: Array<{ name: string; recursive: boolean }> = [];
  for (const raw of segments(command)) {
    const words = raw
      .trim()
      .replace(/(["'])(.*?)\1/g, '$2')
      .replace(/^(?:cross-env\s+(?:\S+=\S+\s+)*|(?:[A-Z_][A-Z0-9_]*=\S*\s+)+)/, '')
      .split(/\s+/)
      .filter(Boolean);
    const [tool, ...rest] = words;
    if (tool === undefined) continue;
    const recursive = rest.some((w) => /^(?:-r|--recursive|-w|--workspaces|--filter|-F|--all|-ws)$/.test(w) || w.startsWith('--filter=') || w.startsWith('--workspace='));
    const args = rest.filter((w, k) => !w.startsWith('-') && !/^(?:--filter|-F|--workspace)$/.test(rest[k - 1] ?? ''));
    if (tool === 'npm' || tool === 'pnpm' || tool === 'yarn' || tool === 'bun') {
      if (args[0] === 'run' || args[0] === 'run-script') {
        if (args[1]) found.push({ name: args[1], recursive });
      } else if (tool === 'npm' && args[0] && ['test', 'start', 'stop', 'restart'].includes(args[0])) found.push({ name: args[0], recursive });
      else if (tool !== 'npm' && args[0] && !PM_COMMANDS.has(args[0]) && !(tool === 'yarn' && args[0] === 'workspace')) found.push({ name: args[0], recursive });
      else if (tool === 'yarn' && args[0] === 'workspaces' && args[1] === 'foreach') {
        const i = args.indexOf('run');
        if (i !== -1 && args[i + 1]) found.push({ name: args[i + 1]!, recursive: true });
      }
    } else if (tool === 'run-s' || tool === 'run-p' || tool === 'npm-run-all') {
      for (const a of args) found.push({ name: a, recursive: false });
    } else if (tool === 'turbo' || (tool === 'npx' && args[0] === 'turbo')) {
      const list = tool === 'turbo' ? args : args.slice(1);
      for (const a of list[0] === 'run' ? list.slice(1) : list) found.push({ name: a, recursive: !a.includes('#') });
    } else if (tool === 'nx' && args[0] === 'run-many') {
      const t = rest.findIndex((w) => w === '-t' || w === '--target' || w === '--targets');
      for (const a of (rest[t + 1] ?? '').split(',').filter(Boolean)) found.push({ name: a, recursive: true });
    } else if (tool === 'nx' && args[0] === 'run' && args[1]?.includes(':')) {
      const [proj, target] = args[1].split(':');
      found.push({ name: `${proj}#${target}`, recursive: false });
    } else if ((tool === 'vp' || tool === 'vpr') && (tool === 'vpr' || args[0] === 'run')) {
      const name = tool === 'vpr' ? args[0] : args[1];
      if (name) found.push({ name, recursive: rest.includes('-r') || rest.includes('--recursive') });
    } else if (tool === 'lerna' && args[0] === 'run' && args[1]) found.push({ name: args[1], recursive: true });
  }
  return found;
};

// A script name as a pattern: `build:*` as npm-run-all reads it, or a `/regex/` as pnpm does.
const escaped = (text: string) => text.replace(/[.+?^$|()[\]{}\\]/g, '\\$&');
const specPattern = (spec: string, star: string) => {
  if (/^\/.+\/$/.test(spec)) return new RegExp(spec.slice(1, -1));
  return new RegExp('^' + spec.split('*').map(escaped).join(star) + '$');
};

const VITE_CONFIGS = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'];

/** The files `readTaskGraph` reads, of these tracked paths: the runners' configs, the root's and each package's. */
export const taskFiles = (paths: Iterable<string>, packages: ReadonlyArray<Package>) => {
  const tracked = new Set(paths);
  const wanted = ['turbo.json', 'nx.json', ...packages.flatMap((p) => [`${p.dir}turbo.json`, ...VITE_CONFIGS.map((f) => p.dir + f)])];
  const projects = [...tracked].filter((p) => /(^|\/)project\.json$/.test(p) && !p.includes('node_modules/'));
  return [...new Set([...wanted.filter((p) => tracked.has(p)), ...projects])];
};

export interface TaskInputs {
  /** Every tracked path. */
  readonly paths: Iterable<string>;
  /** A tracked file's text, or undefined when it couldn't be read; `taskFiles` lists those it asks for. */
  readonly text: (path: string) => string | undefined;
  readonly packages: ReadonlyArray<Package>;
  readonly owner: (path: string) => Package;
  /** Imports between files, from which Nx infers projects' dependencies; none when the import graph isn't read. */
  readonly imports?: Iterable<{ readonly from: string; readonly to: string }>;
}

/** The task graph: each task's dependencies, its declared inputs and outputs, and whether a cache keys it at all. */
export const readTaskGraph = ({ paths, text, packages, owner, imports = [] }: TaskInputs): TaskGraph => {
  const files = new Set(paths);
  const json = (path: string) => record(parseJsonc(text(path) ?? ''));
  const byName = new Map(packages.map((p) => [p.name, p]));
  const byDir = new Map(packages.map((p) => [p.dir, p]));
  const unread: string[] = [];
  type Dep = { spec: string; how: How } | { task: string; kinds: string[] };
  const tasks = new Map<string, Task & { deps: Dep[] }>();
  const runners = new Set<Runner>();
  const prefixOf = (globs: ReadonlyArray<string>) => {
    const literal = globs.filter((g) => !g.startsWith('!')).map((g) => g.slice(0, g.search(/[*?{[]|$/)).replace(/[^/]*$/, ''));
    if (literal.length === 0) return '';
    let common = literal[0]!;
    for (const l of literal) while (!l.startsWith(common)) common = common.slice(0, common.lastIndexOf('/', common.length - 2) + 1);
    return common;
  };
  const ownedBy = (pkg: Package) => (path: string) => owner(path).name === pkg.name;
  const make = (pkg: Package, name: string, runner: Runner, fields: { command?: string; cached: boolean; mode: InputMode; inputs?: string[]; outputs?: string[]; global?: string[]; base?: 'package' | 'none' }) => {
    const inputs = fields.inputs ?? [];
    const declared = globList(inputs.filter((g) => !g.startsWith('!')));
    const excluded = globList(inputs.filter((g) => g.startsWith('!')).map((g) => g.slice(1)));
    const global = globList(fields.global ?? []);
    const own = fields.mode === 'package-default' || fields.mode === 'auto' || fields.base === 'package';
    const base = own ? ownedBy(pkg) : () => false;
    const matches = (path: string) => global(path) || ((base(path) || declared(path)) && !excluded(path));
    // The folder every matching file is under: the package's, widened by any input outside it, such as `$TURBO_ROOT$/…`.
    const prefix = (fields.global ?? []).length > 0 || pkg.dir === '' ? '' : !own && inputs.length === 0 ? pkg.dir : prefixOf([...(own ? [`${pkg.dir}*`] : []), ...inputs]);
    const deps: Dep[] = [];
    return { id: `${pkg.name}#${name}`, pkg: pkg.name, name, runner, ...(fields.command !== undefined ? { command: fields.command } : {}), cached: fields.cached, mode: fields.mode, inputs, outputs: fields.outputs ?? [], matches, prefix, deps };
  };

  // Package scripts, uncached unless a runner below says otherwise.
  const viteRoot = VITE_CONFIGS.find((p) => files.has(p));
  const rootRun = viteRoot ? vitePlusRun(text(viteRoot) ?? '') : undefined;
  const cacheSetting = rootRun && rootRun !== 'unreadable' ? rootRun.cache : undefined;
  const scriptsCached = cacheSetting === true || record(cacheSetting).scripts === true;
  for (const pkg of packages) {
    for (const [name, command] of Object.entries(record(pkg.manifest.scripts))) {
      if (typeof command !== 'string') continue;
      const task = make(pkg, name, 'script', { command, cached: scriptsCached, mode: scriptsCached ? 'auto' : 'unknown' });
      for (const call of scriptCalls(command)) task.deps.push({ spec: call.name, how: call.recursive ? 'fan-out' : 'calls' });
      tasks.set(task.id, task);
    }
    for (const name of Object.keys(record(pkg.manifest.scripts))) {
      for (const prefix of ['pre', 'post']) {
        const other = `${prefix}${name}`;
        if (!pkg.manifest.scripts?.[other]) continue;
        // Running the script runs its `pre` script first and its `post` script after: both are part of it.
        tasks.get(`${pkg.name}#${name}`)?.deps.push({ spec: other, how: 'lifecycle' });
      }
    }
  }

  // Vite+: tasks in each package's config, cached by default, inputs tracked automatically.
  for (const pkg of packages) {
    const config = VITE_CONFIGS.map((f) => pkg.dir + f).find((p) => files.has(p));
    if (!config) continue;
    const run = pkg.dir === '' ? rootRun : vitePlusRun(text(config) ?? '');
    if (run === undefined) continue;
    runners.add('vite-plus');
    if (run === 'unreadable') {
      unread.push(`${config}: \`run\` isn't a plain object literal`);
      continue;
    }
    for (const [name, raw] of Object.entries(record(run.tasks))) {
      const value = typeof raw === 'string' || Array.isArray(raw) ? { command: raw } : record(raw);
      const cache = value.cache;
      const cacheObject = record(cache);
      const input = cacheObject.input as unknown;
      const entries = Array.isArray(input) ? input : undefined;
      const auto = entries === undefined || entries.some((e) => record(e).auto === true);
      const globs = (entries ?? []).flatMap((e) =>
        typeof e === 'string'
          ? [e.startsWith('!') ? `!${posix.join(pkg.dir, e.slice(1))}` : posix.join(pkg.dir, e)]
          : typeof record(e).pattern === 'string'
            ? [record(e).base === 'workspace' ? String(record(e).pattern) : posix.join(pkg.dir, String(record(e).pattern))]
            : [],
      );
      const outputs = stringOrList(cacheObject.output).map((o) => posix.join(pkg.dir, o));
      const task = make(pkg, name, 'vite-plus', {
        command: stringOrList(value.command).join(' && '),
        cached: cache !== false,
        mode: cache === false ? 'unknown' : entries !== undefined && entries.length === 0 ? 'empty' : auto && globs.length === 0 ? 'auto' : 'declared',
        inputs: globs,
        outputs,
        ...(auto ? { base: 'package' as const } : {}),
      });
      for (const dep of Array.isArray(value.dependsOn) ? value.dependsOn : []) {
        if (typeof dep === 'string') task.deps.push({ spec: dep, how: 'dependsOn' });
        else if (typeof record(dep).task === 'string') task.deps.push({ task: String(record(dep).task), kinds: stringOrList(record(dep).from) });
      }
      for (const call of scriptCalls(task.command ?? '')) task.deps.push({ spec: call.name, how: call.recursive ? 'fan-out' : 'calls' });
      tasks.set(task.id, task);
    }
  }

  // Turborepo: a task applies to each package with that script; `pkg#task` and `//#task` to one.
  if (files.has('turbo.json')) {
    runners.add('turbo');
    const root = json('turbo.json');
    const global = stringOrList(root.globalDependencies).map((g) => g.replace(/^\$TURBO_ROOT\$\//, ''));
    const definitions = record(root.tasks ?? root.pipeline);
    const overrides = new Map(packages.filter((p) => p.dir !== '' && files.has(`${p.dir}turbo.json`)).map((p) => [p.name, record(json(`${p.dir}turbo.json`).tasks ?? json(`${p.dir}turbo.json`).pipeline)]));
    const rootPkg = packages.find((p) => p.dir === '');
    for (const pkg of packages) {
      for (const name of Object.keys(record(pkg.manifest.scripts))) {
        const key = pkg.dir === '' ? `//#${name}` : name;
        // `pkg#task` replaces the generic `task` whole, as Turborepo has it; a package's own turbo.json merges over it.
        const specific = pkg.dir === '' ? undefined : definitions[`${pkg.name}#${name}`];
        const config = { ...record(specific ?? definitions[key]), ...record(overrides.get(pkg.name)?.[name]) };
        if (definitions[key] === undefined && specific === undefined && overrides.get(pkg.name)?.[name] === undefined) continue;
        // `inputs: []` is Turborepo's default, every file of the package, as if none were declared.
        const inputs = stringOrList(config.inputs);
        const declared = inputs.length > 0;
        const withDefault = !declared || inputs.includes('$TURBO_DEFAULT$');
        const globs = inputs
          .filter((g) => g !== '$TURBO_DEFAULT$')
          .map((g) => {
            const out = g.startsWith('!');
            const bare = out ? g.slice(1) : g;
            const path = bare.startsWith('$TURBO_ROOT$/') ? bare.slice('$TURBO_ROOT$/'.length) : posix.join(pkg.dir, bare);
            return out ? `!${path}` : path;
          });
        const previous = tasks.get(`${pkg.name}#${name}`);
        const task = make(pkg, name, 'turbo', {
          ...(previous?.command !== undefined ? { command: previous.command } : {}),
          cached: config.cache !== false,
          mode: declared ? 'declared' : 'package-default',
          inputs: globs,
          outputs: stringOrList(config.outputs).map((o) => (o.startsWith('!') ? `!${posix.join(pkg.dir, o.slice(1))}` : posix.join(pkg.dir, o))),
          global,
          ...(withDefault ? { base: 'package' as const } : {}),
        });
        task.deps.push(...(previous?.deps ?? []));
        for (const dep of stringOrList(config.dependsOn)) {
          if (dep.startsWith('^')) task.deps.push({ task: dep.slice(1), kinds: [] });
          else task.deps.push({ spec: rootPkg ? dep.replace(/^\/\/#/, `${rootPkg.name}#`) : dep, how: 'dependsOn' });
        }
        tasks.set(task.id, task);
      }
    }
  }

  // Nx: project.json targets and package scripts, with nx.json's defaults and named inputs. Nx
  // infers a project's dependencies from its imports too, so they're read from the file graph.
  const inferred = new Map<string, Set<string>>();
  if (files.has('nx.json')) {
    runners.add('nx');
    const nx = json('nx.json');
    const defaults = record(nx.targetDefaults);
    const named = record(nx.namedInputs);
    const cacheable = stringOrList(record(record(record(nx.tasksRunnerOptions).default).options).cacheableOperations);
    if (Array.isArray(nx.plugins) && nx.plugins.length > 0) unread.push(`nx.json: ${nx.plugins.length} plugins infer targets this reader doesn't see`);
    // Nx's order: the defaults keyed by the target's executor, else by its name, else by the longest glob matching its name.
    const defaultGlobs = Object.keys(defaults).filter((k) => /[*?[{]/.test(k)).sort((a, b) => b.length - a.length);
    const targetDefault = (name: string, target: Record<string, unknown>, script: boolean) => {
      const executor = typeof target.executor === 'string' ? target.executor : typeof record(target.options).command === 'string' || target.command !== undefined ? 'nx:run-commands' : script ? 'nx:run-script' : undefined;
      if (executor !== undefined && defaults[executor] !== undefined) return record(defaults[executor]);
      if (defaults[name] !== undefined) return record(defaults[name]);
      const glob = defaultGlobs.find((k) => globToRegExp(k).test(name));
      return glob === undefined ? {} : record(defaults[glob]);
    };
    const projects = new Map<string, { pkg: Package; targets: Record<string, unknown>; named: Record<string, unknown> }>();
    for (const path of [...files].filter((p) => /(^|\/)project\.json$/.test(p) && !p.includes('node_modules/'))) {
      const dir = path.slice(0, -'project.json'.length);
      const project = json(path);
      const pkg = byDir.get(dir) ?? { name: typeof project.name === 'string' ? project.name : dir.replace(/\/$/, ''), dir, manifest: {}, deps: new Map() };
      projects.set(pkg.name, { pkg, targets: record(project.targets), named: record(project.namedInputs) });
    }
    // A package is a project by its scripts, or by targets in its `nx` field alone.
    for (const pkg of packages) if (!projects.has(pkg.name) && (pkg.manifest.scripts || Object.keys(record(record(pkg.manifest.nx).targets)).length > 0)) projects.set(pkg.name, { pkg, targets: {}, named: record(record(pkg.manifest.nx).namedInputs) });
    const roots = [...projects.values()].map((p) => p.pkg).filter((p) => p.dir !== '').sort((a, b) => b.dir.length - a.dir.length);
    const projectOf = (path: string) => roots.find((p) => path.startsWith(p.dir))?.name;
    const add = (from: string, to: string) => (inferred.get(from) ?? inferred.set(from, new Set()).get(from)!).add(to);
    for (const e of imports) {
      const [from, to] = [projectOf(e.from), projectOf(e.to)];
      if (from !== undefined && to !== undefined && from !== to) add(from, to);
    }
    for (const { pkg } of projects.values()) for (const set of pkg.deps.values()) for (const n of set) add(pkg.name, n);
    const projectByName = new Map([...projects.values()].map((p) => [p.pkg.name, p.pkg]));
    for (const { pkg, targets } of projects.values()) {
      const root = pkg.dir.replace(/\/$/, '');
      const names = new Set([...Object.keys(targets), ...Object.keys(record(pkg.manifest.scripts)), ...Object.keys(record(record(pkg.manifest.nx).targets))]);
      for (const name of names) {
        const target = { ...record(record(record(pkg.manifest.nx).targets)[name]), ...record(targets[name]) };
        const config = { ...targetDefault(name, target, name in record(pkg.manifest.scripts)), ...target };
        const globs: string[] = [];
        let other = 0;
        const depPackages = [...(inferred.get(pkg.name) ?? [])].map((n) => projectByName.get(n)).filter((p): p is Package => p !== undefined);
        // An input of this project, or, under `^` or `dependencies: true`, of each dependency, by that project's own
        // root and named inputs, as Nx reads them.
        const expand = (input: unknown, seen: Set<string>, at: Package) => {
          const self = at === pkg;
          const each = (inner: unknown) => {
            if (self) for (const dep of depPackages) expand(inner, new Set(), dep);
          };
          if (typeof input === 'string') {
            const out = input.startsWith('!');
            const bare = out ? input.slice(1) : input;
            if (bare.startsWith('^')) {
              each(out ? `!${bare.slice(1)}` : bare.slice(1));
              return;
            }
            if (bare.includes('{')) {
              const path = bare.replace('{workspaceRoot}/', '').replace('{projectRoot}', at.dir.replace(/\/$/, '')).replace(/^\//, '');
              globs.push(out ? `!${path}` : path);
              return;
            }
            if (seen.has(bare)) return;
            const definition = projects.get(at.name)?.named[bare] ?? named[bare] ?? (bare === 'default' ? ['{projectRoot}/**/*'] : undefined);
            if (definition === undefined) {
              other++;
              return;
            }
            for (const inner of Array.isArray(definition) ? definition : []) expand(inner, new Set([...seen, bare]), at);
            return;
          }
          const object = record(input);
          if (typeof object.fileset === 'string') expand(object.fileset, seen, at);
          else if (typeof object.input === 'string') (object.dependencies === true || object.projects === 'dependencies' ? each(object.input) : expand(object.input, seen, at));
          else other++;
        };
        const declared = Array.isArray(config.inputs);
        for (const input of declared ? (config.inputs as unknown[]) : ['default', '^default']) expand(input, new Set(), pkg);
        const cached = typeof config.cache === 'boolean' ? config.cache : cacheable.includes(name);
        const previous = tasks.get(`${pkg.name}#${name}`);
        const command = typeof record(config.options).command === 'string' ? String(record(config.options).command) : previous?.command;
        const task = make(pkg, name, 'nx', {
          ...(command !== undefined ? { command } : {}),
          cached,
          mode: declared ? ((config.inputs as unknown[]).length === 0 ? 'empty' : 'declared') : 'package-default',
          inputs: [...new Set(globs)],
          outputs: stringOrList(config.outputs).map((o) => o.replace('{workspaceRoot}/', '').replace('{projectRoot}', root).replace(/^\//, '')),
        });
        if (other > 0 && !declared) unread.push(`${task.id}: ${other} named or non-file inputs not read`);
        task.deps.push(...(previous?.deps ?? []));
        for (const dep of Array.isArray(config.dependsOn) ? config.dependsOn : []) {
          if (typeof dep === 'string') {
            if (dep.startsWith('^')) task.deps.push({ task: dep.slice(1), kinds: [] });
            else task.deps.push({ spec: dep.includes(':') ? dep.replace(':', '#') : dep, how: 'dependsOn' });
          } else {
            const o = record(dep);
            const target = String(o.target ?? '');
            if (o.dependencies === true || o.projects === 'dependencies') task.deps.push({ task: target, kinds: [] });
            else for (const p of stringOrList(o.projects).filter((p) => p !== 'self')) task.deps.push({ spec: `${p}#${target}`, how: 'dependsOn' });
            if (o.projects === undefined || o.projects === 'self') if (o.dependencies !== true) task.deps.push({ spec: target, how: 'dependsOn' });
          }
        }
        tasks.set(task.id, task);
      }
    }
  }

  // Edges: a name in the same package, `pkg#task`, a fan-out to every package with that script, or `^task`/`from:` over the package's workspace dependencies.
  const edges: TaskEdge[] = [];
  const byTaskName = new Map<string, string[]>();
  for (const t of tasks.values()) (byTaskName.get(t.name) ?? byTaskName.set(t.name, []).get(t.name)!).push(t.id);
  for (const task of tasks.values()) {
    for (const dep of task.deps) {
      if ('task' in dep) {
        const kinds = dep.kinds.length > 0 ? dep.kinds : [...DEPENDENCY_KINDS];
        const nx = task.runner === 'nx' && dep.kinds.length === 0;
        const depsOf = (name: string) => (nx ? [...(inferred.get(name) ?? [])] : kinds.flatMap((k) => [...(byName.get(name)?.deps.get(k) ?? [])]));
        // Turborepo and Nx pass `^task` on through a dependency without that task, to its own dependencies.
        const transit = task.runner === 'turbo' || task.runner === 'nx';
        const seen = new Set([task.pkg]);
        const waiting = depsOf(task.pkg);
        for (let name = waiting.shift(); name !== undefined; name = waiting.shift()) {
          if (seen.has(name)) continue;
          seen.add(name);
          const to = `${name}#${dep.task}`;
          if (tasks.has(to)) edges.push({ from: task.id, to, how: 'dependencies' });
          else if (transit) waiting.push(...depsOf(name));
        }
        continue;
      }
      if (dep.how === 'fan-out') {
        const re = specPattern(dep.spec, '.*');
        for (const [name, ids] of byTaskName) if (re.test(name)) for (const to of ids) if (to !== task.id) edges.push({ from: task.id, to, how: 'fan-out' });
        continue;
      }
      const hash = dep.spec.lastIndexOf('#');
      if (hash > 0) {
        if (tasks.has(dep.spec)) edges.push({ from: task.id, to: dep.spec, how: dep.how });
        continue;
      }
      const re = specPattern(dep.spec, '[^#]*');
      for (const t of tasks.values()) if (t.pkg === task.pkg && t.id !== task.id && re.test(t.name)) edges.push({ from: task.id, to: t.id, how: dep.how });
    }
  }
  if ([...tasks.values()].some((t) => t.runner === 'script')) runners.add('script');

  const seen = new Set<string>();
  const unique = edges.filter((e) => {
    const k = `${e.from}\0${e.to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const plain = new Map([...tasks].map(([id, { deps: _deps, ...task }]) => [id, task as Task]));
  return { runners: [...runners], tasks: plain, edges: unique, unread };
};

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

/**
 * The task graph measured over the repo's tracked files: each task's inputs counted, the longest chain, and the flags
 * `task-cycle`, `deep-chain`, `no-inputs` (cached with no inputs declared, or empty ones) and `wide-inputs` (cached,
 * with inputs over `THRESHOLDS.wideInputs` of the files). With `partial`, when only some of the files are listed, no
 * task's coverage is counted, so none is flagged wide.
 */
export const taskShape = (tasks: TaskGraph, paths: Iterable<string>, { partial = false }: { partial?: boolean } = {}) => {
  const ids = [...tasks.tasks.keys()];
  const out = new Map<string, string[]>();
  for (const e of tasks.edges) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  const { depth, cycles, chain } = depths(ids, (id) => out.get(id) ?? []);
  const tracked = [...paths].sort();
  const counted = new Map<string, number | null>();
  for (const t of tasks.tasks.values()) {
    // With only part of the tree listed, a count would be against a partial denominator: coverage is unknown.
    if (!t.cached || t.mode === 'unknown' || partial) {
      counted.set(t.id, null);
      continue;
    }
    let n = 0;
    for (const f of tracked) if (f.startsWith(t.prefix) && t.matches(f)) n++;
    counted.set(t.id, n);
  }
  const nodes: TaskNode[] = [...tasks.tasks.values()]
    .map((t) => ({
      id: t.id,
      pkg: t.pkg,
      name: t.name,
      runner: t.runner,
      cached: t.cached,
      inputs: { mode: t.mode, globs: t.inputs, files: counted.get(t.id) ?? null },
      outputs: t.outputs,
      depth: depth.get(t.id) ?? 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const maxDepth = Math.max(0, ...depth.values());
  const flags: Flag[] = [
    ...cycles.map((c) => ({ kind: 'task-cycle', subject: c.join(' ↔ '), numbers: { tasks: c.length }, threshold: null })),
    ...(maxDepth + 1 >= THRESHOLDS.deepChain ? [{ kind: 'deep-chain', subject: chain.join(' → '), numbers: { tasks: maxDepth + 1 }, threshold: { tasks: THRESHOLDS.deepChain } }] : []),
    ...nodes
      .filter((n) => n.cached && (n.inputs.mode === 'package-default' || n.inputs.mode === 'empty'))
      .map((n) => ({
        kind: 'no-inputs',
        subject: n.id,
        numbers: (n.inputs.files === null ? {} : { files: n.inputs.files, filesOf: tracked.length }) as Record<string, number>,
        threshold: null,
        detail: n.inputs.mode === 'empty' ? 'inputs are empty: only the command and env key the cache, so a source change hits it wrongly' : `no declared inputs: ${n.runner}'s default keys every file of the package, so any change there misses`,
      })),
    ...nodes
      .filter((n) => n.cached && n.inputs.mode !== 'auto' && n.inputs.files !== null && share(n.inputs.files, tracked.length) > THRESHOLDS.wideInputs)
      .map((n) => ({
        kind: 'wide-inputs',
        subject: n.id,
        numbers: { files: n.inputs.files!, filesOf: tracked.length, share: share(n.inputs.files!, tracked.length) },
        threshold: { share: THRESHOLDS.wideInputs },
      })),
  ];
  return { nodes, edges: tasks.edges, flags, depth: maxDepth + (ids.length > 0 ? 1 : 0), chain, cached: nodes.filter((n) => n.cached).length };
};
