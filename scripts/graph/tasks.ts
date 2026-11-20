/**
 * tasks.ts: a workspace's task graph at one commit, from the task runner's config and the
 * packages' scripts: each task's dependencies, its declared inputs and outputs, and whether a
 * cache keys it at all.
 *
 * It reads, statically and without installing anything:
 * - Turborepo: `turbo.json` (`tasks`, or v1's `pipeline`), packages' `turbo.json`, `globalDependencies`;
 * - Nx: `nx.json` (`targetDefaults`, `namedInputs`, `cacheableOperations`), `project.json` targets;
 * - Vite+: `run.tasks` and `run.cache` in `vite.config.*`, when they're plain object literals;
 * - package scripts that call each other: `pnpm run x`, `npm run x`, `yarn x`, `bun run x`,
 *   `run-s`/`run-p`, `pre`/`post` scripts, and recursive runs (`-r`, `--filter`, `turbo run`,
 *   `nx run-many`, `vp run -r`), which fan out to every package with that script.
 *
 * Inputs a runner infers at run time (Vite+'s automatic tracking, Nx plugins' inferred targets)
 * aren't visible here; they're counted, and auto-tracked inputs are approximated by the package's
 * own files.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { posix } from 'node:path';

import { globList, parseJsonc } from './read.ts';
import type { FileGraph, Git, Package } from './read.ts';

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

// ---- A JavaScript object literal, read as data ------------------------------------------------

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
      if (text.startsWith('//', i)) { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); i = end === -1 ? text.length : end + 2; continue; }
      break;
    }
  };
  for (;;) {
    skip();
    const c = text[i];
    if (c === undefined) return undefined;
    if (c === '{' || c === '[') { depth++; json += c; i++; continue; }
    if (c === '}' || c === ']') { depth--; json = json.replace(/,$/, '') + c; i++; if (depth === 0) break; continue; }
    if (c === ',' || c === ':') { json += c; i++; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let value = '';
      for (i++; i < text.length && text[i] !== c; i++) {
        if (text[i] === '\\') { value += text[i + 1] ?? ''; i++; continue; }
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
    if (text[i] === ':' ) json += JSON.stringify(word);
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

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : typeof value === 'string' ? [value] : [];

// ---- Script commands ----------------------------------------------------------------------------

const PM_COMMANDS = new Set(['install', 'i', 'add', 'remove', 'rm', 'exec', 'dlx', 'x', 'publish', 'pack', 'link', 'why', 'outdated', 'update', 'up', 'init', 'create', 'config', 'store', 'audit', 'list', 'ls']);

/** A command's parts between `&&`, `||`, `;`, `|` and `&`, outside quotes. */
const segments = (command: string) => {
  const parts: string[] = [];
  let quote = '';
  let part = '';
  for (const c of command) {
    if (quote) { if (c === quote) quote = ''; part += c; continue; }
    if (c === '"' || c === "'") { quote = c; part += c; continue; }
    if (c === '&' || c === '|' || c === ';') { parts.push(part); part = ''; continue; }
    part += c;
  }
  parts.push(part);
  return parts.filter((p) => p.trim() !== '');
};

