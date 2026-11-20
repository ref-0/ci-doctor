// What a repo is built with: languages, workspace tools, test runners, lint and format, libraries, CI runners and
// agent files, so repos can be compared by what they share. Every list is what was found; it's null (unknown) when
// nothing was found and some of its inputs couldn't be read, never empty for "none" unless every input was read.
import type { Source } from './source.ts';
import { type Declaration, dirOf, fromGlobs, goWork, isMember, pnpmWorkspace, resolveDir, tomlArray, type Workspace, workspaceOf } from './workspace.ts';

/** How many manifests one report reads, at most: five GraphQL queries' worth. */
export const MAX_MANIFESTS = 500;
/** How many libraries the report keeps. */
export const TOP_LIBRARIES = 20;

export type Ecosystem = 'npm' | 'cargo' | 'go' | 'python' | 'ruby';

const MANIFEST: [RegExp, Ecosystem][] = [
  [/(^|\/)package\.json$/, 'npm'],
  [/(^|\/)Cargo\.toml$/, 'cargo'],
  [/(^|\/)go\.mod$/, 'go'],
  [/(^|\/)pyproject\.toml$/, 'python'],
  [/(^|\/)Gemfile$/, 'ruby'],
];
export const ecosystemOf = (path: string) => MANIFEST.find(([re]) => re.test(path))?.[1];

/** Files at the root whose commands say which tools run, read with the manifests. */
const COMMAND_FILES = ['Makefile', 'justfile', 'Justfile', '.justfile', 'Taskfile.yml', 'tox.ini', 'noxfile.py', 'setup.cfg', 'pytest.ini', '.pre-commit-config.yaml', '.cargo/config.toml', 'lefthook.yml', 'deno.json', 'deno.jsonc'];

// ---------- manifests ----------

export interface Manifest {
  path: string;
  ecosystem: Ecosystem;
  name: string | undefined;
  /** Every dependency it names, of any kind, by its real name, but those on its own workspace's packages by path or protocol. */
  deps: string[];
  /** Every dependency it names, those by path or protocol included: the package graph's edges are the ones on its workspace. */
  links: Link[];
  /** The workspace this manifest declares, from its own directory: `workspaces`, Cargo's or uv's `[workspace]`. */
  workspace?: Workspace;
  /** A Cargo workspace's `[workspace.dependencies]`, by key, which members inherit with `.workspace = true`. */
  inheritable?: Record<string, Link>;
  /** A package.json's `exports`: how many entries it declares and whether one is the root `.`; false with none. */
  exports?: { entries: number; root: boolean } | false;
  /** Text other tools are named in: package.json scripts, or the whole TOML file. */
  text: string;
  /** Why the file says nothing, though it was read, such as a package.json that isn't JSON. */
  unparsed?: string;
}

/** One dependency: the package it names, through any alias or rename, and where it points if by path. */
export interface Link {
  name: string;
  /** For a dependency by path, the directory it points at, from the repo's root; undefined if it leaves the repo. */
  dir?: string;
  /** By path, though `dir` may be undefined: never a registry package. */
  byPath?: boolean;
  /** A Cargo dependency taken from its workspace's `[workspace.dependencies]` under this key, resolved by `inherit`. */
  inherits?: string;
}

