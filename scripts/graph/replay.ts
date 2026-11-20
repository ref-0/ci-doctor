/**
 * replay.ts: what each of the last N merged commits on the default branch triggered, through the
 * graphs as they stood at that commit: the packages, entries, files and test files its change
 * reaches, what a package-level selector would have run instead, and how many cached tasks' inputs
 * it touched.
 *
 * A commit is diffed against its first parent, so a merge commit counts its whole pull request.
 * Each commit's graph is read at that commit, sharing parsed modules by blob id, and resolutions
 * with its parent when the commit adds, removes and renames no path and edits no JSON.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { readGraph, treeAt } from './read.ts';
import type { FileGraph, Git, Parsed, ReadOptions, Resolver } from './read.ts';
import { entriesOf, nodesOf, reach } from './shape.ts';
import { readTasks } from './tasks.ts';
import type { TaskGraph } from './tasks.ts';

/** Why a changed path reaches what it does. */
export type Cause = 'graph' | 'package' | 'everything' | 'none';

const DOC = /\.(?:md|mdx|markdown|txt|rst|adoc)$|(?:^|\/)(?:LICENSE|LICENCE|NOTICE|AUTHORS|CODEOWNERS)(?:\.\w+)?$/i;
const ASSET = /\.(?:png|jpe?g|gif|webp|avif|ico|svg|woff2?|ttf|otf|eot|mp4|webm|mp3)$/i;
const LINT = /(?:^|\/)(?:\.eslintrc[\w.]*|eslint\.config\.[cm]?[jt]s|\.prettierrc[\w.]*|prettier\.config\.[cm]?[jt]s|\.prettierignore|biome\.jsonc?|\.oxlintrc[\w.]*|oxlint\.config\.[cm]?[jt]s|\.editorconfig|\.gitignore|\.gitattributes|\.markdownlint[\w.]*|\.vscode\/.*|\.idea\/.*|\.changeset\/.*)$/;
const CI = /^(?:\.github\/|\.gitlab-ci\.yml$|\.gitlab\/|\.circleci\/|\.buildkite\/|azure-pipelines\.ya?ml$|Jenkinsfile$)/;
const SHARED = /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|\.npmrc|\.yarnrc(?:\.yml)?|\.nvmrc|\.node-version|\.tool-versions|tsconfig[\w.-]*\.json|turbo\.json|nx\.json|[\w.-]+\.config\.[cm]?[jt]s|\.babelrc[\w.]*)$/;
const PACKAGE_CONFIG = /(?:^|\/)(?:package\.json|tsconfig[\w.-]*\.json|[\w.-]+\.config\.[cm]?[jt]s|\.babelrc[\w.]*|project\.json|turbo\.json)$/;

/**
 * How one changed path reaches the workspace at a commit, `nodes` being the graph's nodes and
 * `imported` those with an edge into them. A file something imports, a `.txt` fixture among them,
 * is never docs or lint config.
 */
export const causeOf = (path: string, graph: FileGraph, nodes: ReadonlySet<string>, imported: ReadonlySet<string> = new Set()): { cause: Cause; why: string } => {
  const single = graph.packages.length === 1;
  if (CI.test(path)) return { cause: 'everything', why: 'CI config' };
  if (imported.has(path)) return { cause: 'graph', why: 'import graph' };
  if (DOC.test(path)) return { cause: 'none', why: 'docs' };
  if (LINT.test(path)) return { cause: 'none', why: 'lint, format or editor config' };
  if (SHARED.test(path)) return { cause: 'everything', why: 'shared root config or lockfile' };
  const owner = graph.owner(path);
  if (owner.dir === '' && !single && /^docs?\//.test(path) && !nodes.has(path)) return { cause: 'none', why: 'docs' };
  if (PACKAGE_CONFIG.test(path) && (owner.dir !== '' || single)) return { cause: single ? 'everything' : 'package', why: 'package config' };
  if (nodes.has(path)) return { cause: 'graph', why: 'import graph' };
  if (ASSET.test(path)) return { cause: 'none', why: 'asset nothing imports' };
  if (owner.dir !== '' || single) return { cause: single ? 'everything' : 'package', why: 'outside the import graph' };
  return { cause: 'everything', why: 'unknown root file' };
};

export interface CommitReach {
  readonly sha: string;
  readonly changed: number;
  readonly causes: Readonly<Partial<Record<Cause, number>>>;
  /** What the change reaches through the file graph (plus package-level edits), each as a count. */
  readonly reached: { readonly files: number; readonly packages: number; readonly entries: number; readonly tests: number };
  /** What a package-level selector would run: changed packages and their dependents' tests. */
  readonly packageLevelTests: number;
  readonly tasks: { readonly touched: number; readonly withDependents: number };
  readonly everything: boolean;
  /** The changed path behind the widest reach, and the tests it alone reaches. */
  readonly widest?: { readonly path: string; readonly tests: number; readonly why: string };
  readonly through: ReadonlyArray<string>;
  readonly of: { readonly files: number; readonly packages: number; readonly entries: number; readonly tests: number; readonly cachedTasks: number };
}

const dependentsOf = (graph: FileGraph, names: Iterable<string>) => {
  const found = new Set(names);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of graph.packages) {
      if (found.has(p.name)) continue;
      if ([...p.deps.values()].some((s) => [...s].some((n) => found.has(n)))) { found.add(p.name); grew = true; }
    }
  }
  return found;
};

