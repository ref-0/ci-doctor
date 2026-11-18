#!/usr/bin/env node
/**
 * Which checks a change needs: the selection planner CI's plan job runs before any install.
 *
 *     node scripts/affected-checks.ts [--near] <base> [<head>]
 *
 * Runs in CI's plan job (2 vCPU, Node built-ins only, no workspace install), and locally to see what
 * a branch would run. Configure the block below. Reference implementation from a production
 * monorepo; adapt to your repo. Why each rule exists: the guide's sections 4 and 5.
 *
 * It prints `key=value` lines for `$GITHUB_OUTPUT`:
 *
 * - `packages=<JSON>`: workspace directories (with a trailing `/`) whose tests run whole, and test
 *   files that run alone. `[]` when no ordinary test needs to run. `null` for the whole workspace,
 *   the conservative default whenever the planner can't prove a change is narrower.
 * - `uncovered=<JSON>`: with `--near`, the covered-only test files the change doesn't cover, which a
 *   pull request leaves out even when it runs everything. Main's sweep runs them.
 * - `ci_jobs=<JSON>`: with `--near`, the CI jobs a change to CI's own files (or a step's tool) runs
 *   as if the change reached them.
 * - `ci_needs=<JSON>`: the jobs those wait for, which run as on any run.
 * - `own_jobs=<JSON>`: the test files a job of their own runs (`ownJob`: real containers, proofs)
 *   that the change reaches, by `ownJobTests`'s narrower rule. `null` for all of them.
 * - `test_selection=<JSON>`: each selected test file and one rule that selects it.
 *
 * The changes are those `<head>` (default `HEAD`) makes since it left `<base>`. `--near` is for a
 * pull request: the integration-heavy package's tests (`config.near`) are only those near the
 * change, covered-only tests run only when covered, and CI-file edits run only the jobs they touch.
 * Without `--near`, as for main's sweep, those all widen to everything.
 *
 * Everything unknown fails toward running everything. Main's sweeps are the safety net for what
 * "near" can't prove.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { posix } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

// ==== Configure ================================================================================
// Every repo-specific value lives here. Paths are from the repo's root. A list entry matches a path
// exactly, a folder with a trailing `/`, or a prefix with a trailing `*` (see `touches`).

const config = {
  /** Folders holding workspace packages, searched for `package.json`s the workspace globs match. */
  packageRoots: ['apps/', 'packages/'],

  /** The prefix of your workspace packages' names, for finding them mentioned in source and configs. */
  scope: '@<org>/',

  /**
   * The condition in a package's `exports` that names its source file, if your packages export
   * source under one (for example `"@<org>/source": "./src/index.ts"`). Empty if none.
   */
  sourceCondition: '@<org>/source',

  /**
   * Inputs the whole workspace reads: the toolchain, shared tsconfig and test setup. A change to one
   * runs everything. The lockfile and `pnpm-workspace.yaml` are read by their parts instead.
   */
  shared: [
    'package.json',
    '.node-version',
    'tsconfig.base.json',
    'tsconfig.json',
    'vite.config.ts',
    '<test-config>',
  ],

  /** What decides what every other check runs: a change to one runs everything. */
  wholeRun: ['scripts/affected-checks.ts', 'scripts/changed-files.ts'],

  /** The main CI workflow, whose jobs a change to CI's files is diffed against. */
  ciWorkflow: '.github/workflows/ci.yml',

  /** Reusable workflows `ciWorkflow` calls with `uses: ./.github/workflows/...`. */
  calledWorkflows: [] as Array<string>,

  /** Tests that hold the workflows to their rules (e.g. a per-job budget test). Any CI edit runs them. */
  workflowRuleTests: [] as Array<string>,

  /**
   * Root scripts CI's steps run that decide what a run checks or how its checks run: those that
   * choose, shard, claim, cache and record the test files, and the result's verdict. Only a full run
   * takes each of their paths, so a change that reaches one runs everything.
   */
  runScripts: ['scripts/shards/', 'scripts/sweeps/snapshot-pins.ts', 'scripts/records/'],

  /**
   * Root scripts a CI step runs as a tool: each checks or reports one thing and decides nothing
   * else (the docs budget, the flake filer). With `--near`, a change that reaches one runs the jobs
   * whose steps run it, not everything. Before this rule, 5 of 12 full PR runs in one day ran
   * everything for one such script alone. A root script `ciWorkflow` runs that neither list holds
   * runs everything, and the plan logs it.
   */
  stepTools: ['scripts/flakes/'],

  /**
   * The root manifest's own tools: scripts that check or report and decide nothing else, where
   * install, build and tests run the others. A change that reaches the root manifest only through
   * these runs, with `--near`, the jobs whose steps run `pnpm run <name>`.
   */
  manifestTools: ['check', 'check:types'],

  /** Paths only lint and its tests read: a change reaches only the tests that import or name them. */
  lintOnly: ['lint/'],

  /**
   * Paths that reach no tests: docs, agent guidance, ignore files. They still get static checks and
   * lint, which run on every ready PR.
   */
  reachesNothing: (path: string) =>
    path.endsWith('.md') ||
    path.startsWith('.agents/') ||
    path.startsWith('.claude/') ||
    path === 'AGENTS.md' ||
    path === '.gitignore',

  /**
   * The test files your runner discovers. Keep it equal to the workflow's `ORDINARY_TESTS` and
   * scripts/local/near-tests.ts's `testFile`: a `.spec.ts` suite needs `/\.(test|spec)\.tsx?$/` in
   * all three. The planner knows JS and TS tests in the workspace's packages only. Keep every other
   * suite (pytest, a root integration suite) in a job that runs on every ready run until you map its
   * inputs here; a path outside every package already runs everything.
   */
  testFile: /\.test\.tsx?$/,

  /** Test files a job of its own runs, never the ordinary shards: e.g. Docker or proof tests. */
  ownJob: (path: string) => /\.(sandbox|proof)\.test\.tsx?$/.test(path),

  /**
   * Explicit coverage declarations for `ownJob` files: inputs a file reaches by neither its own
   * imports nor a file URL, such as a bundle it starts, a Dockerfile, or a config a harness reads.
   * Own-job file → paths it covers.
   */
  ownJobCovers: new Map<string, ReadonlyArray<string>>([
    // ['<server-package>/src/queue.sandbox.test.ts', ['<server-package>/Dockerfile', '<server-package>/wrangler.jsonc']],
  ]),

  /**
   * Shared libraries whose dependents follow the entry (`exports` key) they import rather than the
   * whole package. Use it for a library with many entries that each re-export a few modules. In one
   * example, a library edit went from 520 selected test files to 120. Others keep package edges.
   */
  entryScoped: [] as Array<string>,

  /**
   * "Near" selection, for a package whose every integration test boots the whole app, so the import
   * graph says everything reaches everything. Set `root` to `''` to turn it off.
   */
  near: {
    /** The package's directory, e.g. `apps/server/`. */
    root: '<server-package>/',
    /**
     * The fan-in cutoff: the most of the package's modules that may run a module the upward climb
     * goes past. A module more run is shared by most of the package (storage, logging), and climbing
     * past it reached up to 277 of 394 test files. In one day's 26 merged PRs, any limit from 15 to
     * 30 chose the same files.
     */
    sharedImporters: 20,
  },

  /**
   * Explicit coverage declarations for the near package: test files that reach code by neither
   * import nor name. They read source text, migrations, Dockerfiles or fixtures from disk, execute a
   * generated bundle, or reach a module only through the whole app. Imports can't express these: a
   * green run once missed both intended outage tests until a bundle-consumer edge was added.
   * Test file → paths it covers.
   */
  nearCovers: new Map<string, ReadonlyArray<string>>([
    // ['<server-package>/src/migrations.test.ts', ['<server-package>/migrations/']],
  ]),

  /** Tests in `nearCovers` that read test files too, so a change only tests run reaches them. */
  nearCoversReadTests: new Set<string>(),

  /**
   * Covered-only tests: expensive files (model checks, 128 MiB packs, 50,000-object histories, wide
   * grids, full oracle corpora) tied to the inputs they prove. A PR runs one only if it touches a
   * covered path, even when it otherwise selects everything. Sweeps always run them. Split before
   * you move: keep the light cases on PRs and list only the scale proof here. Never shrink a proof to
   * make it fit. Test file or folder → paths it covers. Keep the keys equal to `COVERED_ONLY` in
   * `scripts/shards/test-groups.ts`, which runs each one as a group alone.
   */
  coveredOnly: new Map<string, ReadonlyArray<string>>([
    // ['<server-package>/src/pack-ceiling.test.ts', ['<server-package>/src/pack*', '<server-package>/src/testing/packs.ts']],
    // ['<server-package>/verification/', ['<server-package>/verification/']],
  ]),

  /**
   * The jobs the plan knows, by the outputs their `if:` reads. A CI edit that reaches any other job
   * runs everything, so a new job runs on its own PR until the plan learns it.
   */
  plannedJobs: new Set(['static', 'lint', 'types', 'tests', 'test-times', 'pack', 'proof', 'rust']),

  /** The jobs that decide what every other job runs: a change to either runs everything. */
  decidingJobs: new Set(['plan', 'result']),
};
// ==== End of configuration =====================================================================