const pyName = (s: string) => s.toLowerCase().replace(/[-_.]+/g, '-');
const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '');
const uncomment = (line: string) => line.replace(/\s+#.*$|^\s*#.*$/, '');

/** `exports` as a string, an array or a conditions object is the root alone; an object of `.`-keys is a subpath map. */
export const exportsOf = (exports: unknown): Manifest['exports'] => {
  if (exports === undefined || exports === null) return false;
  if (typeof exports !== 'object' || Array.isArray(exports)) return { entries: 1, root: true };
  const keys = Object.keys(exports);
  if (!keys.some((k) => k.startsWith('.'))) return { entries: keys.length ? 1 : 0, root: keys.length > 0 };
  return { entries: keys.length, root: keys.includes('.') };
};

/**
 * What one package.json dependency names: `"x": "npm:b@1"` and `"x": "workspace:b@*"` are aliases of b, and
 * `file:`, `link:`, `portal:` and `workspace:../b` point at a directory.
 */
const npmLink = (dir: string, key: string, version: string): Link => {
  const byPath = (rel: string) => ({ name: key, dir: resolveDir(dir, rel), byPath: true });
  const local = version.match(/^(?:file|link|portal):(.*)$/)?.[1];
  if (local !== undefined) return byPath(local);
  const ws = version.match(/^workspace:(.*)$/)?.[1];
  if (ws !== undefined && /^[./]/.test(ws)) return byPath(ws);
  const alias = (ws ?? version.match(/^npm:(.*)$/)?.[1])?.match(/^(@[^@/]+\/[^@]+|[^@]+)(?:@|$)/)?.[1];
  // `workspace:*`, `workspace:^1` and `workspace:1.2.3` name the key itself; an alias names a package.
  return { name: alias !== undefined && !/^[\^~*<>=\d]/.test(alias) ? alias : key };
};

const npmManifest = (path: string, text: string): Manifest => {
  let pkg: any;
  let unparsed: string | undefined;
  try {
    pkg = JSON.parse(text);
  } catch {
    pkg = {};
    unparsed = "it isn't valid JSON";
  }
  const dir = dirOf(path);
  const deps: string[] = [];
  const links: Link[] = [];
  for (const kind of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
    for (const [key, version] of Object.entries(pkg?.[kind] ?? {})) {
      const link = npmLink(dir, key, String(version));
      links.push(link);
      if (!link.byPath && !/^workspace:/.test(String(version))) deps.push(link.name);
    }
  const scripts = Object.values(pkg?.scripts ?? {}).map(String).join('\n');
  const globs = Array.isArray(pkg?.workspaces) ? pkg.workspaces : Array.isArray(pkg?.workspaces?.packages) ? pkg.workspaces.packages : undefined;
  return {
    path,
    ecosystem: 'npm',
    name: typeof pkg?.name === 'string' ? pkg.name : undefined,
    deps,
    links,
    exports: exportsOf(pkg?.exports),
    text: scripts,
    ...(globs ? { workspace: fromGlobs(globs.map(String)) } : {}),
    ...(unparsed ? { unparsed } : {}),
  };
};

const DEP_TABLE = /^(?:target\..+\.)?(?:dev-|build-)?dependencies$|^workspace\.dependencies$/;

/**
 * Cargo.toml's dependency tables, by line: `[dependencies]`, `[dev-dependencies.x]`, `[target.'cfg(…)'.build-dependencies]`
 * and the workspace's `[workspace.dependencies]`, with each one's `package =` rename, `path =` and `workspace = true`.
 */
const cargoManifest = (path: string, text: string): Manifest => {
  const dir = dirOf(path);
  let name: string | undefined;
  let table = '';
  let workspace = false;
  interface Entry {
    table: string;
    key: string;
    package?: string;
    path?: string;
    inherits?: boolean;
  }
  const entries = new Map<string, Entry>();
  const entry = (t: string, key: string) => {
    const id = `${t}|${key}`;
    if (!entries.has(id)) entries.set(id, { table: t, key });
    return entries.get(id)!;
  };
  const set = (e: Entry, field: string, value: string) => {
    if (field === 'package') e.package = unquote(value);
    else if (field === 'path') e.path = unquote(value);
    else if (field === 'workspace') e.inherits = /^true\b/.test(value.trim());
  };
  let current: Entry | undefined;

  for (const raw of text.split('\n')) {
    const line = uncomment(raw).trim();
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      table = header[1]!.trim();
      if (table === 'workspace') workspace = true;
      const one = table.match(/^(.*dependencies)\.("?)([\w-]+)\2$/);
      current = one && DEP_TABLE.test(one[1]!) ? entry(one[1]!, one[3]!) : undefined;
      continue;
    }
    if (table === 'package') name ??= line.match(/^name\s*=\s*["']([^"']+)["']/)?.[1];
    if (current) {
      const kv = line.match(/^(\w+)\s*=\s*(.*)$/);
      if (kv) set(current, kv[1]!, kv[2]!);
      continue;
    }
    if (!DEP_TABLE.test(table)) continue;

    const m = line.match(/^("?)([\w-]+)\1\s*(?:\.\s*(\w+)\s*)?=\s*(.*)$/);
    if (!m) continue;
    const e = entry(table, m[2]!);
    if (m[3]) set(e, m[3], m[4]!);
    else for (const field of ['package', 'path', 'workspace']) {
      const v = m[4]!.match(new RegExp(`\\b${field}\\s*=\\s*("[^"]*"|'[^']*'|true|false)`))?.[1];
      if (v) set(e, field, v);
    }
  }

  const deps: string[] = [];
  const links: Link[] = [];
  const inheritable: Record<string, Link> = {};
  for (const e of entries.values()) {
    const link: Link = { name: e.package ?? e.key, ...(e.path !== undefined ? { dir: resolveDir(dir, e.path), byPath: true } : {}) };
    if (e.table === 'workspace.dependencies') inheritable[e.key] = link;
    else if (e.inherits) links.push({ name: e.key, inherits: e.key });
    else {
      links.push(link);
      if (!link.byPath) deps.push(link.name);
    }
  }
  const members = workspace ? { workspace: { members: tomlArray(text, 'workspace', 'members') ?? [], exclude: tomlArray(text, 'workspace', 'exclude') ?? [] }, inheritable } : {};
  return { path, ecosystem: 'cargo', name, deps, links, text, ...members };
};

/**
 * Each Cargo dependency taken with `.workspace = true` as its workspace's `[workspace.dependencies]` names it: its
 * real package, through a `package =` rename, and its path, from the workspace's root.
 */
const inherit = (manifests: Manifest[], declarations: Declaration[]) => {
  const roots = new Map(manifests.filter((m) => m.inheritable).map((m) => [dirOf(m.path), m.inheritable!]));
  return manifests.map((m) => {
    if (m.ecosystem !== 'cargo' || !m.links.some((l) => l.inherits)) return m;
    const from = roots.get(workspaceOf(declarations, 'cargo', dirOf(m.path))?.dir ?? '') ?? {};
    const links = m.links.map((l) => (l.inherits ? from[l.inherits] ?? { name: l.inherits } : l));
    return { ...m, links, deps: [...m.deps, ...m.links.filter((l) => l.inherits).map((l) => from[l.inherits!] ?? { name: l.inherits! }).filter((l) => !l.byPath).map((l) => l.name)] };
  });
};

/** pyproject.toml: PEP 621's arrays, dependency groups, optional dependencies, uv's dev dependencies and Poetry's tables. */
const pythonManifest = (path: string, text: string): Manifest => {
  const deps: string[] = [];
  let name: string | undefined;
  let table = '';
  let inArray = false;
  const internal = new Set<string>();
  const take = (s: string) => {
    for (const q of s.match(/"[^"]*"|'[^']*'/g) ?? []) {
      const dep = unquote(q).match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/)?.[1];
      if (dep) deps.push(pyName(dep));
    }
  };
  for (const raw of text.split('\n')) {
    const line = uncomment(raw).trim();
    if (inArray) {
      take(line);
      if (line.replace(/"[^"]*"|'[^']*'/g, '').includes(']')) inArray = false;
      continue;
    }
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      table = header[1]!.trim();
      continue;
    }
    if (table === 'project') name ??= line.match(/^name\s*=\s*["']([^"']+)["']/)?.[1];

    const arrays =
      (table === 'project' && /^dependencies\s*=/.test(line)) ||
      table === 'project.optional-dependencies' ||
      table === 'dependency-groups' ||
      (table === 'tool.uv' && /^dev-dependencies\s*=/.test(line));
    if (arrays && /=\s*\[/.test(line)) {
      const rest = line.slice(line.indexOf('[') + 1);
      take(rest);
      inArray = !rest.replace(/"[^"]*"|'[^']*'/g, '').includes(']');
      continue;
    }
    const key = line.match(/^("?)([A-Za-z0-9][A-Za-z0-9._-]*)\1\s*=/)?.[2];
    if (key && /^tool\.poetry\.(?:group\.[^.]+\.)?(?:dev-)?dependencies$/.test(table) && key !== 'python') deps.push(pyName(key));
    if (key && table === 'tool.uv.sources' && /workspace\s*=\s*true|path\s*=/.test(line)) internal.add(pyName(key));
  }
  const uv = /^\[tool\.uv\.workspace\]/m.test(text) ? { workspace: { members: tomlArray(text, 'tool.uv.workspace', 'members') ?? [], exclude: tomlArray(text, 'tool.uv.workspace', 'exclude') ?? [] } } : {};
  return { path, ecosystem: 'python', name: name && pyName(name), deps: deps.filter((d) => !internal.has(d)), links: deps.map((d) => ({ name: d })), text, ...uv };
};

const goManifest = (path: string, text: string): Manifest => {
  const deps: string[] = [];
  let block = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^require\s*\($/.test(line)) block = true;
    else if (block && line === ')') block = false;
    const req = block ? line.match(/^(\S+)\s+v\S+(.*)$/) : line.match(/^require\s+(\S+)\s+v\S+(.*)$/);
    if (req && !/\/\/\s*indirect/.test(req[2]!)) deps.push(req[1]!);
  }
  return { path, ecosystem: 'go', name: text.match(/^module\s+(\S+)/m)?.[1], deps, links: deps.map((d) => ({ name: d })), text };
};

// A Gemfile names no package of its own, so it has no place in the package graph.
const rubyManifest = (path: string, text: string): Manifest => ({
  path,
  ecosystem: 'ruby',
  name: undefined,
  deps: [...text.matchAll(/^\s*gem\s+["']([^"']+)["'](?![^\n]*\bpath:)/gm)].map((m) => m[1]!),
  links: [],
  text,
});

export const parseManifest = (path: string, text: string): Manifest | undefined => {
  const eco = ecosystemOf(path);
  if (eco === 'npm') return npmManifest(path, text);
  if (eco === 'cargo') return cargoManifest(path, text);
  if (eco === 'python') return pythonManifest(path, text);
  if (eco === 'go') return goManifest(path, text);
  if (eco === 'ruby') return rubyManifest(path, text);
  return undefined;
};

// ---------- tools ----------

interface Tool {
  name: string;
  /** Dependencies that mean the tool is used, by ecosystem. */
  deps?: Partial<Record<Ecosystem, string[]>>;
  /** Files in the tree that configure it. */
  files?: RegExp;
  /** Commands that run it, in workflows, package scripts or the root's task files. */
  commands?: RegExp;
  /** Text in a Cargo.toml or pyproject.toml that configures it. */
  manifestText?: RegExp;
}

const CONFIG = (base: string) => `(^|/)${base}\\.(config|workspace)\\.[cm]?[jt]s$`;

export const TEST_RUNNERS: Tool[] = [
  // Vite+ bundles Vitest.
  { name: 'Vitest', deps: { npm: ['vitest', 'vite-plus'] }, files: new RegExp(CONFIG('vitest')), commands: /\bvitest\b|\bvp test\b/ },
  { name: 'Jest', deps: { npm: ['jest'] }, files: new RegExp(CONFIG('jest')), commands: /\bjest\b/ },
  { name: 'Playwright', deps: { npm: ['@playwright/test', 'playwright'], python: ['pytest-playwright'] }, files: new RegExp(CONFIG('playwright')), commands: /playwright test/ },
  { name: 'Cypress', deps: { npm: ['cypress'] }, files: /(^|\/)cypress(\.config\.[cm]?[jt]s|\.json)$/, commands: /\bcypress (run|open)\b/ },
  { name: 'Mocha', deps: { npm: ['mocha'] }, files: /(^|\/)\.mocharc(\.\w+)?$/ },
  { name: 'AVA', deps: { npm: ['ava'] } },
  { name: 'node:test', commands: /\bnode\s+(--[\w-]+(=\S+)?\s+)*--test\b/ },
  { name: 'Bun test', commands: /\bbun test\b/ },
  { name: 'Deno test', commands: /\bdeno test\b/ },
  { name: 'cargo nextest', files: /^\.config\/nextest\.toml$/, commands: /\bcargo (\+\S+ )?nextest\b|taiki-e\/install-action@[^\n]*nextest|tool:\s*[^\n]*nextest/ },
  { name: 'cargo test', commands: /\bcargo (\+\S+ )?test\b/ },
  { name: 'go test', commands: /\bgo test\b|\bgotestsum\b/ },
  { name: 'pytest', deps: { python: ['pytest'] }, files: /(^|\/)(pytest\.ini|conftest\.py)$/, commands: /\bpytest\b/, manifestText: /^\[tool\.pytest/m },
  { name: 'RSpec', deps: { ruby: ['rspec', 'rspec-rails'] }, files: /(^|\/)\.rspec$/ },
  { name: 'Minitest', deps: { ruby: ['minitest'] } },
  { name: 'PHPUnit', files: /(^|\/)phpunit\.xml(\.dist)?$/ },
];

export const LINT_FORMAT: Tool[] = [
  { name: 'ESLint', deps: { npm: ['eslint'] }, files: /(^|\/)(\.eslintrc(\.\w+)?|eslint\.config\.[cm]?[jt]s)$/ },
  // Vite+ bundles Oxlint and Oxfmt.
  { name: 'Oxlint', deps: { npm: ['oxlint', 'vite-plus'] }, files: /(^|\/)(\.?oxlintrc\.json|oxlint\.config\.[cm]?[jt]s)$/, commands: /\boxlint\b/ },
  { name: 'Biome', deps: { npm: ['@biomejs/biome'] }, files: /(^|\/)biome\.jsonc?$/ },
  { name: 'Prettier', deps: { npm: ['prettier'] }, files: /(^|\/)(\.prettierrc(\.\w+)?|prettier\.config\.[cm]?[jt]s)$/ },
  { name: 'Oxfmt', deps: { npm: ['oxfmt', 'vite-plus'] }, files: /(^|\/)\.?oxfmtrc\.jsonc?$/, commands: /\boxfmt\b/ },
  { name: 'dprint', deps: { npm: ['dprint'] }, files: /(^|\/)\.?dprint\.jsonc?$/ },
  { name: 'Stylelint', deps: { npm: ['stylelint'] }, files: /(^|\/)(\.stylelintrc(\.\w+)?|stylelint\.config\.[cm]?[jt]s)$/ },
  { name: 'Ruff', deps: { python: ['ruff'] }, files: /(^|\/)\.?ruff\.toml$/, commands: /\bruff (check|format)\b|ruff-pre-commit/, manifestText: /^\[tool\.ruff/m },
  { name: 'Black', deps: { python: ['black'] }, commands: /psf\/black|\bblack (--check|\.)/, manifestText: /^\[tool\.black\]/m },
  { name: 'Flake8', deps: { python: ['flake8'] }, files: /(^|\/)\.flake8$/ },
  { name: 'Pylint', deps: { python: ['pylint'] }, files: /(^|\/)\.?pylintrc$/ },
  { name: 'Clippy', files: /(^|\/)\.?clippy\.toml$/, commands: /\bcargo (\+\S+ )?clippy\b/, manifestText: /^\[(workspace\.)?lints\.clippy\]/m },
  { name: 'rustfmt', files: /(^|\/)\.?rustfmt\.toml$/, commands: /\bcargo (\+\S+ )?fmt\b/ },
  { name: 'golangci-lint', files: /(^|\/)\.golangci\.(ya?ml|toml|json)$/, commands: /golangci-lint/ },
  { name: 'RuboCop', deps: { ruby: ['rubocop'] }, files: /(^|\/)\.rubocop\.yml$/ },
];

// ---------- the package graph ----------

/** How many packages depend on the most depended-on ones, kept in the report. */
export const TOP_FAN_IN = 5;

/**
 * The workspace's packages and their dependencies on each other. A package is a member's manifest, named by its name
 * or, without one, its path; Gemfiles name no package and stay out. Nodes are keyed by path, and an edge goes to the
 * package of the same ecosystem with that name, or, for a dependency by path, at that directory, so an npm package and
 * a crate that share a name stay two. The repo's numbers are null (unknown) unless every manifest, and every file that
 * declares a workspace, was read: a missing one could add packages or edges.
 */
export const packageGraph = (manifests: Manifest[], complete: boolean) => {
  const nodes = manifests.filter((m) => m.ecosystem !== 'ruby');
  const labelOf = new Map(nodes.map((m) => [m.path, m.name ?? m.path]));
  const ecoOf = new Map(nodes.map((m) => [m.path, m.ecosystem]));
  const byName = new Map<string, string>();
  const byDir = new Map<string, string>();
  for (const m of nodes) {
    if (m.name !== undefined && !byName.has(`${m.ecosystem}:${m.name}`)) byName.set(`${m.ecosystem}:${m.name}`, m.path);
    byDir.set(`${m.ecosystem}:${dirOf(m.path)}`, m.path);
  }
  const target = (m: Manifest, l: Link) => (l.dir !== undefined ? byDir.get(`${m.ecosystem}:${l.dir}`) : byName.get(`${m.ecosystem}:${l.name}`));

  const out = new Map<string, string[]>();
  for (const m of nodes) out.set(m.path, [...new Set(m.links.map((l) => target(m, l)).filter((t): t is string => t !== undefined && t !== m.path))].sort());
  const packages = nodes.map((m) => ({
    name: labelOf.get(m.path)!,
    path: m.path,
    ecosystem: m.ecosystem,
    internal: out.get(m.path)!.map((t) => labelOf.get(t)!).sort(),
    ...(m.ecosystem === 'npm' ? { exports: m.exports ?? false } : {}),
  }));
  if (!complete) return { packages, count: null, edges: null, cycles: null, maxDepth: null, topFanIn: null };

  // Strongly connected components (Tarjan's), so a cycle counts once and depth is measured between them.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const component = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (v: string) => {
    index.set(v, index.size);
    low.set(v, index.get(v)!);
    stack.push(v);
    onStack.add(v);
    for (const w of out.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) !== index.get(v)) return;
    const members: string[] = [];
    for (let w = stack.pop()!; ; w = stack.pop()!) {
      onStack.delete(w);
      component.set(w, components.length);
      members.push(w);
      if (w === v) break;
    }
    components.push(members.sort());
  };
  for (const v of out.keys()) if (!index.has(v)) visit(v);

  // Depth: the longest chain of dependencies from a package, across components; Tarjan's emits dependencies first.
  const depth: number[] = [];
  components.forEach((members, c) => {
    const next = new Set(members.flatMap((v) => out.get(v)!.map((w) => component.get(w)!)).filter((d) => d !== c));
    depth[c] = Math.max(0, ...[...next].map((d) => depth[d]! + 1));
  });

  const fanIn = new Map<string, number>();
  for (const targets of out.values()) for (const t of targets) fanIn.set(t, (fanIn.get(t) ?? 0) + 1);
  const named = (path: string) => ({ name: labelOf.get(path)!, ecosystem: ecoOf.get(path)! });

  return {
    packages,
    count: packages.length,
    edges: [...out.values()].reduce((a, t) => a + t.length, 0),
    cycles: components
      .filter((c) => c.length > 1)
      .map((c) => ({ ecosystem: ecoOf.get(c[0]!)!, packages: c.map((p) => labelOf.get(p)!).sort() }))
      .sort((a, b) => b.packages.length - a.packages.length || a.packages[0]!.localeCompare(b.packages[0]!)),
    maxDepth: Math.max(0, ...depth),
    topFanIn: [...fanIn]
      .map(([path, dependents]) => ({ ...named(path), dependents }))
      .sort((a, b) => b.dependents - a.dependents || a.name.localeCompare(b.name) || a.ecosystem.localeCompare(b.ecosystem))
      .slice(0, TOP_FAN_IN),
  };
};

/**
 * The manifests that are their workspace's packages: its root, those its globs match and no exclusion does, and in
 * Cargo, members' path dependencies inside the workspace. A manifest no workspace declares around is its own package.
 */
export const membersOf = (manifests: Manifest[], declarations: Declaration[]) => {
  const pathMembers = new Set<string>();
  let members: Manifest[] = [];
  for (let grew = true; grew; ) {
    members = manifests.filter((m) => isMember(declarations, m.ecosystem, dirOf(m.path), m.ecosystem === 'cargo' ? pathMembers : undefined));
    const before = pathMembers.size;
    for (const m of members) if (m.ecosystem === 'cargo') for (const l of m.links) if (l.dir !== undefined) pathMembers.add(l.dir);
    grew = pathMembers.size > before;
  }
  return members;
};

// ---------- the stack ----------

export interface StackInputs {
  source: Source;
  /** Manifest paths, as the profile counts them: not examples, fixtures or vendored. */
  manifestPaths: string[];
  /** The workflow files' text, and whether every one was read. */
  workflows: { texts: string[]; complete: boolean };
  /** The profile's languages and shares; undefined when GitHub's answer wasn't read, as for a checkout. */
  languages: [string, number][] | undefined;
  /** The profile's package counts by ecosystem. */
  packages: Record<string, number>;
  /** The sampled jobs by runner provider; undefined when no jobs were read. */
  runners: [string, number][] | undefined;
}

const AGENT_FILES: [string, RegExp][] = [
  ['AGENTS.md', /(^|\/)AGENTS\.md$/],
  ['CLAUDE.md', /(^|\/)CLAUDE\.md$/],
  ['GEMINI.md', /(^|\/)GEMINI\.md$/],
  ['.github/copilot-instructions.md', /^\.github\/copilot-instructions\.md$/],
  ['.github/instructions', /^\.github\/instructions\/.+\.instructions\.md$/],
  ['.cursor/rules', /^\.cursor\/rules\//],
  ['.cursorrules', /^\.cursorrules$/],
  ['.windsurf/rules', /^\.windsurf\/rules\//],
  ['.windsurfrules', /^\.windsurfrules$/],
  ['.clinerules', /^\.clinerules(\/|$)/],
  ['.junie/guidelines.md', /^\.junie\/guidelines\.md$/],
  ['.claude/skills', /^\.claude\/skills\//],
  ['.agents/skills', /^\.agents\/skills\//],
  ['.claude/agents', /^\.claude\/agents\//],
  ['.claude/commands', /^\.claude\/commands\//],
  ['.mcp.json', /^\.mcp\.json$/],
];
// Not the repo's own setup: vendored code, and examples, fixtures and templates that carry their own configs.
const NOT_OURS = /(^|\/)(node_modules|vendor|vendored|third[_-]?party|examples?|fixtures?|__fixtures__|testdata|templates?(-[\w.-]+)?|playground)\//i;

/** Found is the list; nothing found where every input was read is []; nothing found otherwise is null (unknown). */
const listed = <T>(found: T[], complete: boolean): T[] | null => (found.length || complete ? found : null);

export const stackOf = ({ source, manifestPaths, workflows, languages, packages, runners }: StackInputs) => {
  const paths = source.tree.blobs.map((b) => b.path).filter((p) => !NOT_OURS.test(p));
  const has = (re: RegExp) => paths.some((p) => re.test(p));
  const treeComplete = !source.tree.truncated;
  const unknown: string[] = [];

  // One batch: every manifest up to the cap, and the root's task files.
  const toRead = manifestPaths.slice(0, MAX_MANIFESTS);
  if (manifestPaths.length > MAX_MANIFESTS) unknown.push(`Read the first ${MAX_MANIFESTS} of ${manifestPaths.length} package manifests`);
  const commandFiles = COMMAND_FILES.filter((p) => paths.includes(p));
  // pnpm-workspace.yaml and go.work say which manifests are a workspace's packages.
  const workspaceFiles = paths.filter((p) => /(^|\/)(pnpm-workspace\.yaml|go\.work)$/.test(p));
  const { texts, failed } = source.readMany([...toRead, ...workspaceFiles, ...commandFiles]);
  // A manifest read but not understood says nothing of its package, so it counts as unread too.
  const parsed = toRead.flatMap((p) => (texts.has(p) ? [parseManifest(p, texts.get(p)!)!] : []));
  for (const m of parsed) if (m.unparsed) failed.set(m.path, m.unparsed);
  const unread = [...toRead, ...workspaceFiles, ...commandFiles].filter((p) => !texts.has(p) || failed.has(p));

  const declarations: Declaration[] = [
    ...parsed.flatMap((m) => (m.workspace ? [{ dir: dirOf(m.path), ecosystem: m.ecosystem, workspace: m.workspace }] : [])),
    ...workspaceFiles.flatMap((p) => {
      const text = texts.get(p);
      if (text === undefined) return [];
      return [p.endsWith('go.work') ? { dir: dirOf(p), ecosystem: 'go', workspace: goWork(text) } : { dir: dirOf(p), ecosystem: 'npm', workspace: pnpmWorkspace(text) }];
    }),
  ];
  const manifests = inherit(parsed.filter((m) => !m.unparsed), declarations);
  if (unread.length) {
    const why = failed.get(unread[0]!);
    unknown.push(`${unread.length} manifest or task file${unread.length === 1 ? '' : 's'} in the tree couldn't be read, such as ${unread[0]}${why ? ` (${why})` : ''}`);
  }
  if (!treeComplete) unknown.push("GitHub cut the file tree short, so a file past the cut can't be checked");
  if (!workflows.complete) unknown.push('Not every workflow file was read');

  const manifestsComplete = treeComplete && manifestPaths.length <= MAX_MANIFESTS && manifests.length === toRead.length;
  const allComplete = manifestsComplete && workflows.complete && unread.length === 0;

  const root = manifests.find((m) => m.path === 'package.json');
  const commands = [...workflows.texts, ...manifests.filter((m) => m.ecosystem === 'npm').map((m) => m.text), ...commandFiles.map((p) => texts.get(p) ?? '')].join('\n');
  const depsBy = new Map<Ecosystem, Set<string>>();
  for (const m of manifests) for (const d of m.deps) depsBy.set(m.ecosystem, (depsBy.get(m.ecosystem) ?? new Set()).add(d));
  const tomlText = manifests.filter((m) => m.ecosystem === 'cargo' || m.ecosystem === 'python').map((m) => m.text).join('\n');

  const uses = (t: Tool) =>
    Object.entries(t.deps ?? {}).some(([eco, names]) => names!.some((n) => depsBy.get(eco as Ecosystem)?.has(n))) ||
    (t.files !== undefined && has(t.files)) ||
    (t.commands !== undefined && t.commands.test(commands)) ||
    (t.manifestText !== undefined && t.manifestText.test(tomlText));
  const found = (tools: Tool[]) => tools.filter(uses).map((t) => t.name);

  // Libraries: dependencies counted by how many packages name them, but the workspace's own packages and the
  // tools the other fields name.
  const own = new Set(manifests.map((m) => `${m.ecosystem}:${m.name}`));
  const tools = new Set([...TEST_RUNNERS, ...LINT_FORMAT].flatMap((t) => Object.entries(t.deps ?? {}).flatMap(([eco, ns]) => ns!.map((n) => `${eco}:${n}`))));
  const counts = new Map<string, number>();
  for (const m of manifests)
    for (const d of new Set(m.deps)) {
      const key = `${m.ecosystem}:${d}`;
      if (own.has(key) || tools.has(key) || /^@types\//.test(d) || key === 'npm:typescript') continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  const libraries = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_LIBRARIES)
    .map(([key, packages]) => ({ name: key.slice(key.indexOf(':') + 1), ecosystem: key.slice(0, key.indexOf(':')) as Ecosystem, packages }));

  const packageManagers = [
    ...[
      ['pnpm', /^pnpm-lock\.yaml$/],
      ['Bun', /^bun\.lockb?$/],
      [has(/^\.yarnrc\.yml$/) ? 'Yarn Berry' : 'Yarn 1', /^yarn\.lock$/],
      ['npm', /^package-lock\.json$/],
      ['uv', /(^|\/)uv\.lock$/],
      ['Poetry', /(^|\/)poetry\.lock$/],
      ['PDM', /(^|\/)pdm\.lock$/],
      ['Pipenv', /(^|\/)Pipfile\.lock$/],
      ['pip', /(^|\/)requirements[\w.-]*\.txt$/],
      ['Cargo', /(^|\/)Cargo\.toml$/],
      ['Go modules', /(^|\/)go\.mod$/],
      ['Bundler', /(^|\/)Gemfile$/],
    ].filter(([, re]) => has(re as RegExp)).map(([n]) => n as string),
  ];
  const rootCargo = manifests.find((m) => m.path === 'Cargo.toml');
  const rootPy = manifests.find((m) => m.path === 'pyproject.toml');
  const rootPkg = (() => {
    try {
      return root ? JSON.parse(texts.get('package.json')!) : undefined;
    } catch {
      return undefined;
    }
  })();
  const workspaceTools = [
    ['Turborepo', has(/^turbo\.json$/)],
    ['Nx', has(/^nx\.json$/)],
    ['Bazel', has(/^(MODULE\.bazel|WORKSPACE(\.bazel)?)$/)],
    ['Buck2', has(/^\.buckconfig$/)],
    ['Pants', has(/^pants\.toml$/)],
    ['moon', has(/^\.moon\/workspace\.ya?ml$/)],
    ['Lerna', has(/^lerna\.json$/)],
    ['Rush', has(/^rush\.json$/)],
    ['Lage', has(/^lage\.config\.[cm]?js$/)],
    ['Vite+', !!depsBy.get('npm')?.has('vite-plus')],
    ['pnpm workspaces', has(/^pnpm-workspace\.yaml$/)],
    ['npm workspaces', rootPkg?.workspaces !== undefined],
    ['Cargo workspace', /^\[workspace\]/m.test(rootCargo?.text ?? '')],
    ['Go workspace', has(/^go\.work$/)],
    ['uv workspace', /^\[tool\.uv\.workspace\]/m.test(rootPy?.text ?? '')],
    ['Gradle', has(/^settings\.gradle(\.kts)?$/)],
    ['Maven', has(/^pom\.xml$/)],
    ['just', commandFiles.some((p) => /justfile$/i.test(p))],
    ['Make', commandFiles.includes('Makefile')],
  ].filter(([, on]) => on).map(([n]) => n as string);

  const agentFiles = AGENT_FILES.filter(([, re]) => has(re)).map(([name]) => name);

  return {
    languages: languages ?? null,
    workspace: {
      packageManagers: listed(packageManagers, treeComplete),
      tools: listed(workspaceTools, treeComplete && unread.length === 0 && (root !== undefined || !paths.includes('package.json'))),
    },
    // Counted as the profile counts them; a cut tree counts only what it lists.
    packages: treeComplete ? packages : null,
    testRunners: listed(found(TEST_RUNNERS), allComplete),
    lintFormat: listed(found(LINT_FORMAT), allComplete),
    libraries: listed(libraries, manifestsComplete),
    runners: runners ?? null,
    agentFiles: listed(agentFiles, treeComplete),
    graph: packageGraph(membersOf(manifests, declarations), manifestsComplete && workspaceFiles.every((p) => !unread.includes(p))),
    /** Why any field above is null, or may hold less than the repo has. */
    unknown,
  };
};

export type Stack = ReturnType<typeof stackOf>;