/** One commit's reach, `before` being its first parent's graph. */
export const commitReach = (
  sha: string,
  changes: ReadonlyArray<{ status: string; path: string }>,
  graph: FileGraph,
  before: FileGraph,
  tasks: TaskGraph,
): CommitReach => {
  const nodes = new Set(nodesOf(graph));
  const beforeNodes = new Set(nodesOf(before));
  const imported = new Set(graph.edges.map((e) => e.to));
  const beforeImported = new Set(before.edges.map((e) => e.to));
  const tests = [...nodes].filter(graph.isTest);
  const entries = [...entriesOf(graph)].filter(([, e]) => e.file !== null);
  const causes: Partial<Record<Cause, number>> = {};
  const inGraph: string[] = [];
  const deleted: string[] = [];
  const packageEdits = new Set<string>();
  const changedPackages = new Set<string>();
  let everything = false;
  let everythingWhy: { path: string; why: string } | undefined;

  for (const { status, path } of changes) {
    const gone = status.startsWith('D');
    const { cause, why } = causeOf(path, gone ? before : graph, gone ? beforeNodes : nodes, gone ? beforeImported : imported);
    causes[cause] = (causes[cause] ?? 0) + 1;
    if (cause !== 'none') changedPackages.add((gone ? before : graph).owner(path).name);
    if (cause === 'everything') { everything = true; everythingWhy ??= { path, why }; }
    else if (cause === 'package') packageEdits.add(graph.owner(path).name);
    else if (cause === 'graph') (gone ? deleted : inGraph).push(path);
  }

  const reached = new Set<string>();
  if (everything) for (const n of nodes) reached.add(n);
  else {
    for (const f of reach(graph, inGraph)) reached.add(f);
    for (const f of reach(before, deleted)) if (nodes.has(f)) reached.add(f);
    const whole = dependentsOf(graph, packageEdits);
    for (const n of nodes) if (whole.has(graph.owner(n).name)) reached.add(n);
  }
  const reachedPackages = new Set([...reached].map((f) => graph.owner(f).name));
  const levels = everything ? new Set(graph.packages.map((p) => p.name)) : dependentsOf(graph, changedPackages);

  // An entry the reach went through: its file is reached, and so is a file of another package that imports it.
  const through: string[] = [];
  if (!everything) {
    const across = new Map<string, string[]>();
    for (const e of graph.edges) if (e.pkg !== undefined && e.kind !== 'type' && reached.has(e.from) && reached.has(e.to) && graph.owner(e.from).name !== e.pkg) (across.get(`${e.pkg}#${e.entry}`) ?? across.set(`${e.pkg}#${e.entry}`, []).get(`${e.pkg}#${e.entry}`)!).push(e.from);
    for (const [id] of entries) if (across.has(id)) through.push(id);
  }

  const cachedTasks = [...tasks.tasks.values()].filter((t) => t.cached && t.mode !== 'unknown');
  const touched = new Set(cachedTasks.filter((t) => changes.some((c) => t.matches(c.path))).map((t) => t.id));
  const withDependents = new Set(touched);
  for (let grew = true; grew;) {
    grew = false;
    for (const e of tasks.edges) if (withDependents.has(e.to) && !withDependents.has(e.from)) { withDependents.add(e.from); grew = true; }
  }

  const reachedTests = tests.filter((t) => reached.has(t)).length;
  return {
    sha,
    changed: changes.length,
    causes,
    reached: { files: reached.size, packages: reachedPackages.size, entries: entries.filter(([, e]) => reached.has(e.file!)).length, tests: reachedTests },
    packageLevelTests: tests.filter((t) => levels.has(graph.owner(t).name)).length,
    tasks: { touched: touched.size, withDependents: cachedTasks.filter((t) => withDependents.has(t.id)).length },
    everything: everything || (tests.length > 0 && reachedTests === tests.length),
    ...(everythingWhy ? { widest: { path: everythingWhy.path, tests: tests.length, why: everythingWhy.why } } : {}),
    through,
    of: { files: nodes.size, packages: graph.packages.length, entries: entries.length, tests: tests.length, cachedTasks: cachedTasks.length },
  };
};