/** The scripts a command runs: `{ name, recursive }` for each, `name` possibly a `pkg#task`, or a glob for `run-s build:*`. */
export const scriptCalls = (command: string) => {
  const found: Array<{ name: string; recursive: boolean }> = [];
  for (const raw of segments(command)) {
    const words = raw.trim().replace(/(["'])(.*?)\1/g, '$2').replace(/^(?:cross-env\s+(?:\S+=\S+\s+)*|(?:[A-Z_][A-Z0-9_]*=\S*\s+)+)/, '').split(/\s+/).filter(Boolean);
    const [tool, ...rest] = words;
    if (tool === undefined) continue;
    const recursive = rest.some((w) => /^(?:-r|--recursive|-w|--workspaces|--filter|-F|--all|-ws)$/.test(w) || w.startsWith('--filter=') || w.startsWith('--workspace='));
    const args = rest.filter((w, k) => !w.startsWith('-') && !/^(?:--filter|-F|--workspace)$/.test(rest[k - 1] ?? ''));
    if (tool === 'npm' || tool === 'pnpm' || tool === 'yarn' || tool === 'bun') {
      if (args[0] === 'run' || args[0] === 'run-script') { if (args[1]) found.push({ name: args[1], recursive }); }
      else if (tool === 'npm' && args[0] && ['test', 'start', 'stop', 'restart'].includes(args[0])) found.push({ name: args[0], recursive });
      else if (tool !== 'npm' && args[0] && !PM_COMMANDS.has(args[0]) && !(tool === 'yarn' && args[0] === 'workspace')) found.push({ name: args[0], recursive });
      else if (tool === 'yarn' && args[0] === 'workspaces' && args[1] === 'foreach') { const i = args.indexOf('run'); if (i !== -1 && args[i + 1]) found.push({ name: args[i + 1]!, recursive: true }); }
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

// ---- The graph ----------------------------------------------------------------------------------

/** The task graph at a file graph's commit. */
export const readTasks = (git: Git, graph: FileGraph): TaskGraph => {
  const { files, packages } = graph;
  const text = (path: string) => { const id = files.get(path); return id === undefined ? undefined : git.blobs([id]).get(id); };
  const json = (path: string) => record(parseJsonc(text(path) ?? ''));
  const byName = new Map(packages.map((p) => [p.name, p]));
  const byDir = new Map(packages.map((p) => [p.dir, p]));
  const unread: string[] = [];
  const tasks = new Map<string, Task & { deps: Array<{ spec: string; how: How } | { task: string; kinds: string[] }> }>();
  const runners = new Set<Runner>();
  const prefixOf = (globs: ReadonlyArray<string>) => {
    const literal = globs.filter((g) => !g.startsWith('!')).map((g) => g.slice(0, g.search(/[*?{[]|$/)).replace(/[^/]*$/, ''));
    if (literal.length === 0) return '';
    let common = literal[0]!;
    for (const l of literal) while (!l.startsWith(common)) common = common.slice(0, common.lastIndexOf('/', common.length - 2) + 1);
    return common;
  };
  const ownedBy = (pkg: Package) => (path: string) => graph.owner(path).name === pkg.name;
  const make = (pkg: Package, name: string, runner: Runner, fields: { command?: string; cached: boolean; mode: InputMode; inputs?: string[]; outputs?: string[]; global?: string[]; base?: 'package' | 'none' }) => {
    const inputs = fields.inputs ?? [];
    const declared = globList(inputs.filter((g) => !g.startsWith('!')));
    const excluded = globList(inputs.filter((g) => g.startsWith('!')).map((g) => g.slice(1)));
    const global = globList(fields.global ?? []);
    const base = fields.mode === 'package-default' || fields.mode === 'auto' || fields.base === 'package' ? ownedBy(pkg) : () => false;
    const matches = (path: string) => global(path) || ((base(path) || declared(path)) && !excluded(path));
    const prefix = (fields.global ?? []).length > 0 || pkg.dir === '' ? '' : fields.mode === 'declared' && fields.base !== 'package' ? prefixOf(inputs) : pkg.dir;
    return { id: `${pkg.name}#${name}`, pkg: pkg.name, name, runner, ...(fields.command !== undefined ? { command: fields.command } : {}), cached: fields.cached, mode: fields.mode, inputs, outputs: fields.outputs ?? [], matches, prefix, deps: [] as Array<{ spec: string; how: How } | { task: string; kinds: string[] }> };
  };

  // Package scripts, uncached unless a runner below says otherwise.
  const viteRoot = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'].find((p) => files.has(p));
  const rootRun = viteRoot ? vitePlusRun(text(viteRoot) ?? '') : undefined;
  const cacheSetting = rootRun && rootRun !== 'unreadable' ? rootRun.cache : undefined;
  const scriptsCached = cacheSetting === true || record(cacheSetting).scripts === true;
  for (const pkg of packages) {
    for (const [name, command] of Object.entries(pkg.manifest.scripts ?? {})) {
      const task = make(pkg, name, 'script', { command, cached: scriptsCached, mode: scriptsCached ? 'auto' : 'unknown' });
      for (const call of scriptCalls(command)) task.deps.push({ spec: call.name, how: call.recursive ? 'fan-out' : 'calls' });
      tasks.set(task.id, task);
    }
    for (const name of Object.keys(pkg.manifest.scripts ?? {})) {
      for (const [prefix, how] of [['pre', 'lifecycle'], ['post', 'lifecycle']] as const) {
        const other = `${prefix}${name}`;
        if (!pkg.manifest.scripts?.[other]) continue;
        // Running the script runs its `pre` script first and its `post` script after: both are part of it.
        tasks.get(`${pkg.name}#${name}`)!.deps.push({ spec: other, how });
      }
    }
  }

  // Vite+: tasks in each package's config, cached by default, inputs tracked automatically.
  for (const pkg of packages) {
    const config = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'].map((f) => pkg.dir + f).find((p) => files.has(p));
    if (!config) continue;
    const run = pkg.dir === '' ? rootRun : vitePlusRun(text(config) ?? '');
    if (run === undefined) continue;
    runners.add('vite-plus');
    if (run === 'unreadable') { unread.push(`${config}: \`run\` isn't a plain object literal`); continue; }
    for (const [name, raw] of Object.entries(record(run.tasks))) {
      const value = typeof raw === 'string' || Array.isArray(raw) ? { command: raw } : record(raw);
      const cache = value.cache;
      const cacheObject = record(cache);
      const input = cacheObject.input as unknown;
      const entries = Array.isArray(input) ? input : undefined;
      const auto = entries === undefined || entries.some((e) => record(e).auto === true);
      const globs = (entries ?? []).flatMap((e) => typeof e === 'string' ? [e.startsWith('!') ? `!${posix.join(pkg.dir, e.slice(1))}` : posix.join(pkg.dir, e)]
        : typeof record(e).pattern === 'string' ? [record(e).base === 'workspace' ? String(record(e).pattern) : posix.join(pkg.dir, String(record(e).pattern))] : []);
      const outputs = strings(cacheObject.output).map((o) => posix.join(pkg.dir, o));
      const task = make(pkg, name, 'vite-plus', {
        command: strings(value.command).join(' && '),
        cached: cache !== false,
        mode: cache === false ? 'unknown' : entries !== undefined && entries.length === 0 ? 'empty' : auto && globs.length === 0 ? 'auto' : 'declared',
        inputs: globs,
        outputs,
        ...(auto ? { base: 'package' as const } : {}),
      });
      for (const dep of Array.isArray(value.dependsOn) ? value.dependsOn : []) {
        if (typeof dep === 'string') task.deps.push({ spec: dep, how: 'dependsOn' });
        else if (typeof record(dep).task === 'string') task.deps.push({ task: String(record(dep).task), kinds: strings(record(dep).from) });
      }
      for (const call of scriptCalls(task.command ?? '')) task.deps.push({ spec: call.name, how: call.recursive ? 'fan-out' : 'calls' });
      tasks.set(task.id, task);
    }
  }

  // Turborepo: a task applies to each package with that script; `pkg#task` and `//#task` to one.
  if (files.has('turbo.json')) {
    runners.add('turbo');
    const root = json('turbo.json');
    const global = strings(root.globalDependencies).map((g) => g.replace(/^\$TURBO_ROOT\$\//, ''));
    const definitions = record(root.tasks ?? root.pipeline);
    const overrides = new Map(packages.filter((p) => p.dir !== '' && files.has(`${p.dir}turbo.json`)).map((p) => [p.name, record(json(`${p.dir}turbo.json`).tasks ?? json(`${p.dir}turbo.json`).pipeline)]));
    for (const pkg of packages) {
      for (const name of Object.keys(pkg.manifest.scripts ?? {})) {
        const key = pkg.dir === '' ? `//#${name}` : name;
        const config = { ...record(definitions[key] ?? (pkg.dir === '' ? undefined : definitions[`${pkg.name}#${name}`])), ...record(overrides.get(pkg.name)?.[name]) };
        if (definitions[key] === undefined && definitions[`${pkg.name}#${name}`] === undefined && overrides.get(pkg.name)?.[name] === undefined) continue;
        const declared = config.inputs !== undefined;
        const inputs = strings(config.inputs);
        const withDefault = !declared || inputs.includes('$TURBO_DEFAULT$');
        const globs = inputs.filter((g) => g !== '$TURBO_DEFAULT$').map((g) => {
          const out = g.startsWith('!');
          const bare = out ? g.slice(1) : g;
          const path = bare.startsWith('$TURBO_ROOT$/') ? bare.slice('$TURBO_ROOT$/'.length) : posix.join(pkg.dir, bare);
          return out ? `!${path}` : path;
        });
        const previous = tasks.get(`${pkg.name}#${name}`);
        const task = make(pkg, name, 'turbo', {
          ...(previous?.command !== undefined ? { command: previous.command } : {}),
          cached: config.cache !== false,
          mode: declared && inputs.length === 0 ? 'empty' : withDefault ? (declared ? 'declared' : 'package-default') : 'declared',
          inputs: globs,
          outputs: strings(config.outputs).map((o) => (o.startsWith('!') ? `!${posix.join(pkg.dir, o.slice(1))}` : posix.join(pkg.dir, o))),
          global,
          ...(withDefault ? { base: 'package' as const } : {}),
        });
        task.deps.push(...(previous?.deps ?? []));
        for (const dep of strings(config.dependsOn)) {
          if (dep.startsWith('^')) task.deps.push({ task: dep.slice(1), kinds: [] });
          else task.deps.push({ spec: dep.replace(/^\/\/#/, `${packages.find((p) => p.dir === '')!.name}#`), how: 'dependsOn' });
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
    const cacheable = strings(record(record(record(nx.tasksRunnerOptions).default).options).cacheableOperations);
    if (Array.isArray(nx.plugins) && nx.plugins.length > 0) unread.push(`nx.json: ${nx.plugins.length} plugins infer targets this reader doesn't see`);
    const projects = new Map<string, { pkg: Package; targets: Record<string, unknown>; named: Record<string, unknown> }>();
    for (const path of [...files.keys()].filter((p) => /(^|\/)project\.json$/.test(p) && !p.includes('node_modules/'))) {
      const dir = path.slice(0, -'project.json'.length);
      const project = json(path);
      const pkg = byDir.get(dir) ?? { name: typeof project.name === 'string' ? project.name : dir.replace(/\/$/, ''), dir, manifest: {}, deps: new Map() };
      projects.set(pkg.name, { pkg, targets: record(project.targets), named: record(project.namedInputs) });
    }
    for (const pkg of packages) if (!projects.has(pkg.name) && pkg.manifest.scripts) projects.set(pkg.name, { pkg, targets: {}, named: record(record(pkg.manifest.nx).namedInputs) });
    const roots = [...projects.values()].map((p) => p.pkg).filter((p) => p.dir !== '').sort((a, b) => b.dir.length - a.dir.length);
    const projectOf = (path: string) => roots.find((p) => path.startsWith(p.dir))?.name;
    for (const e of graph.edges) {
      const [from, to] = [projectOf(e.from), projectOf(e.to)];
      if (from !== undefined && to !== undefined && from !== to) (inferred.get(from) ?? inferred.set(from, new Set()).get(from)!).add(to);
    }
    for (const { pkg } of projects.values()) for (const set of pkg.deps.values()) for (const n of set) (inferred.get(pkg.name) ?? inferred.set(pkg.name, new Set()).get(pkg.name)!).add(n);
    const projectByName = new Map([...projects.values()].map((p) => [p.pkg.name, p.pkg]));
    for (const { pkg, targets, named: own } of projects.values()) {
      const root = pkg.dir.replace(/\/$/, '');
      const names = new Set([...Object.keys(targets), ...Object.keys(pkg.manifest.scripts ?? {}), ...Object.keys(record(record(pkg.manifest.nx).targets))]);
      for (const name of names) {
        const config = { ...record(defaults[name]), ...record(record(record(pkg.manifest.nx).targets)[name]), ...record(targets[name]) };
        const deps: string[] = [];
        const globs: string[] = [];
        let other = 0;
        const expand = (input: unknown, seen: Set<string>, scope: 'self' | 'deps') => {
          if (typeof input === 'string') {
            const out = input.startsWith('!');
            const bare = out ? input.slice(1) : input;
            if (bare.startsWith('^')) { expand(bare.slice(1), seen, 'deps'); return; }
            if (bare.includes('{')) {
              const path = bare.replace('{workspaceRoot}/', '').replace('{projectRoot}', scope === 'deps' ? '{deps}' : root).replace(/^\//, '');
              (scope === 'deps' ? deps : globs).push(out ? `!${path}` : path);
              return;
            }
            if (seen.has(bare)) return;
            const definition = own[bare] ?? named[bare] ?? (bare === 'default' ? ['{projectRoot}/**/*'] : undefined);
            if (definition === undefined) { other++; return; }
            for (const each of Array.isArray(definition) ? definition : []) expand(each, new Set([...seen, bare]), scope);
            return;
          }
          const object = record(input);
          if (typeof object.fileset === 'string') expand(object.fileset, seen, scope);
          else if (typeof object.input === 'string') expand(object.input, seen, object.dependencies === true || object.projects === 'dependencies' ? 'deps' : scope);
          else other++;
        };
        const declared = Array.isArray(config.inputs);
        for (const input of declared ? (config.inputs as unknown[]) : ['default', '^default']) expand(input, new Set(), 'self');
        const depPackages = [...(inferred.get(pkg.name) ?? [])].map((n) => projectByName.get(n)).filter((p): p is Package => p !== undefined);
        for (const glob of deps) for (const dep of depPackages) globs.push(glob.replace('{deps}', dep.dir.replace(/\/$/, '')).replace(/^\//, ''));
        const cached = typeof config.cache === 'boolean' ? config.cache : cacheable.includes(name);
        const previous = tasks.get(`${pkg.name}#${name}`);
        const command = typeof record(config.options).command === 'string' ? String(record(config.options).command) : previous?.command;
        const task = make(pkg, name, 'nx', {
          ...(command !== undefined ? { command } : {}),
          cached,
          mode: declared ? ((config.inputs as unknown[]).length === 0 ? 'empty' : 'declared') : 'package-default',
          inputs: globs,
          outputs: strings(config.outputs).map((o) => o.replace('{workspaceRoot}/', '').replace('{projectRoot}', root).replace(/^\//, '')),
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
            else for (const p of strings(o.projects).filter((p) => p !== 'self')) task.deps.push({ spec: `${p}#${target}`, how: 'dependsOn' });
            if (o.projects === undefined || o.projects === 'self') if (o.dependencies !== true) task.deps.push({ spec: target, how: 'dependsOn' });
          }
        }
        tasks.set(task.id, task);
      }
    }
  }

  // Edges: a name in the same package, `pkg#task`, a fan-out to every package with that script, or `^task`/`from:` over the package's workspace dependencies.
  const edges: TaskEdge[] = [];
  const named = new Map<string, string[]>();
  for (const t of tasks.values()) (named.get(t.name) ?? named.set(t.name, []).get(t.name)!).push(t.id);
  for (const task of tasks.values()) {
    const pkg = byName.get(task.pkg);
    for (const dep of task.deps) {
      if ('task' in dep) {
        const kinds = dep.kinds.length > 0 ? dep.kinds : ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
        const names = task.runner === 'nx' && dep.kinds.length === 0 ? [...(inferred.get(task.pkg) ?? [])] : kinds.flatMap((k) => [...(pkg?.deps.get(k) ?? [])]);
        for (const name of new Set(names)) {
          const to = `${name}#${dep.task}`;
          if (tasks.has(to)) edges.push({ from: task.id, to, how: 'dependencies' });
        }
        continue;
      }
      if (dep.how === 'fan-out') {
        const re = specPattern(dep.spec, '.*');
        for (const [name, ids] of named) if (re.test(name)) for (const to of ids) if (to !== task.id) edges.push({ from: task.id, to, how: 'fan-out' });
        continue;
      }
      const hash = dep.spec.lastIndexOf('#');
      if (hash > 0) { if (tasks.has(dep.spec)) edges.push({ from: task.id, to: dep.spec, how: dep.how }); continue; }
      const re = specPattern(dep.spec, '[^#]*');
      for (const t of tasks.values()) if (t.pkg === task.pkg && t.id !== task.id && re.test(t.name)) edges.push({ from: task.id, to: t.id, how: dep.how });
    }
  }
  if ([...tasks.values()].some((t) => t.runner === 'script')) runners.add('script');

  const seen = new Set<string>();
  const unique = edges.filter((e) => { const k = `${e.from}\0${e.to}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const plain = new Map([...tasks].map(([id, { deps: _deps, ...task }]) => [id, task as Task]));
  return { runners: [...runners], tasks: plain, edges: unique, unread };
};