const root = fileURLToPath(new URL('..', import.meta.url));

const usage = 'usage: node scripts/affected-checks.ts [--near] <base> [<head>]';

const rootManifest = 'package.json';

const ciFiles = [config.ciWorkflow, ...config.calledWorkflows, '.github/actions/'];

/** The checks themselves: a change to one runs everything, but for a PR's CI edit `ciJobs` reads. */
const checks = [...config.wholeRun, ...ciFiles];

const dependencyKinds = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/** What an `exports` key names: a path, or conditions that each name one, or nothing. */
type PackageReason = 'package-edit' | 'dependent-package' | 'lockfile' | 'root-script';

type SelectionReason =
  | PackageReason
  | 'edited'
  | 'imports-changed-module'
  | 'named-for-changed-module'
  | 'coverage-declaration'
  | 'package-entry'
  | 'ci-file'
  | 'fallback-everything';

type TestSelection = Map<string, SelectionReason>;

type ExportTarget = string | null | { readonly [condition: string]: ExportTarget };

/** A workspace package's manifest, as far as the planner reads it. */
interface Manifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly exports?: { readonly [key: string]: ExportTarget };
}

/** A workspace package: its directory, with a trailing slash, and its manifest. */
interface Package {
  readonly directory: string;
  readonly manifest: Manifest;
}

const decodeManifest = (text: string): Manifest => {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('a package.json that is no object');

  const manifest = parsed as Manifest;
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new Error('a workspace package.json without a name');
  }

  return manifest;
};

