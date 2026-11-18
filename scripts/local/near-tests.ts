/**
 * near-tests.ts: the test files near a local change, so a developer or agent runs those and not the
 * whole suite. It compares the working tree, uncommitted and new files included, with where the
 * branch left the default branch, and picks each test under why:
 *
 * - `changed`: the test files the change edits.
 * - `named`: those named for a module it changes, or for one that imports such a module itself, in
 *   the same folder, as `queue.test.ts` and `queue-searches.test.ts` are for `queue.ts`.
 * - `importing`: those that import a changed module, or one of the climbed importers, directly.
 * - `reaching`: those under the folder of a config the change edits, and whatever `extraReaching`
 *   adds (tests that load code from disk, a bundle or a fixture, which no import leads to). A path
 *   every test reads, from `LOCAL_EVERY` or a config in the root, reaches every test.
 *
 * Why so shallow: importers are followed one level, and never through a module only tests run.
 * Shared test harnesses import nearly every module, so following them, or every import through
 * workspace barrels as Vitest's `--changed` does, picks most of the suite: in our monorepo one
 * model module's change picked 494 of 1,035 files that way. The default branch's daily full run
 * catches what this misses.
 *
 * Where it runs: on developers' and agents' machines, by the `test:cached` script before it runs
 * the picked files' groups (`../shards/test-groups.ts`). Never in CI, which selects from the pull
 * request's diff. Node's own modules and `git` only.
 *
 * Usage:
 *   node scripts/local/near-tests.ts <base>          # prints local=<JSON>
 *   node scripts/local/near-tests.ts <base> --files  # prints the picked files, one per line
 * where <base> is the default branch, e.g. origin/main.
 *
 * Configure: `LOCAL_EVERY`, `AREA_ROOTS`, `ownJob`, `extraReaching` and `testFile` below.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { posix, resolve } from 'node:path';

// ---- Config -------------------------------------------------------------------------------------

/**
 * What a local change reaches every test through: the toolchain, the tests' settings and their
 * slots, the lockfile and the workspace. A path ending in `/` names a folder, one ending in `*` a
 * prefix. A config file in the root (`configFile`) counts too.
 */
export const LOCAL_EVERY: ReadonlyArray<string> = [
  'package.json',
  '.node-version',
  'tsconfig.base.json',
  'tsconfig.json',
  'vite.config.ts',
  'test.config.ts',
  'scripts/local/test-slots.ts',
  'scripts/local/test-file-slot.ts',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];

/**
 * Top folders that hold packages one level down, as `apps/<name>/` and `packages/<name>/`. A
 * path's area, whose modules' relative imports are read, is its package there, or its top folder.
 */
export const AREA_ROOTS: ReadonlyArray<string> = ['apps', 'packages'];

/** A test file a job of its own runs, never the ordinary tests: a container's or a proof's. */
export const ownJob = (path: string) =>
  path.endsWith('.sandbox.test.ts') || path.endsWith('.proof.test.ts');

/**
 * Tests a change reaches by no import: ones that read a module from disk, run a bundle built from
 * it, or cover it by a list of their own. Empty here; add your repo's rules.
 */
export const extraReaching = (
  _paths: ReadonlyArray<string>,
  _tracked: ReadonlySet<string>,
): ReadonlyArray<string> => [];

// -------------------------------------------------------------------------------------------------

export const configFile =
  /^(package\.json|tsconfig[\w.-]*\.json|[\w.-]+\.config\.[cm]?[jt]s|wrangler\.jsonc?)$/;

/**
 * The test files your runner discovers. Keep it equal to the planner's `testFile`
 * (`affected-checks.ts`) and the workflow's `ORDINARY_TESTS`: a `.spec.ts` suite needs
 * `/\.(test|spec)\.tsx?$/` in all three. This picks JS and TS tests only. Run any other suite
 * (pytest, a root integration suite) whole until you map its inputs.
 */
export const testFile = /\.test\.tsx?$/;

const moduleFile = /\.[cm]?[jt]sx?$/;

/** Whether only tests run a file: a test, or a module under a `testing/` directory. */
export const testOnly = (path: string) => testFile.test(path) || path.includes('/testing/');

/**
 * Whether any of `paths` is one `listed` names: the path itself, a folder's with a trailing `/`,
 * or each path that starts with an entry's text before a trailing `*`.
 */
export const touches = (paths: ReadonlyArray<string>, listed: ReadonlyArray<string>) =>
  paths.some((path) =>
    listed.some(
      (entry) =>
        path === entry ||
        (entry.endsWith('/') && path.startsWith(entry)) ||
        (entry.endsWith('*') && path.startsWith(entry.slice(0, -1))),
    ),
  );

/** Imports that run a module: not `import type`, and dynamic imports and `new URL` assets too. */
const runtimeImports = [
  /^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/gm,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bnew URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
];