/** The changed path whose own reach covers the most tests, among at most `cap` of a commit's graph files. */
export const widestPath = (graph: FileGraph, paths: ReadonlyArray<string>, cap = 20) => {
  const nodes = new Set(nodesOf(graph));
  let best: { path: string; tests: number; why: string } | undefined;
  for (const path of paths.filter((p) => nodes.has(p)).slice(0, cap)) {
    const tests = [...reach(graph, [path])].filter(graph.isTest).length;
    if (!best || tests > best.tests) best = { path, tests, why: 'import graph' };
  }
  return best;
};

export interface Replay {
  readonly branch: string;
  readonly asked: number;
  readonly commits: ReadonlyArray<CommitReach>;
  /** The graphs at the newest commit, for the shape. */
  readonly last: { readonly graph: FileGraph; readonly tasks: TaskGraph };
}

/** The default branch: `origin/HEAD`'s target, else `main` or `master`, else HEAD. */
export const defaultBranch = (git: Git) => {
  try { return git.run('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').trim(); } catch { /* none */ }
  for (const name of ['origin/main', 'origin/master', 'main', 'master']) {
    try { git.run('rev-parse', '--verify', '--quiet', `${name}^{commit}`); return name; } catch { /* next */ }
  }
  return 'HEAD';
};

/** `git diff-tree -z --name-status` output as changes, a rename as a delete and an add, paths unquoted. */
export const changesOf = (out: string) => {
  const fields = out.split('\0');
  const changes: Array<{ status: string; path: string }> = [];
  for (let i = 0; i + 1 < fields.length && fields[i] !== '';) {
    const status = fields[i++]!;
    if (/^[RC]/.test(status)) {
      const [from, to] = [fields[i++]!, fields[i++]!];
      changes.push(...(status.startsWith('R') ? [{ status: 'D', path: from }] : []), { status: 'A', path: to });
    } else changes.push({ status, path: fields[i++]! });
  }
  return changes;
};

/** Replays the last `count` first-parent commits of `branch`, oldest first, `progress` called after each. */
export const replay = (git: Git, branch: string, count: number, options: ReadOptions, progress: (done: number, of: number) => void = () => {}): Replay => {
  const shas = git.run('rev-list', '--first-parent', `--max-count=${count}`, branch).split('\n').filter(Boolean).reverse();
  const parsed = new Map<string, Parsed>();
  const resolvers = new Map<string, Resolver>();
  const parentOf = (sha: string) => git.run('rev-list', '--parents', '-n', '1', sha).trim().split(' ')[1];
  const graphs = new Map<string, FileGraph>();
  const graphAt = (sha: string) => {
    const found = graphs.get(sha) ?? readGraph(git, sha, options, parsed, treeAt(git, sha), resolvers);
    graphs.set(sha, found);
    return found;
  };
  const commits: CommitReach[] = [];
  let last: { graph: FileGraph; tasks: TaskGraph } | undefined;
  shas.forEach((sha, i) => {
    const parent = parentOf(sha);
    const graph = graphAt(sha);
    const tasks = readTasks(git, graph);
    last = { graph, tasks };
    if (parent !== undefined) {
      const before = graphAt(parent);
      const changes = changesOf(git.run('diff-tree', '-r', '-z', '--no-commit-id', '--name-status', '-M', parent, sha));
      const found = commitReach(sha, changes, graph, before, tasks);
      commits.push(found.widest ? found : { ...found, ...((): { widest?: { path: string; tests: number; why: string } } => { const w = widestPath(graph, changes.map((c) => c.path)); return w ? { widest: w } : {}; })() });
    }
    // Keep only this commit's graph, which is the next one's parent.
    for (const key of graphs.keys()) if (key !== sha) graphs.delete(key);
    progress(i + 1, shas.length);
  });
  if (!last) throw new Error(`no commits on ${branch}`);
  return { branch, asked: count, commits, last };
};

/** The value at quantile `q` of `values`, by the nearest-rank method. */
export const nearestRank = (values: ReadonlyArray<number>, q: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
};