const git = (...args: ReadonlyArray<string>) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** A file's text at a commit, or undefined when the commit has no such file. */
const fileAt = (commit: string, path: string) => {
  const shown = spawnSync('git', ['show', `${commit}:${path}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });

  return shown.status === 0 ? shown.stdout : undefined;
};

/** Each path's contents at `head`, read in one batch. */
const contents = (head: string, paths: ReadonlyArray<string>) => {
  const found = new Map<string, string>();
  if (paths.length === 0) return found;

  const output = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: paths.map((path) => `${head}:${path}\n`).join(''),
    maxBuffer: 256 * 1024 * 1024,
  });
  let at = 0;

  for (const path of paths) {
    const end = output.indexOf(0x0a, at);
    const header = output.subarray(at, end).toString('utf8');
    const size = header.endsWith(' missing') ? -1 : Number(header.slice(header.lastIndexOf(' ') + 1));

    if (size < 0) {
      at = end + 1;
      continue;
    }

    found.set(path, output.subarray(end + 1, end + 1 + size).toString('utf8'));
    at = end + 1 + size + 1;
  }

  return found;
};

// ---- Paths --------------------------------------------------------------------------------------

/**
 * Whether any of `paths` is one `listed` names: the path itself, a folder's with a trailing `/`,
 * or each path that starts with an entry's text before a trailing `*`.
 */
const touches = (paths: ReadonlyArray<string>, listed: ReadonlyArray<string>) =>
  paths.some((path) =>
    listed.some(
      (entry) =>
        path === entry ||
        (entry.endsWith('/') && path.startsWith(entry)) ||
        (entry.endsWith('*') && path.startsWith(entry.slice(0, -1))),
    ),
  );

const configFile =
  /^(package\.json|tsconfig[\w.-]*\.json|[\w.-]+\.config\.[cm]?[jt]s|wrangler\.jsonc?)$/;

const testFile = config.testFile;

const moduleFile = /\.[cm]?[jt]sx?$/;

/** Whether only tests run a file: a test, or a module under a `testing/` directory. */
const testOnly = (path: string) => testFile.test(path) || path.includes('/testing/');

/** An ordinary test file: one the test shards run. */
const ordinaryTest = (path: string) => testFile.test(path) && !config.ownJob(path);

// ---- Minimal YAML reading, as pnpm writes it ----------------------------------------------------

const unquote = (text: string) =>
  /^'.*'$/.test(text) ? text.slice(1, -1).replaceAll("''", "'") : text;

/** A YAML line's key and value as pnpm writes them, plain or in single quotes. */
const keyValue = (line: string) => {
  const match = /^('(?:[^']|'')*'|.*?):(?: (.*))?$/.exec(line.trim());

  return match === null ? undefined : ([unquote(match[1] ?? ''), unquote(match[2] ?? '')] as const);
};

const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * A YAML mapping's entries as pnpm writes them: each key at `indent` spaces with the lines under
 * it, up to the next line at that indent or less. Blank lines and comments belong to none.
 */
const entries = (lines: ReadonlyArray<string>, indent: number) => {
  const found = new Map<string, Array<string>>();
  let entry: Array<string> | undefined;

  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    if (indentOf(line) < indent) entry = undefined;

    if (indentOf(line) === indent) {
      entry = [];
      found.set(keyValue(line)?.[0] ?? line, entry);
    }

    entry?.push(line);
  }

  return found;
};

/** The keys whose entries differ between two readings, with those only one of them has. */
const differing = (
  before: ReadonlyMap<string, ReadonlyArray<string>>,
  after: ReadonlyMap<string, ReadonlyArray<string>>,
) =>
  new Set(
    [...before.keys(), ...after.keys()].filter(
      (key) => before.get(key)?.join('\n') !== after.get(key)?.join('\n'),
    ),
  );

// ---- The workspace graph ------------------------------------------------------------------------

// What each of a workspace glob's wildcards matches of a path.
const wildcards = new Map([
  ['**', '.+'],
  ['*', '[^/]+'],
]);

/**
 * The workspace's package globs at `head`, from `pnpm-workspace.yaml`, as patterns over a package's
 * `package.json`: `*` within a segment, `**` across them, and `!` to leave paths out.
 * TODO(npm/yarn workspaces): read `workspaces` from the root package.json instead.
 */
const workspaceGlobs = (head: string) => {
  const text = fileAt(head, 'pnpm-workspace.yaml') ?? '';
  const pattern = (glob: string) => {
    const parts = glob.replace(/\/$/, '').split(/(\*\*|\*)/);
    const source = parts.map(
      (part) => wildcards.get(part) ?? part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'),
    );

    return new RegExp(`^${source.join('')}/package\\.json$`);
  };

  const globs = (entries(text.split('\n'), 0).get('packages') ?? [])
    .slice(1)
    .map((line) => unquote(line.trim().replace(/^-\s*/, '')));

  return {
    included: globs.filter((glob) => !glob.startsWith('!')).map(pattern),
    excluded: globs.filter((glob) => glob.startsWith('!')).map((glob) => pattern(glob.slice(1))),
  };
};

/** The workspace's packages at `head`, by name, nested ones among them. */
const manifests = (head: string) => {
  const packages = new Map<string, Package>();
  const { included, excluded } = workspaceGlobs(head);
  const listed = git('ls-tree', '-r', '--name-only', '-z', head, '--', ...config.packageRoots);

  for (const path of listed.split('\0')) {
    if (!included.some((glob) => glob.test(path)) || excluded.some((glob) => glob.test(path))) {
      continue;
    }

    const manifest = decodeManifest(git('show', `${head}:${path}`));
    if (packages.has(manifest.name)) throw new Error('duplicate workspace package name');

    packages.set(manifest.name, { directory: path.slice(0, path.lastIndexOf('/') + 1), manifest });
  }

  return packages;
};

/**
 * The package that holds a path, by name: the deepest whose directory it's in, so a file of
 * `apps/web/worker/` belongs to that nested package and not to `apps/web/`.
 */
const ownerOf = (path: string, packages: ReadonlyMap<string, Package>) =>
  [...packages]
    .filter(([, { directory }]) => path.startsWith(directory))
    .sort(([, left], [, right]) => right.directory.length - left.directory.length)[0]?.[0];

const dependencies = (manifest: Manifest, packages: ReadonlyMap<string, Package>) =>
  new Set(
    dependencyKinds.flatMap((kind) =>
      Object.keys(manifest[kind] ?? {}).filter((name) => packages.has(name)),
    ),
  );

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// What a file runs itself: imports that aren't type-only, dynamic imports, and files it opens by
// URL. A Worker a test starts from a bundler config isn't among them.
const runtimeImports = [
  /^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/gm,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bnew URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
];

// A type-only import or export, which no runtime loads.
const typeOnly = /^\s*(?:import|export)\s+type\s[^;]*?from\s*['"][^'"]+['"]/gm;

// A string, in quotes or backticks, on one line.
const quoted = /['"`]([^'"`\n]*)['"`]/g;

// A string that is a workspace package's specifier, as `'@<org>/lib/queue'`.
const quotedSpecifier = new RegExp(
  `['"](${escaped(config.scope)}[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*)['"]`,
  'g',
);

/** The repo file a relative import names, as TypeScript resolves it. */
const resolved = (from: string, specifier: string, tracked: ReadonlySet<string>) => {
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

/** Each of `sources`' modules, with those of them that run it, by imports or `import.meta.glob`. */
const importersAmong = (sources: ReadonlyMap<string, string>) => {
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

/** Each module under a directory, with the modules there that run it. */
const importersOf = (directory: string, head: string) =>
  importersAmong(
    contents(
      head,
      git('ls-tree', '-r', '--name-only', '-z', head, '--', directory)
        .split('\0')
        .filter((path) => moduleFile.test(path)),
    ),
  );

/**
 * The ordinary test files that run any of `files`, followed through every module that runs one,
 * or undefined when a module that isn't only for tests runs one.
 */
const testsRunning = (
  files: ReadonlySet<string>,
  importers: ReadonlyMap<string, ReadonlyArray<string>>,
) => {
  const found = new Set<string>();
  const waiting = [...files];

  for (let file = waiting.pop(); file !== undefined; file = waiting.pop()) {
    if (found.has(file)) continue;

    if (!testOnly(file)) return undefined;

    found.add(file);
    waiting.push(...(importers.get(file) ?? []));
  }

  return [...found].filter(ordinaryTest);
};

/**
 * Manifest dependencies, plus names in imports or build commands and paths in configs. A name only
 * tests run (a test helper that builds another app) makes no dependency of the whole package:
 * `tests` gives the test files that run it instead. So a helper used only by tests selects its
 * readers, not every production consumer.
 */
const packageGraph = (head: string, packages: ReadonlyMap<string, Package>) => {
  const graph = new Map(
    [...packages].map(([name, { manifest }]) => [name, dependencies(manifest, packages)]),
  );
  const testMentions = new Map<string, Map<string, Set<string>>>();
  const tests = new Map<string, Map<string, ReadonlyArray<string>>>();
  const roots = config.packageRoots.map((path) => escaped(path.replace(/\/$/, ''))).join('|');
  const mentions = spawnSync(
    'git',
    [
      'grep',
      '-z',
      '-I',
      '-o',
      '-E',
      `${escaped(config.scope).replaceAll('\\/', '/')}[A-Za-z0-9_.-]+|(${roots})(/[A-Za-z0-9_.-]+)+`,
      head,
      '--',
      ...config.packageRoots,
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );

  if (mentions.status !== 0 && mentions.status !== 1) {
    throw new Error('could not read workspace references');
  }

  for (const [, location = '', mention = ''] of mentions.stdout.matchAll(/([^\0]+)\0([^\n]+)\n/g)) {
    const path = location.slice(head.length + 1);
    const owner = ownerOf(path, packages);
    const file = path.slice(path.lastIndexOf('/') + 1);
    const target = packages.has(mention)
      ? mention
      : configFile.test(file)
        ? ownerOf(`${mention}/`, packages)
        : undefined;
    if (owner === undefined || target === undefined || owner === target) continue;

    if (configFile.test(file) || !testOnly(path)) {
      graph.get(owner)?.add(target);
    } else {
      const targets = testMentions.get(owner) ?? new Map<string, Set<string>>();
      const files = targets.get(target) ?? new Set<string>();

      files.add(path);
      targets.set(target, files);
      testMentions.set(owner, targets);
    }
  }

  // A test-only mention that other code runs after all, or a dependency the manifest already
  // has, is the whole package's.
  for (const [owner, targets] of testMentions) {
    const importers = importersOf(packages.get(owner)?.directory ?? '', head);
    const running = new Map<string, ReadonlyArray<string>>();

    for (const [target, files] of targets) {
      if (graph.get(owner)?.has(target)) continue;

      const found = testsRunning(files, importers);
      if (found === undefined) graph.get(owner)?.add(target);
      else running.set(target, found);
    }

    tests.set(owner, running);
  }

  return { graph, tests };
};

// ---- Lockfile routing ---------------------------------------------------------------------------

/**
 * The snapshots an importer or a snapshot depends on, by key. An importer gives each dependency's
 * name with its `version:` a level under it, and a snapshot gives `name: version`. A workspace
 * package's `link:` names no snapshot: that package's own importer covers it.
 * TODO(other package managers): this reads pnpm's lockfile v9 layout.
 */
const references = (lines: ReadonlyArray<string>) => {
  const found: Array<string> = [];
  let name = '';

  for (const line of lines) {
    const pair = keyValue(line);
    const depth = indentOf(line);
    if (pair === undefined || (depth !== 6 && depth !== 8)) continue;

    const [key, value] = pair;
    const dependency = depth === 6 ? key : name;

    if (depth === 6 && value === '') {
      name = key;
    } else if ((depth === 6 || key === 'version') && !value.startsWith('link:')) {
      found.push(
        (value.split('(')[0] ?? '').lastIndexOf('@') > 0 ? value : `${dependency}@${value}`,
      );
    }
  }

  return found;
};

/** Every snapshot an importer installs, or undefined when it names one the lockfile lacks. */
const installs = (
  importer: ReadonlyArray<string>,
  snapshots: ReadonlyMap<string, ReadonlyArray<string>>,
) => {
  const found = new Set<string>();
  const waiting = references(importer);

  for (let key = waiting.pop(); key !== undefined; key = waiting.pop()) {
    if (found.has(key)) continue;

    const snapshot = snapshots.get(key);
    if (snapshot === undefined) return undefined;

    found.add(key);
    waiting.push(...references(snapshot));
  }

  return found;
};

/** One YAML document of a lockfile: its sections, and the entries of the three read by part. */
const lockfileDocument = (text: string) => {
  const sections = entries(text.split('\n'), 0);
  const part = (name: string) => entries(sections.get(name) ?? [], 2);

  return {
    sections,
    importers: part('importers'),
    packages: part('packages'),
    snapshots: part('snapshots'),
  };
};

// The lockfile's sections a change may touch and still reach only some importers. Each importer
// records the version its catalog entries resolved to, so `catalogs` needs no reading.
const lockfileParts = new Set(['catalogs', 'importers', 'packages', 'snapshots']);

/**
 * The importers whose installs a lockfile change changes: each whose own entry changed, and each
 * that installs a snapshot or a package that changed. Null (everything) when the change reaches the
 * root's importer, touches any other section (settings, overrides, patches, the lockfile's
 * version), or names a snapshot the lockfile lacks.
 *
 * Gotcha: the lockfile doesn't record what pnpm hoists for dependencies that import a package they
 * don't declare, so a change there reaches no importer. Hoisting can hide undeclared edges.
 */
const lockfileImporters = (before: string, after: string) => {
  const old = before.split(/^---$/m).map(lockfileDocument);
  const now = after.split(/^---$/m).map(lockfileDocument);
  const found = new Set<string>();
  if (old.length !== now.length) return null;

  for (const [index, next] of now.entries()) {
    const previous = old[index];
    if (previous === undefined) return null;

    if ([...differing(previous.sections, next.sections)].some((name) => !lockfileParts.has(name))) {
      return null;
    }

    const packages = differing(previous.packages, next.packages);
    const snapshots = differing(previous.snapshots, next.snapshots);
    const importers = differing(previous.importers, next.importers);

    // A package's resolution is under its key without the peers, which its snapshots add.
    for (const key of [...previous.snapshots.keys(), ...next.snapshots.keys()]) {
      if (packages.has(key.split('(')[0] ?? '')) snapshots.add(key);
    }

    for (const importer of new Set([...previous.importers.keys(), ...next.importers.keys()])) {
      const installed = [previous, next].map((side) =>
        installs(side.importers.get(importer) ?? [], side.snapshots),
      );
      if (installed.some((side) => side === undefined)) return null;

      if (
        importers.has(importer) ||
        installed.some((side) => [...(side ?? [])].some((key) => snapshots.has(key)))
      ) {
        found.add(importer);
      }
    }
  }

  return found.has('.') ? null : [...found];
};

/**
 * The packages a change to the lockfile or to `pnpm-workspace.yaml` changes the installs of, by
 * name, or null for the whole workspace. The workspace file's catalogs reach a package only through
 * the lockfile, so a change to them alone needs nothing of its own; any other workspace setting
 * (the package manager, global settings) selects everything.
 */
const installChanges = (
  path: string,
  base: string,
  head: string,
  packages: ReadonlyMap<string, Package>,
) => {
  const before = fileAt(base, path);
  const after = fileAt(head, path);
  if (before === undefined || after === undefined) return null;

  if (path === 'pnpm-workspace.yaml') {
    const sections = differing(entries(before.split('\n'), 0), entries(after.split('\n'), 0));

    return [...sections].every((name) => name === 'catalog' || name === 'catalogs') ? [] : null;
  }

  const importers = lockfileImporters(before, after);
  const found: Array<string> = [];
  if (importers === null) return null;

  for (const importer of importers) {
    const owner = [...packages].find(([, { directory }]) => directory === `${importer}/`);
    if (owner === undefined) return null;

    found.push(owner[0]);
  }

  return found;
};

// ---- Changed packages ---------------------------------------------------------------------------

/**
 * Each of `files` that a change reaches: each it changes, and each that runs a changed file
 * itself. Imports aren't followed further here: in an integration-heavy package a few shared
 * modules lead nearly every test to most of the code, which main's sweep checks once a day. Nor are
 * workspace packages, whose barrels lead every file to all of them.
 */
const reachedFiles = (
  files: ReadonlyArray<string>,
  paths: ReadonlyArray<string>,
  head: string,
  tracked: ReadonlySet<string>,
) => {
  const changed = new Set(paths);
  // A file the change deletes still resolves, so a file that runs it runs and fails.
  const known = new Set([...tracked, ...paths]);
  const sources = contents(head, files);
  const found: TestSelection = new Map();

  for (const file of files) {
    if (changed.has(file)) {
      found.set(file, 'edited');
      continue;
    }

    const source = sources.get(file) ?? '';
    // Root scripts are also run as subprocesses or read as text by tests.
    if (paths.some((path) => path.startsWith('scripts/') && source.includes(path))) {
      found.set(file, 'root-script');
      continue;
    }

    // Tests may read a workflow by a URL a template builds, so a workflow reaches each that reads one.
    if (
      paths.some((path) => path.startsWith('.github/workflows/')) &&
      source.includes('.github/workflows/')
    ) {
      found.set(file, 'ci-file');
      continue;
    }

    for (const pattern of runtimeImports) {
      const target = [...source.matchAll(pattern)]
        .map((match) => resolved(file, match[1] ?? '', known))
        .find((path) => path !== undefined && changed.has(path));
      if (target === undefined) continue;

      found.set(file, target.startsWith('scripts/') ? 'root-script' : 'imports-changed-module');
      break;
    }
  }

  return found;
};

/**
 * The ordinary test files that run a package's edits, when only tests run them: test files, and
 * modules under `testing/` that the package's manifest doesn't export. Undefined when other code
 * may run one, or a `testing/` module is gone, since a test that still imports it wouldn't be found.
 */
const testsAlone = (
  edited: ReadonlyArray<string>,
  owner: Package | undefined,
  head: string,
  tracked: ReadonlySet<string>,
) => {
  if (owner === undefined) return undefined;

  const named = JSON.stringify(owner.manifest);
  const onlyTests = edited.every(
    (path) =>
      testFile.test(path) ||
      (testOnly(path) && tracked.has(path) && !named.includes(path.slice(owner.directory.length))),
  );
  if (!onlyTests) return undefined;

  return testsRunning(new Set(edited), importersOf(owner.directory, head))?.filter((path) =>
    tracked.has(path),
  );
};

/**
 * The packages a change edits, by name, with those whose installs it changes, and the test files
 * that run alone for a package whose edits only tests run. A reason when it needs the whole workspace:
 * a shared input, the checks themselves, or unknown code. Root scripts and their consumers are
 * expanded before this.
 */
const changedPackages = (
  paths: ReadonlyArray<string>,
  base: string,
  head: string,
  packages: ReadonlyMap<string, Package>,
  tracked: ReadonlySet<string>,
  editedPaths: ReadonlySet<string>,
) => {
  const found = new Map<string, PackageReason>();
  const edits = new Map<string, Array<string>>();
  const scripts: Array<string> = [];

  for (const path of paths) {
    if (touches([path], [...config.shared, ...checks])) {
      if (!editedPaths.has(path) || path.startsWith('scripts/')) return 'root-script';
      if (touches([path], ciFiles)) return 'ci-file';

      return 'fallback-everything';
    }

    if (config.reachesNothing(path)) continue;

    const owner = ownerOf(path, packages);

    if (path === 'pnpm-lock.yaml' || path === 'pnpm-workspace.yaml') {
      const installed = installChanges(path, base, head, packages);
      if (installed === null) return 'lockfile';

      for (const name of installed) found.set(name, 'lockfile');
    } else if (owner !== undefined) {
      edits.set(owner, [...(edits.get(owner) ?? []), path]);
    } else if (
      path.startsWith('scripts/') ||
      path.startsWith('.github/workflows/') ||
      touches([path], config.lintOnly)
    ) {
      // Root scripts CI doesn't run, other workflows and lint rules: the tests that import or name them.
      scripts.push(path);
    } else {
      // Unknown code: the conservative default.
      return 'fallback-everything';
    }
  }

  const alone: TestSelection = new Map();
  if (scripts.length > 0) {
    for (const [file, reason] of reachedFiles([...tracked].filter(ordinaryTest), scripts, head, tracked)) {
      alone.set(file, reason === 'edited' && !editedPaths.has(file) ? 'root-script' : reason);
    }
  }

  // Test-only edits select the tests that run them, not the package.
  for (const [name, edited] of edits) {
    const tests = testsAlone(edited, packages.get(name), head, tracked);
    const fromScript = edited.every((path) => !editedPaths.has(path));
    if (tests === undefined) {
      if (!found.has(name)) found.set(name, fromScript ? 'root-script' : 'package-edit');
    } else {
      for (const file of tests) {
        const reason = fromScript ? 'root-script' : 'imports-changed-module';
        alone.set(file, editedPaths.has(file) ? 'edited' : reason);
      }
    }
  }

  return { found, alone };
};

// ---- Package entry points -----------------------------------------------------------------------

/**
 * A package's entries: each `exports` key, as `./queue`, with the source file its
 * `config.sourceCondition` names, or another of its targets the commit tracks. A key with a `*` is
 * left out, so a specifier under it counts as unknown (and loads everything).
 */
const exportEntries = (owner: Package, tracked: ReadonlySet<string>) => {
  const found = new Map<string, string | undefined>();
  const condition = new RegExp(`"${escaped(config.sourceCondition)}":"([^"]+)"`);

  for (const [key, value] of Object.entries(owner.manifest.exports ?? {})) {
    if (!key.startsWith('.') || key.includes('*')) continue;

    // Each target its conditions name, read from the JSON text, the source condition's first.
    const text = JSON.stringify(value);
    const source = config.sourceCondition === '' ? undefined : condition.exec(text)?.[1];
    const others = [...text.matchAll(/"(\.\/[^"]+)"/g)].map((match) => match[1] ?? '');
    const file = [...(source === undefined ? [] : [source]), ...others]
      .map((target) => posix.join(owner.directory, target))
      .find((path) => tracked.has(path));

    found.set(key, file);
  }

  return found;
};

/**
 * Each entry-scoped package's edits, when every one is a module that no entry names itself, so its
 * dependents follow the entries that run it. A package with an edit to an entry, its manifest, a
 * config or a file that isn't a module keeps its package edge, and so does every package when the
 * lockfile changes.
 */
const entrySeeds = (
  paths: ReadonlyArray<string>,
  packages: ReadonlyMap<string, Package>,
  tracked: ReadonlySet<string>,
) => {
  const seeds = new Map<string, ReadonlySet<string>>();
  if (paths.includes('pnpm-lock.yaml') || paths.includes('pnpm-workspace.yaml')) return seeds;

  for (const name of config.entryScoped) {
    const owner = packages.get(name);
    const edited = paths.filter((path) => ownerOf(path, packages) === name);
    if (owner === undefined || edited.length === 0) continue;

    const named = new Set(exportEntries(owner, tracked).values());
    const modules = edited.every(
      (path) => moduleFile.test(path) && !configFile.test(posix.basename(path)) && !named.has(path),
    );
    if (modules && !edited.every(testOnly)) seeds.set(name, new Set(edited));
  }

  return seeds;
};

/** A package's own modules, without its nested packages', their sources and their importers. */
interface OwnModules {
  readonly owned: ReadonlySet<string>;
  readonly sources: ReadonlyMap<string, string>;
  readonly importers: ReadonlyMap<string, ReadonlyArray<string>>;
}

const ownModules = (
  owner: Package,
  head: string,
  packages: ReadonlyMap<string, Package>,
  tracked: ReadonlySet<string>,
): OwnModules => {
  const sources = contents(
    head,
    [...tracked].filter((path) => path.startsWith(owner.directory) && moduleFile.test(path)),
  );

  return {
    owned: new Set(
      [...sources.keys()].filter((path) => ownerOf(path, packages) === owner.manifest.name),
    ),
    sources,
    importers: importersAmong(sources),
  };
};

/**
 * How a dependent's files reach a package's change: by its specifiers, a string naming a module
 * the change reaches by its path, or a relative import of one. `climbed` is each of the package's
 * modules that runs a changed one, and `keys` the entries that export one of those, or undefined
 * for a package without entries of its own, which any of its specifiers loads. A config counts only
 * by its imports, and makes the whole dependent reached.
 */
const entryReach = (
  dependent: OwnModules,
  target: Package,
  climbed: ReadonlySet<string>,
  keys: ReadonlySet<string> | undefined,
  tracked: ReadonlySet<string>,
) => {
  const exported = exportEntries(target, tracked);
  const { owned, sources, importers } = dependent;
  const runs = (specifier: string) => {
    const key =
      specifier === target.manifest.name
        ? '.'
        : specifier.startsWith(`${target.manifest.name}/`)
          ? `./${specifier.slice(target.manifest.name.length + 1)}`
          : undefined;
    if (key === undefined) return false;

    return keys === undefined || !exported.has(key) || keys.has(key);
  };

  // A string that names a module the change reaches, or a folder holding one, by its path from the
  // root, as a test that reads a library's source from disk does.
  const names = (text: string) => {
    const at = text.indexOf(target.directory);
    if (at === -1) return false;

    const path = text.slice(at).replace(/\/$/, '');

    return [...climbed].some(
      (module) =>
        module === path || module.startsWith(`${path}/`) || module.replace(moduleFile, '') === path,
    );
  };

  const reaches = (path: string) => {
    const source = (sources.get(path) ?? '').replace(typeOnly, '');
    const imports = runtimeImports.flatMap((pattern) =>
      [...source.matchAll(pattern)].map((match) => match[1] ?? ''),
    );
    const loads = (specifier: string) => {
      const file = resolved(path, specifier, tracked);

      return runs(specifier) || (file !== undefined && climbed.has(file));
    };
    // A config names packages and files as bundling options and task inputs too, which load
    // nothing, so only its imports count.
    if (configFile.test(posix.basename(path))) return imports.some(loads);

    return (
      imports.some(loads) ||
      [...source.matchAll(quotedSpecifier)].some((match) => runs(match[1] ?? '')) ||
      [...source.matchAll(quoted)].some((match) => names(match[1] ?? ''))
    );
  };

  const start = [...owned].filter(reaches);
  const whole = start.some((path) => configFile.test(posix.basename(path)));
  const found = new Set<string>();
  const waiting = [...start];

  for (let file = waiting.pop(); file !== undefined; file = waiting.pop()) {
    if (found.has(file)) continue;

    found.add(file);
    waiting.push(...(importers.get(file) ?? []).filter((path) => owned.has(path)));
  }

  return {
    whole,
    tests: [...found].filter(ordinaryTest),
    modules: [...found].filter((path) => !testOnly(path)),
  };
};

/**
 * What a change reaches across packages, following transitive consumers to a fixed point, so
 * cycles end. `changed` names the packages it edits; `seeds` holds the entry-scoped ones whose
 * dependents follow entries. A package reached by a package edge, and each of its dependents, runs
 * whole, as `found`. A dependent of a seeded package runs, in `files`, only its test files that load
 * an entry exporting a changed module, or a module that runs one. When one of its other modules
 * does, its own dependents follow those modules the same way. The near package keeps its package
 * edge, for `nearTests` to narrow, and so does a dependent whose config imports such an entry.
 */
const crossPackage = (
  changed: ReadonlyMap<string, PackageReason>,
  seeds: ReadonlyMap<string, ReadonlySet<string>>,
  head: string,
  packages: ReadonlyMap<string, Package>,
  tracked: ReadonlySet<string>,
) => {
  const found = new Map(changed);
  const spreading = new Map([...changed].filter(([name]) => !seeds.has(name)));
  const followed = new Map([...seeds].map(([name, modules]) => [name, new Set(modules)]));
  const files: TestSelection = new Map();
  const dependentReason = (reason: PackageReason | undefined) =>
    reason === 'lockfile' || reason === 'root-script' ? reason : 'dependent-package';
  const { graph, tests } = packageGraph(head, packages);
  const read = new Map<string, OwnModules>();
  const modulesOf = (owner: Package) => {
    const each = read.get(owner.directory) ?? ownModules(owner, head, packages, tracked);
    read.set(owner.directory, each);

    return each;
  };

  const sizes = () => [
    found.size,
    spreading.size,
    files.size,
    ...[...followed.values()].map((modules) => modules.size),
  ];

  for (let before = [-1]; !isDeepStrictEqual(before, sizes()); ) {
    before = sizes();

    for (const [name, reached] of graph) {
      if (spreading.has(name)) continue;
      const dependency = [...reached].find((target) => spreading.has(target));
      if (dependency === undefined) continue;

      const reason = dependentReason(spreading.get(dependency));
      if (!found.has(name)) found.set(name, reason);
      spreading.set(name, reason);
    }

    for (const [name, modules] of followed) {
      const owner = packages.get(name);
      if (owner === undefined || spreading.has(name)) continue;

      const { importers } = modulesOf(owner);
      const climbed = new Set<string>();
      const waiting = [...modules];

      for (let file = waiting.pop(); file !== undefined; file = waiting.pop()) {
        if (climbed.has(file)) continue;

        climbed.add(file);
        waiting.push(...(importers.get(file) ?? []));
      }

      // A package with no entries of its own is one entry, which any of its specifiers loads.
      const keys = config.entryScoped.includes(name)
        ? new Set(
            [...exportEntries(owner, tracked)].flatMap(([key, file]) =>
              file !== undefined && climbed.has(file) ? [key] : [],
            ),
          )
        : undefined;

      for (const [dependentName, reached] of graph) {
        const dependent = packages.get(dependentName);
        const mentions = reached.has(name) || tests.get(dependentName)?.has(name) === true;
        if (dependent === undefined || dependentName === name || !mentions) continue;

        if (spreading.has(dependentName)) continue;

        const reach =
          dependent.directory === config.near.root
            ? undefined
            : entryReach(modulesOf(dependent), owner, climbed, keys, tracked);

        const reason = dependentReason(found.get(name));
        if (reach === undefined || reach.whole) {
          if (!found.has(dependentName)) found.set(dependentName, reason);
          spreading.set(dependentName, reason);
          continue;
        }

        for (const file of reach.tests) {
          files.set(file, reason === 'root-script' ? reason : 'package-entry');
        }

        if (reach.modules.length > 0) {
          followed.set(
            dependentName,
            new Set([...(followed.get(dependentName) ?? []), ...reach.modules]),
          );
        }
      }
    }
  }

  // A test file another package's test-only mention runs, runs alone too.
  for (const [owner, running] of tests) {
    if (found.has(owner)) continue;

    for (const [target, each] of running) {
      const reason = spreading.get(target);
      if (reason === undefined) continue;

      for (const file of each) {
        files.set(file, dependentReason(reason));
      }
    }
  }

  return { found, files };
};

/** Changed packages and their transitive dependents, by directory, with test files that run alone. */
const affectedPackages = (
  changed: ReadonlyMap<string, PackageReason>,
  seeds: ReadonlyMap<string, ReadonlySet<string>>,
  head: string,
  packages: ReadonlyMap<string, Package>,
  tracked: ReadonlySet<string>,
) => {
  const { found, files } = crossPackage(changed, seeds, head, packages, tracked);
  const directories = [...found].map(([name, reason]) => [packages.get(name)?.directory ?? '', reason] as const);
  const alone = [...files].filter(([file]) => !directories.some(([path]) => file.startsWith(path)));

  return new Map<string, SelectionReason>([...directories, ...alone]);
};

// ---- Root scripts -------------------------------------------------------------------------------

/**
 * The root manifest's tools that name `script`, each as a step runs it, `pnpm run <name>`, or
 * undefined when anything else in the manifest names it: another script, any other field, or a
 * manifest that isn't JSON.
 */
const manifestToolsRunning = (script: string, head: string) => {
  let manifest: { readonly scripts?: Readonly<Record<string, string>> };

  try {
    manifest = JSON.parse(fileAt(head, rootManifest) ?? '') as typeof manifest;
  } catch {
    return undefined;
  }

  const all = Object.entries(manifest.scripts ?? {});
  const others = all.filter(([name]) => !config.manifestTools.includes(name));

  if (JSON.stringify({ ...manifest, scripts: Object.fromEntries(others) }).includes(script)) {
    return undefined;
  }

  return all.flatMap(([name, command]) =>
    String(command).includes(script) ? [`pnpm run ${name}`] : [],
  );
};

/**
 * Root scripts are classified by their callers, through other root scripts too:
 *
 * - used only by tests: those tests run (`changedPackages` finds them);
 * - used by production code: each consumer counts as an edit, so its package runs as usual;
 * - named by the root manifest outside its tools (install scripts): everything;
 * - with `near`, run by one CI step as a tool, or named by the manifest only in its tools: the
 *   jobs that run it, returned in `tools` for `stepJobs`;
 * - deciding selection or execution (`runScripts`): everything, since `ciWorkflow` becomes a
 *   consumer, which is one of the checks.
 *
 * Unknown scripts fail toward everything.
 */
const scriptConsumers = (
  paths: ReadonlyArray<string>,
  head: string,
  tracked: ReadonlySet<string>,
  near: boolean,
) => {
  const tools = new Set<string>();
  const waiting = paths.filter((path) => path.startsWith('scripts/'));
  if (waiting.length === 0 || touches(paths, [...config.shared, ...checks])) return { paths, tools: [] };

  const files = [...tracked].filter(
    (path) =>
      !testOnly(path) &&
      !config.wholeRun.includes(path) &&
      !config.reachesNothing(path) &&
      (/\.(?:[cm]?[jt]sx?|sh|bash|py|pl|rs|toml)$/.test(path) ||
        configFile.test(posix.basename(path)) ||
        touches([path], checks)),
  );
  const found = new Set(paths);

  for (let script = waiting.pop(); script !== undefined; script = waiting.pop()) {
    for (const file of reachedFiles(files, [script], head, tracked).keys()) {
      if (file === config.ciWorkflow && near && touches([script], config.stepTools)) {
        tools.add(script);
        continue;
      }

      const running =
        file === rootManifest && near ? manifestToolsRunning(script, head) : undefined;

      if (running !== undefined) {
        for (const each of running) tools.add(each);
        continue;
      }

      if (
        file === config.ciWorkflow &&
        !touches([script], [...config.runScripts, ...config.stepTools])
      ) {
        console.error(
          `ci: ${config.ciWorkflow} names ${script}, which neither runScripts nor stepTools lists, so the change runs everything`,
        );
      }

      if (found.has(file)) continue;

      found.add(file);

      if (file.startsWith('scripts/') && !testOnly(file)) waiting.push(file);
    }
  }

  return { paths: [...found], tools: [...tools].sort() };
};

// ---- Own-job tests ------------------------------------------------------------------------------

/**
 * The `ownJob` test files a change reaches. Each boots a real container or a proof and costs
 * minutes, so a pull request (`near`) runs one only when the change edits it, when one of its own
 * runtime imports, dynamic imports or `new URL('…', import.meta.url)` file references names an
 * edited file or folder, or when `ownJobCovers` says it covers an edited path. Type-only imports
 * don't count, and neither does reach through other modules or workspace packages: a shared
 * module's edit would otherwise select every such file. Without `near`, as on the sweep, the
 * accumulated diff reaches further: every own-job file in a reached package runs too, and all of
 * them when everything is selected.
 */
const ownJobTests = (
  edited: ReadonlyArray<string>,
  sources: ReadonlyMap<string, string>,
  near: boolean,
  packages: ReadonlyMap<string, SelectionReason>,
  fallback: SelectionReason | undefined,
) => {
  if (!near && fallback !== undefined) return null;

  const changed = new Set(edited);
  const hits = (target: string) =>
    changed.has(target) ||
    ['.ts', '.tsx', '/index.ts'].some((suffix) => changed.has(`${target}${suffix}`)) ||
    changed.has(target.replace(/\.js$/, '.ts')) ||
    edited.some((path) => path.startsWith(target.endsWith('/') ? target : `${target}/`));
  const reaches = (file: string, source: string) =>
    runtimeImports.some((pattern) =>
      [...source.matchAll(pattern)].some((match) => {
        const specifier = match[1] ?? '';
        if (!specifier.startsWith('.')) return false;

        // A folder's specifier keeps its trailing `/`, which `hits` reads as any file under it.
        return hits(posix.normalize(posix.join(posix.dirname(file), specifier)));
      }),
    );

  const found: TestSelection = new Map();
  const directories = [...packages].filter(([path]) => path.endsWith('/'));
  for (const [file, source] of sources) {
    if (changed.has(file)) found.set(file, 'edited');
    else if (touches(edited, config.ownJobCovers.get(file) ?? [])) found.set(file, 'coverage-declaration');
    else if (reaches(file, source)) found.set(file, 'imports-changed-module');
    else if (!near) {
      const reason = directories.find(([path]) => file.startsWith(path))?.[1];
      if (reason !== undefined) found.set(file, reason);
    }
  }

  return found;
};

// ---- Near selection -----------------------------------------------------------------------------

/**
 * Each near-package module a change reaches through the package's own modules: each it changes,
 * and each that runs one of those, again and again. It climbs past no module only tests run (whose
 * helpers start the whole app), nor past one more than `config.near.sharedImporters` modules run,
 * whose own tests still run.
 */
const nearImporters = (paths: ReadonlyArray<string>, head: string) => {
  const importers = importersOf(config.near.root, head);
  const found = new Set<string>();
  const waiting = paths.filter((path) => path.startsWith(config.near.root) && !testOnly(path));

  for (let file = waiting.pop(); file !== undefined; file = waiting.pop()) {
    if (found.has(file)) continue;

    const runners = [...new Set(importers.get(file))].filter((path) => !testOnly(path));

    found.add(file);

    if (runners.length <= config.near.sharedImporters) waiting.push(...runners);
  }

  return found;
};

/**
 * The near package's ordinary test files near a change, for a pull request: each it changes, each
 * whose own imports reach it through the package's modules, as `nearImporters` climbs them, and
 * each named for one of those modules in the same folder (`queue.test.ts` and
 * `queue-searches.test.ts` for `queue.ts`).
 *
 * A deliberate risk trade: every test boots the whole app, so any change can reach any of them, and
 * near can't prove otherwise. Main's sweeps are the safety net. In one sample, every test that found
 * something on a PR ran a changed file itself; then an edit broke the tests of two modules that ran
 * it one level up, which is why the climb exists. Widening the rule added 64% to the package's test
 * seconds on a replay of 84 changes, and some earlier "savings" had been missed coverage.
 */
const nearTests = (
  paths: ReadonlyArray<string>,
  head: string,
  tracked: ReadonlySet<string>,
  edited: ReadonlySet<string>,
) => {
  const tests = [...tracked]
    .filter((path) => path.startsWith(config.near.root) && ordinaryTest(path))
    .sort();
  const climbed = nearImporters(paths, head);
  const reached = reachedFiles(tests, [...paths, ...climbed], head, tracked);
  const sources = [...paths, ...climbed].flatMap((path) =>
    path.startsWith(config.near.root) && !testFile.test(path) && /\.tsx?$/.test(path)
      ? [path.replace(/\.tsx?$/, '')]
      : [],
  );

  const found: TestSelection = new Map();
  for (const file of tests) {
    const name = file.replace(testFile, '');
    const reason = reached.get(file);
    if (reason !== undefined) {
      found.set(file, reason === 'edited' && !edited.has(file) ? 'root-script' : reason);
    } else if (sources.some((source) => name === source || name.startsWith(`${source}-`))) {
      found.set(file, 'named-for-changed-module');
    }
  }

  return found;
};

/** The tests in `config.nearCovers` whose covered paths the change touches. */
const nearCoverTests = (paths: ReadonlyArray<string>, tracked: ReadonlySet<string>) => {
  const read = paths.filter((path) => !path.endsWith('.md'));
  const code = read.filter((path) => !testOnly(path));

  return [...config.nearCovers].flatMap(([test, covered]) =>
    tracked.has(test) && touches(config.nearCoversReadTests.has(test) ? read : code, covered)
      ? [test]
      : [],
  );
};

// ---- Covered-only tests -------------------------------------------------------------------------

/** The covered-only test files under `folder`, a folder ending in `/` or one file. */
const coveredTests = (folder: string, tracked: ReadonlySet<string>) =>
  [...tracked].filter(
    (path) => (path === folder || (folder.endsWith('/') && path.startsWith(folder))) && testFile.test(path),
  );

/**
 * The covered-only tests whose code the change covers, by path, wherever they are: an import or a
 * name may lead to none of them, as for a model check or an oracle that reads its code from disk.
 */
const coveredTestFiles = (paths: ReadonlyArray<string>, tracked: ReadonlySet<string>) =>
  [...config.coveredOnly].flatMap(([folder, covered]) =>
    touches(paths, covered) ? coveredTests(folder, tracked) : [],
  );

/**
 * The covered-only tests whose code the change doesn't cover, which a pull request leaves out. A
 * test with an entry of its own inside a folder that has one runs when either entry covers it.
 */
const uncoveredTests = (paths: ReadonlyArray<string>, tracked: ReadonlySet<string>) => {
  const covered = new Set(coveredTestFiles(paths, tracked));

  return [
    ...new Set(
      [...config.coveredOnly].flatMap(([folder, listed]) =>
        touches(paths, listed) ? [] : coveredTests(folder, tracked),
      ),
    ),
  ].filter((file) => !covered.has(file));
};

/**
 * `whole`, with each package that holds covered-only tests the change doesn't cover given as its
 * other ordinary test files instead.
 */
const withoutUncovered = (
  whole: ReadonlyMap<string, SelectionReason>,
  skipped: ReadonlyArray<string>,
  packages: ReadonlyMap<string, Package>,
  tracked: ReadonlySet<string>,
) => {
  const directoryOf = (path: string) => packages.get(ownerOf(path, packages) ?? '')?.directory;

  return new Map([...whole].flatMap(([directory, reason]) =>
    skipped.some((file) => directoryOf(file) === directory)
      ? [...tracked]
          .filter(
            (path) =>
              ordinaryTest(path) && !skipped.includes(path) && directoryOf(path) === directory,
          )
          .sort()
          .map((file) => [file, reason] as const)
      : [[directory, reason] as const],
  ));
};

// ---- CI files, diffed as YAML -------------------------------------------------------------------

/** A step of a job or a composite action, as far as the planner reads it. */
interface Step {
  readonly uses?: string;
  readonly with?: Readonly<Record<string, string>>;
}

/** A workflow's job, as far as the planner reads it. */
interface Job {
  readonly name?: string;
  readonly needs?: string | ReadonlyArray<string>;
  readonly uses?: string;
  readonly steps?: ReadonlyArray<Step>;
}

interface Workflow {
  readonly jobs: Readonly<Record<string, Job>>;
}

interface Action {
  readonly runs?: { readonly steps?: ReadonlyArray<Step> };
}

/**
 * The YAML parser: the `yaml` package from `PLAN_YAML`, where CI's plan (which installs nothing)
 * unpacks it after checking the tarball against the lockfile's integrity, or else from the
 * workspace's install. Undefined when neither loads, and then a CI edit runs everything.
 */
const loadYaml = async () => {
  const path = env['PLAN_YAML'];

  try {
    const loaded = (
      // A computed specifier: `yaml` is optional, so its types needn't be installed.
      await import(path === undefined || path === '' ? 'yaml' : pathToFileURL(path).href)
    ) as { parse: (text: string, options?: object) => unknown };

    return loaded.parse;
  } catch {
    return undefined;
  }
};

type Parse = NonNullable<Awaited<ReturnType<typeof loadYaml>>>;

/** A YAML file at a commit, parsed, or undefined when the commit has no such file. Throws on bad YAML. */
const parsedAt = <File>(parse: Parse, commit: string, path: string) => {
  const text = fileAt(commit, path);

  return text === undefined ? undefined : { value: parse(text, { logLevel: 'error' }) as File };
};

/** A workflow's jobs by ID, and the rest of it. Throws when the commit has none, or it isn't one. */
const workflowAt = (parse: Parse, commit: string, path: string) => {
  const parsed = parsedAt<Workflow>(parse, commit, path);
  if (parsed === undefined) throw new Error(`no ${path} at ${commit}`);

  const { jobs, ...top } = parsed.value;

  return { top, jobs: new Map(Object.entries(jobs)) };
};

/** The repo's own actions and workflows a job or an action's steps use, by path from the root. */
const localUses = (uses: ReadonlyArray<string | undefined>) =>
  uses.flatMap((each) =>
    each?.startsWith('./') === true
      ? [posix.normalize(each.slice(2)).replace(/\/(action\.ya?ml)?$/, '')]
      : [],
  );

const jobUses = (job: Job) => localUses([job.uses, ...(job.steps ?? []).map((step) => step.uses)]);

/**
 * The jobs each job waits for, by ID: those its `needs` names, and those a step names in its
 * `jobs` input, as the `wait-for-jobs` action takes them. A step names a job by its name in the run,
 * or a called workflow's job by that name and ` / `.
 */
const waits = (jobs: ReadonlyMap<string, Job>) => {
  const names = [...jobs].map(
    ([id, { name }]) => [id, name !== undefined && !name.includes('${{') ? name : id] as const,
  );

  return new Map(
    [...jobs].map(([id, job]) => {
      const listed = (job.steps ?? []).flatMap(
        (step) => step.with?.['jobs']?.split('\n').map((line) => line.trim()) ?? [],
      );
      const waited = names.flatMap(([other, name]) =>
        listed.some((line) => line === name || line.includes(`${name} / `)) ? [other] : [],
      );

      return [id, [...[job.needs ?? []].flat(), ...waited]] as const;
    }),
  );
};

/**
 * The repo's actions a change changes, by directory, with every action that uses one: an
 * `action.yml` whose parse differs, one added or deleted, and any other file of an action.
 */
const changedActions = (parse: Parse, paths: ReadonlyArray<string>, base: string, head: string) => {
  const found = new Set<string>();

  for (const path of paths) {
    const [, name = '', file = ''] = /^\.github\/actions\/([^/]+)\/(.*)$/.exec(path) ?? [];
    if (name === '') throw new Error(`${path} is in no action's directory`);

    const directory = `.github/actions/${name}`;

    if (!/^action\.ya?ml$/.test(file)) {
      found.add(directory);
    } else {
      const [before, after] = [base, head].map((commit) => parsedAt<Action>(parse, commit, path));
      if (!isDeepStrictEqual(before, after)) found.add(directory);
    }
  }

  // An action another one uses changes that one too.
  const uses = [base, head].flatMap((commit) =>
    git('ls-tree', '-r', '--name-only', '-z', commit, '--', '.github/actions/')
      .split('\0')
      .filter((path) => /^\.github\/actions\/[^/]+\/action\.ya?ml$/.test(path))
      .map((path) => {
        const steps = parsedAt<Action>(parse, commit, path)?.value.runs?.steps ?? [];

        return { directory: posix.dirname(path), uses: localUses(steps.map((step) => step.uses)) };
      }),
  );

  for (let grew = true; grew; ) {
    grew = false;

    for (const { directory, uses: used } of uses) {
      if (!found.has(directory) && used.some((each) => found.has(each))) {
        found.add(directory);
        grew = true;
      }
    }
  }

  return found;
};

/** Every job `start` reaches through `edges`, `start` among them. */
const closure = (start: Iterable<string>, edges: ReadonlyMap<string, ReadonlyArray<string>>) => {
  const found = new Set(start);
  const waiting = [...found];

  for (let next = waiting.pop(); next !== undefined; next = waiting.pop()) {
    for (const reached of edges.get(next) ?? []) {
      if (found.has(reached)) continue;

      found.add(reached);
      waiting.push(reached);
    }
  }

  return found;
};

/**
 * The jobs `changed` runs: `jobs` as if the change reached them (`changed` and each that waits for
 * one, through others too, since its input changed), and `needs` as on any run (what those wait
 * for). `sides` are the workflow's jobs at each commit, so a renamed or dropped wait still counts.
 * Null for everything, when one is a job the plan doesn't know.
 */
const waitingJobs = (changed: ReadonlySet<string>, sides: ReadonlyArray<ReadonlyMap<string, Job>>) => {
  const edges = new Map<string, Array<string>>();
  const dependents = new Map<string, Array<string>>();

  for (const side of sides) {
    for (const [id, waited] of waits(side)) {
      for (const other of waited) {
        edges.set(id, [...(edges.get(id) ?? []), other]);
        dependents.set(other, [...(dependents.get(other) ?? []), id]);
      }
    }
  }

  const jobs = [...closure(changed, dependents)].filter((id) => !config.decidingJobs.has(id));
  const needs = [...closure(jobs, edges)].filter(
    (id) => !config.decidingJobs.has(id) && !jobs.includes(id),
  );
  if ([...jobs, ...needs].some((id) => !config.plannedJobs.has(id))) return null;

  return { jobs: jobs.sort(), needs: needs.sort() };
};

/**
 * The CI jobs a pull request's change to CI's own files runs, by parsing both revisions as YAML,
 * so comments and formatting change nothing. A changed job runs itself and everything that waits on
 * it (`needs` or the wait action); a changed action runs its callers. Null for everything: a change
 * to the plan, the result or the workflow's top level, a job the plan doesn't know, or a file the
 * parser can't read. Example: a comment-only workflow edit runs only static, lint and the CI rule
 * tests. Before this rule, 47 of 278 PR runs in three days ran everything for a CI file alone.
 */
const ciJobs = async (paths: ReadonlyArray<string>, base: string, head: string) => {
  const parse = await loadYaml();

  if (parse === undefined) {
    console.error("ci: no YAML parser, so the change to CI's files runs everything");

    return null;
  }

  try {
    const before = workflowAt(parse, base, config.ciWorkflow);
    const after = workflowAt(parse, head, config.ciWorkflow);
    if (!isDeepStrictEqual(before.top, after.top)) return null;

    const ids = new Set([...before.jobs.keys(), ...after.jobs.keys()]);
    const changed = new Set(
      [...ids].filter((id) => !isDeepStrictEqual(before.jobs.get(id), after.jobs.get(id))),
    );
    const workflows = changed.size > 0 ? [config.ciWorkflow] : [];
    const actions = changedActions(
      parse,
      paths.filter((path) => path.startsWith('.github/actions/')),
      base,
      head,
    );

    // A called workflow changes its callers, when its parse changes or it uses a changed action.
    for (const called of config.calledWorkflows) {
      const calledBefore = workflowAt(parse, base, called);
      const calledAfter = workflowAt(parse, head, called);
      if (!isDeepStrictEqual(calledBefore, calledAfter)) workflows.push(called);

      const calling = [calledBefore, calledAfter].some((side) =>
        [...side.jobs.values()].some((job) => jobUses(job).some((used) => actions.has(used))),
      );
      if (workflows.includes(called) || calling) actions.add(called);
    }

    for (const side of [before, after]) {
      for (const [id, job] of side.jobs) {
        if (jobUses(job).some((used) => actions.has(used))) changed.add(id);
      }
    }

    if ([...changed].some((id) => config.decidingJobs.has(id))) return null;

    const reached = waitingJobs(changed, [before.jobs, after.jobs]);

    return reached === null ? null : { ...reached, workflows };
  } catch (error) {
    console.error(`ci: CI's files couldn't be read, so the change runs everything: ${String(error)}`);

    return null;
  }
};

/**
 * The CI jobs a pull request's change to a step's tool runs: each job a step of which names one of
 * `tools`, and those `waitingJobs` adds. Null for everything: a tool the plan runs, a job the plan
 * doesn't know, or a file the parser can't read.
 */
const stepJobs = async (tools: ReadonlyArray<string>, head: string) => {
  const parse = await loadYaml();

  if (parse === undefined) {
    console.error("ci: no YAML parser, so the change to a step's tool runs everything");

    return null;
  }

  try {
    const { jobs } = workflowAt(parse, head, config.ciWorkflow);
    // A tool counts where no more of a name follows it, so `pnpm run check` isn't `check:types`.
    const runs = (text: string, tool: string) =>
      text
        .split(tool)
        .slice(1)
        .some((after) => !/^[\w:-]/.test(after));
    const running = new Set(
      [...jobs].flatMap(([id, job]) =>
        tools.some((tool) => runs(JSON.stringify(job), tool)) ? [id] : [],
      ),
    );
    if (running.has('plan')) return null;

    return waitingJobs(running, [jobs]);
  } catch (error) {
    console.error(`ci: ${config.ciWorkflow} couldn't be read, so the change runs everything: ${String(error)}`);

    return null;
  }
};

// ---- The selection ------------------------------------------------------------------------------

const select = async (base: string, head: string, near: boolean) => {
  const commit = git('rev-parse', '--verify', `${head}^{commit}`).trim();
  // Count a moved file at its previous path too. NUL separators keep unusual file names intact.
  const edited = git('diff', '--name-only', '-z', '--no-renames', `${base}...${commit}`)
    .split('\0')
    .filter((path) => path !== '');
  const from = git('merge-base', base, commit).trim();
  const packages = manifests(commit);
  const tracked = new Set(git('ls-tree', '-r', '--name-only', '-z', commit).split('\0'));

  // With --near, a change to CI's own files runs the jobs it changes and selects nothing else.
  const ci = near && touches(edited, ciFiles) ? await ciJobs(edited, from, commit) : undefined;
  const handled = ci ? edited.filter((path) => touches([path], ciFiles)) : [];
  const consumers = scriptConsumers(
    edited.filter((path) => !handled.includes(path)),
    commit,
    tracked,
    near,
  );
  const tools = consumers.tools.length > 0 ? await stepJobs(consumers.tools, commit) : undefined;
  const paths = tools === null ? [...consumers.paths, config.ciWorkflow] : consumers.paths;
  const jobs = [...new Set([...(ci?.jobs ?? []), ...(tools?.jobs ?? [])])].sort();
  const needs = [...new Set([...(ci?.needs ?? []), ...(tools?.needs ?? [])])]
    .filter((id) => !jobs.includes(id))
    .sort();

  const editedPaths = new Set(edited);
  const changed = changedPackages(paths, from, commit, packages, tracked, editedPaths);
  const fallback = typeof changed === 'string' ? changed : undefined;
  const seeds = near ? entrySeeds(paths, packages, tracked) : new Map<string, ReadonlySet<string>>();
  const reached =
    typeof changed === 'string'
      ? new Map<string, SelectionReason>()
      : affectedPackages(
          changed.found,
          new Map([...seeds].filter(([name]) => changed.found.has(name))),
          commit,
          packages,
          tracked,
        );

  // With --near, the tests near the change stand in for the whole near package.
  const nearOn = near && config.near.root !== '';
  const narrow = nearOn && reached.delete(config.near.root);
  const nearby = narrow ? nearTests(paths, commit, tracked, editedPaths) : new Map<string, SelectionReason>();
  if (nearOn && fallback === undefined) {
    for (const file of nearCoverTests(paths, tracked)) nearby.set(file, 'coverage-declaration');
  }

  // With --near, a covered-only test runs only when the change covers it.
  const uncovered = near ? uncoveredTests(paths, tracked) : [];
  const whole = near ? withoutUncovered(reached, uncovered, packages, tracked) : reached;
  const covered = new Set(near ? coveredTestFiles(paths, tracked) : []);
  const ordinaryFiles = [...tracked].filter(ordinaryTest);

  // The tests that read a workflow whose parse the change changes, and the rule tests for any edit.
  const workflowTests =
    fallback === undefined && ci
      ? [
          ...reachedFiles(ordinaryFiles, ci.workflows, commit, tracked).keys(),
          ...(touches(handled, [config.ciWorkflow, ...config.calledWorkflows])
            ? config.workflowRuleTests.filter((path) => tracked.has(path))
            : []),
        ]
      : [];

  const alone = new Map(typeof changed === 'string' ? [] : changed.alone);
  for (const file of workflowTests) alone.set(file, 'ci-file');
  for (const file of covered) alone.set(file, 'coverage-declaration');

  // A test file a reached package holds runs with it, not alone too.
  const scope = [...whole.keys()];
  const skipped = new Set(uncovered);
  const selected =
    fallback !== undefined
      ? null
      : [
          ...new Set([
            ...scope,
            ...nearby.keys(),
            ...[...alone.keys()].filter((file) => !scope.some((path) => file.startsWith(path))),
          ]),
        ]
          .filter((file) => !skipped.has(file))
          .sort();

  // The workflow runs all ordinary tests when a CI or step-tool edit selects the test job.
  const jobReason = ci?.jobs.includes('tests') ? 'ci-file' : tools?.jobs.includes('tests') ? 'root-script' : undefined;
  const testSelection: TestSelection = new Map();
  const directories = [...whole].filter(([path]) => path.endsWith('/'));
  const selectedPaths = new Set(selected);
  for (const file of ordinaryFiles) {
    if (skipped.has(file)) continue;

    const reason = jobReason ?? fallback ?? directories.find(([path]) => file.startsWith(path))?.[1] ??
      (selectedPaths.has(file) ? whole.get(file) ?? nearby.get(file) ?? alone.get(file) : undefined);
    if (reason !== undefined) testSelection.set(file, covered.has(file) ? 'coverage-declaration' : reason);
  }

  // The own-job files, by their own rule, from the files the diff names.
  const ownJobFiles = [...tracked].filter((path) => config.ownJob(path));
  const ownJobs = ownJobTests(edited, contents(commit, ownJobFiles), near, reached, fallback);
  for (const file of ownJobFiles) {
    const reason = ownJobs === null ? fallback : ownJobs.get(file);
    if (reason !== undefined) testSelection.set(file, reason);
  }
  const orderedSelection = Object.fromEntries([...testSelection].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));

  // TODO(your repo): add outputs for jobs your plan gates on paths, e.g. `pack=` when packed inputs
  // change, `rust=` when the Rust crate's real inputs change. Keep each rule's reason beside it.
  console.log(`packages=${JSON.stringify(selected ?? null)}`);
  console.log(`uncovered=${JSON.stringify(uncovered)}`);
  console.log(`ci_jobs=${JSON.stringify(jobs)}`);
  console.log(`ci_needs=${JSON.stringify(needs)}`);
  console.log(`own_jobs=${JSON.stringify(ownJobs === null ? null : [...ownJobs.keys()].sort())}`);
  console.log(`test_selection=${JSON.stringify(orderedSelection)}`);
};

const near = argv[2] === '--near';

const [first, second, ...rest] = argv.slice(near ? 3 : 2);

if (first !== undefined && !first.startsWith('--') && rest.length === 0) {
  await select(first, second ?? 'HEAD', near);
} else {
  console.error(usage);
  exit(2);
}