/** The repo file a relative import names, as TypeScript resolves it. */
export const resolved = (from: string, specifier: string, tracked: ReadonlySet<string>) => {
  if (!specifier.startsWith('.')) return undefined;

  const path = posix.normalize(posix.join(posix.dirname(from), specifier));

  return [path, `${path}.ts`, `${path}.tsx`, path.replace(/\.js$/, '.ts'), `${path}/index.ts`].find(
    (candidate) => tracked.has(candidate),
  );
};

// Vite's `import.meta.glob`, with its first argument: a pattern, or a list of them.
const globCall =
  /\bimport\.meta\.glob\b[^(]*\(\s*(\[(?:'[^']*'|"[^"]*"|[^\]'"])*\]|'[^']*'|"[^"]*")/g;

/**
 * Whether a repo path is one `from`'s glob patterns match, relative to `from`'s folder. A `!`
 * pattern leaves nothing out, so a glob matches more, never less.
 */
const globbed = (from: string, list: string) => {
  const globs = [...list.matchAll(/'([^']*)'|"([^"]*)"/g)].flatMap((match) => {
    const glob = match[1] ?? match[2] ?? '';

    return glob.startsWith('!') ? [] : [posix.normalize(posix.join(posix.dirname(from), glob))];
  });

  return (path: string) => globs.some((glob) => posix.matchesGlob(path, glob));
};

/**
 * Each of `sources`' modules, with those of them that run it by a relative import, and those whose
 * `import.meta.glob` matches it, which Vitest follows all the same.
 */
export const importersAmong = (sources: ReadonlyMap<string, string>) => {
  const tracked = new Set(sources.keys());
  const found = new Map<string, Array<string>>();
  const add = (target: string, path: string) => {
    const importers = found.get(target) ?? [];

    importers.push(path);
    found.set(target, importers);
  };

  for (const [path, source] of sources) {
    for (const pattern of runtimeImports) {
      for (const match of source.matchAll(pattern)) {
        const target = resolved(path, match[1] ?? '', tracked);
        if (target !== undefined) add(target, path);
      }
    }

    for (const match of source.matchAll(globCall)) {
      const matches = globbed(path, match[1] ?? '');

      for (const target of tracked) if (target !== path && matches(target)) add(target, path);
    }
  }

  return found;
};

/** Reads files' contents: from a Git tree in the CLI, from a map in tests. */
export type Read = (paths: ReadonlyArray<string>) => ReadonlyMap<string, string>;

/**
 * Each of `files` that a change reaches: each it changes, and each that runs a changed file itself.
 * Imports aren't followed further, nor across packages, whose barrels lead every file to all of them.
 */
export const reachedFiles = (
  files: ReadonlyArray<string>,
  paths: ReadonlyArray<string>,
  read: Read,
  tracked: ReadonlySet<string>,
) => {
  const changed = new Set(paths);
  // A file the change deletes still resolves, so a file that runs it runs and fails.
  const known = new Set([...tracked, ...paths]);
  const sources = read(files);

  return files.filter((file) => {
    if (changed.has(file)) return true;

    const source = sources.get(file) ?? '';
    // Root scripts are also run as subprocesses or read as text by tests.
    if (paths.some((path) => path.startsWith('scripts/') && source.includes(path))) return true;

    // Tests that read a workflow by a built URL reach every workflow.
    if (
      paths.some((path) => path.startsWith('.github/workflows/')) &&
      source.includes('../.github/workflows/')
    )
      return true;

    return runtimeImports.some((pattern) =>
      [...source.matchAll(pattern)].some((match) => {
        const target = resolved(file, match[1] ?? '', known);

        return target !== undefined && changed.has(target);
      }),
    );
  });
};

/** The folder whose modules' relative imports are read for a path. */
export const areaOf = (path: string) => {
  const parts = path.split('/');
  const depth = AREA_ROOTS.includes(parts[0] ?? '') && parts.length > 2 ? 2 : 1;

  return `${parts.slice(0, depth).join('/')}/`;
};

export interface Near {
  readonly changed: ReadonlyArray<string>;
  readonly named: ReadonlyArray<string>;
  readonly importing: ReadonlyArray<string>;
  readonly reaching: ReadonlyArray<string>;
}

/** The ordinary test files near a change to `paths`, each under why, each listed once. */
export const localTests = (
  paths: ReadonlyArray<string>,
  read: Read,
  tracked: ReadonlySet<string>,
): Near => {
  const tests = [...tracked].filter((path) => testFile.test(path) && !ownJob(path)).sort();
  const known = new Set(tests);
  const every = paths.some(
    (path) => touches([path], LOCAL_EVERY) || (!path.includes('/') && configFile.test(path)),
  );

  if (every) {
    const changed = tests.filter((file) => paths.includes(file));

    return {
      changed,
      named: [],
      importing: [],
      reaching: tests.filter((file) => !changed.includes(file)),
    };
  }

  const graphs = new Map<string, ReturnType<typeof importersAmong>>();
  const importersIn = (path: string) => {
    const area = areaOf(path);
    const graph =
      graphs.get(area) ??
      importersAmong(
        read([...tracked].filter((file) => file.startsWith(area) && moduleFile.test(file))),
      );
    graphs.set(area, graph);

    return [...new Set(graph.get(path))];
  };

  const modules = paths.filter(
    (path) =>
      tracked.has(path) && path.includes('/') && moduleFile.test(path) && !testFile.test(path),
  );
  const climbed = new Set(modules);

  for (const module of modules) {
    for (const importer of importersIn(module)) if (!testOnly(importer)) climbed.add(importer);
  }

  const stems = [...climbed].map((path) => path.replace(moduleFile, ''));
  const configs = paths.flatMap((path) =>
    configFile.test(posix.basename(path)) ? [`${posix.dirname(path)}/`] : [],
  );
  const picked = new Set<string>();
  const pick = (found: Iterable<string>) => {
    const fresh = [...new Set(found)].filter((file) => known.has(file) && !picked.has(file)).sort();

    for (const file of fresh) picked.add(file);

    return fresh;
  };

  return {
    changed: pick(paths),
    named: pick(
      tests.filter((file) => {
        const name = file.replace(testFile, '');

        return stems.some((stem) => name === stem || name.startsWith(`${stem}-`));
      }),
    ),
    importing: pick(reachedFiles(tests, [...paths, ...climbed], read, tracked)),
    reaching: pick([
      ...extraReaching(paths, tracked),
      ...tests.filter((file) => configs.some((folder) => file.startsWith(folder))),
    ]),
  };
};

// ---- Git ----------------------------------------------------------------------------------------

const git = (root: string, ...args: ReadonlyArray<string>) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Each path's contents in `tree`, read in one `git cat-file --batch`. */
export const gitRead =
  (root: string, tree: string): Read =>
  (paths) => {
    const output = execFileSync('git', ['cat-file', '--batch'], {
      cwd: root,
      input: paths.map((path) => `${tree}:${path}\n`).join(''),
      maxBuffer: 256 * 1024 * 1024,
    });
    const found = new Map<string, string>();
    let at = 0;

    for (const path of paths) {
      const end = output.indexOf(0x0a, at);
      const header = output.subarray(at, end).toString('utf8');
      at = end + 1;
      // A path missing from the tree prints `<name> missing` and no body.
      if (header.endsWith(' missing')) continue;

      const size = Number(header.slice(header.lastIndexOf(' ') + 1));
      found.set(path, output.subarray(at, at + size).toString('utf8'));
      at += size + 1;
    }

    return found;
  };

/**
 * The checkout's working tree as a tree object, its uncommitted changes and new files among them,
 * written through an index of its own, in Git's folder, so the checkout's own index stays as it is.
 */
export const workingTree = (root: string) => {
  const index = resolve(root, git(root, 'rev-parse', '--git-path', `near-index-${process.pid}`).trim());
  const own = {
    cwd: root,
    encoding: 'utf8' as const,
    env: { ...process.env, GIT_INDEX_FILE: index },
  };

  try {
    const checkoutIndex = resolve(root, git(root, 'rev-parse', '--git-path', 'index').trim());
    if (existsSync(checkoutIndex)) copyFileSync(checkoutIndex, index);

    execFileSync('git', ['add', '--all'], own);

    return execFileSync('git', ['write-tree'], own).trim();
  } finally {
    rmSync(index, { force: true });
  }
};

/** The tests near what the working tree changes since it left `base`, with how many paths. */
export const near = (root: string, base: string) => {
  const tree = workingTree(root);
  const from = git(root, 'merge-base', base, 'HEAD').trim();
  const paths = git(root, 'diff', '--name-only', '-z', '--no-renames', from, tree)
    .split('\0')
    .filter((path) => path !== '');
  const tracked = new Set(git(root, 'ls-tree', '-r', '--name-only', '-z', tree).split('\0'));

  return { paths: paths.length, ...localTests(paths, gitRead(root, tree), tracked) };
};

const main = (args: ReadonlyArray<string>) => {
  const [base, flag, ...rest] = args;

  if (base === undefined || base.startsWith('--') || (flag !== undefined && flag !== '--files') || rest.length > 0) {
    console.error('usage: near-tests.ts <base> [--files]');
    return 2;
  }

  const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  const found = near(root, base);

  if (flag === '--files') {
    for (const file of [...found.changed, ...found.named, ...found.importing, ...found.reaching])
      console.log(file);
  } else {
    console.log(`local=${JSON.stringify(found)}`);
  }

  return 0;
};

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
