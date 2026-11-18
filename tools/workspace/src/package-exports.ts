/**
 * Fails when a workspace package's `exports` names a file nothing has or builds, or a generated
 * file, or reaches a built file where the workspace should read source.
 *
 *     node tools/workspace/src/bin.ts package-exports [--packages <glob>]... [--condition <name>]
 *
 * It reads the `package.json` in each folder `--packages` matches, `packages/*` unless it's given,
 * its `publishConfig.exports` too, and the build each package's pack config declares, and holds
 * each to these:
 *
 * - It has an `exports` field, so no other package reaches a file it doesn't list. One nothing
 *   imports, such as a CLI's, is empty.
 * - Each target, condition by condition, names a tracked file, or a `dist/` file one of its pack
 *   entries builds: `dist/<entry>.mjs`, and `dist/<entry>.d.mts` when it packs types. A `*`
 *   target matches at least one tracked file. Built targets needn't be tracked.
 * - No target names a `*.gen.ts` file, which a tool writes and git ignores.
 * - A package that packs builds each entry point that has a `types` condition from a pack entry.
 * - Each entry point in `exports` with a `types` or `import` target gives its source, a tracked
 *   file, under the source condition first (`--condition`, `workspace-source` unless it's given),
 *   so the workspace reads source and only the published package reads what's built.
 *   `publishConfig.exports`, what the published package exports, names no source.
 *
 * Runs: in CI's static job, and in the repo's `check:static`.
 * Configure: `packageExports` in `workspace-tools.json`: the package folders, the condition, and
 * where each package declares its build. The default reads `vite.config.ts`'s `pack` (Vite+'s
 * tsdown settings); `packConfig: "tsdown.config.ts"` with `packKey: "."` reads tsdown's own. For
 * another bundler, call `problems()` with each package's `pack` filled from its config: only
 * `entry` and `dts` are read.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

/** An entry point's target: a path, or a path for each condition. */
type Target = string | Readonly<Record<string, string>>;

type Exports = Readonly<Record<string, Target>>;

interface Manifest {
  readonly name: string;
  readonly exports?: Exports;
  readonly publishConfig?: { readonly exports?: Exports };
}

/** What the check reads of one build: its entries, and whether it packs types. */
export interface PackBuild {
  readonly entry: ReadonlyArray<string> | Readonly<Record<string, string>>;
  readonly dts?: boolean | object;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPaths = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isPath = (value: unknown): value is string => typeof value === 'string';

const isTarget = (value: unknown): value is Target =>
  isPath(value) || (isRecord(value) && Object.values(value).every(isPath));

const isExports = (value: unknown): value is Exports => isRecord(value) && Object.values(value).every(isTarget);

const isBuild = (value: unknown): value is PackBuild =>
  isRecord(value) &&
  (isPaths(value['entry']) || (isRecord(value['entry']) && Object.values(value['entry']).every(isPath))) &&
  (value['dts'] === undefined || typeof value['dts'] === 'boolean' || isRecord(value['dts']));

/** A `package.json`, as far as the check reads it, or an error naming what's off. */
const decodeManifest = (at: string, text: string): Manifest => {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !isPath(value['name'])) throw new Error(`${at}: has no name`);

  const { exports, publishConfig } = value;
  if (exports !== undefined && !isExports(exports)) throw new Error(`${at}: exports isn't a map of paths`);

  const published = isRecord(publishConfig) ? publishConfig['exports'] : undefined;
  if (published !== undefined && !isExports(published)) throw new Error(`${at}: publishConfig.exports isn't a map of paths`);

  return {
    name: value['name'],
    ...(exports === undefined ? {} : { exports }),
    ...(published === undefined ? {} : { publishConfig: { exports: published } }),
  };
};

/** A workspace package as the check reads it. */
export interface Package {
  /** Its folder from the root, such as `packages/example`. */
  readonly directory: string;
  readonly manifest: Manifest;
  /** The builds its pack config declares; empty when it packs nothing. */
  readonly pack: ReadonlyArray<PackBuild>;
}

/** The folder every path in `paths` is in, as `vp pack` names entries below it. */
const commonFolder = (paths: ReadonlyArray<string>) => {
  const [first = [], ...rest] = paths.map((path) => posix.dirname(path).split('/'));
  let length = first.length;

  for (const parts of rest) {
    while (length > 0 && parts.slice(0, length).join('/') !== first.slice(0, length).join('/')) {
      length -= 1;
    }
  }

  return first.slice(0, length).join('/');
};

/** Each pack entry's output name: the object's key, or its path below the entries' folder. */
const entryNames = ({ entry }: PackBuild): ReadonlyArray<string> => {
  if (!isPaths(entry)) return Object.keys(entry);

  const folder = commonFolder(entry);

  return entry.map((path) => posix.relative(folder, path).replace(/\.[cm]?[jt]sx?$/, ''));
};

/** The `dist/` files a package's pack builds, by path from the package's folder. */
export const builtFiles = (pack: ReadonlyArray<PackBuild>): ReadonlySet<string> =>
  new Set(
    pack.flatMap((build) =>
      entryNames(build).flatMap((name) =>
        build.dts === undefined || build.dts === false
          ? [`dist/${name}.mjs`]
          : [`dist/${name}.mjs`, `dist/${name}.d.mts`],
      ),
    ),
  );

/** Each `[condition, path]` of a target; a plain path has no condition. */
const paths = (target: Target): ReadonlyArray<readonly [string | undefined, string]> =>
  isPath(target) ? [[undefined, target]] : Object.entries(target);

/** Whether `pattern`, a target with at most one `*`, matches any of `files`. */
const matches = (pattern: string, files: ReadonlySet<string>) => {
  if (!pattern.includes('*')) return files.has(pattern);

  const [before = '', after = ''] = pattern.split('*');

  return [...files].some(
    (file) =>
      file.length > before.length + after.length && file.startsWith(before) && file.endsWith(after),
  );
};

/** The source condition `problems` asks for unless it's given another. */
export const defaultCondition = 'workspace-source';

/**
 * What each package's exports break, one line each, with what to do about it. `condition` is the
 * condition each entry point names its source under.
 */
export const problems = (
  packages: ReadonlyArray<Package>,
  tracked: ReadonlySet<string>,
  condition = defaultCondition,
): ReadonlyArray<string> => {
  const found: Array<string> = [];

  for (const { directory, manifest, pack } of packages) {
    const at = `${directory}/package.json`;
    const built = new Set([...builtFiles(pack)].map((path) => `${directory}/${path}`));
    const files = new Set([...tracked, ...built]);

    if (manifest.exports === undefined) {
      found.push(
        `${at}: has no exports, so any of its files can be imported. List its entry points, or write "exports": {} if nothing imports it.`,
      );
      continue;
    }

    const maps = [
      ['exports', manifest.exports],
      ['publishConfig.exports', manifest.publishConfig?.exports ?? {}],
    ] as const;

    for (const [field, exports] of maps) {
      for (const [entry, target] of Object.entries(exports)) {
        const name = `${field}["${entry}"]`;

        for (const [named, path] of paths(target)) {
          const where = named === undefined ? name : `${name}["${named}"]`;
          const file = posix.join(directory, path);

          if (/\.gen\.ts$/.test(path)) {
            found.push(
              `${at}: ${where} names ${path}, which a tool writes. Export the module that uses it instead.`,
            );
            continue;
          }

          // The source condition names source, which the workspace reads with no build first.
          if (named === condition && !matches(file, tracked) && matches(file, files)) {
            found.push(
              `${at}: ${where} names ${path}, which a build writes. Point it at the source the build reads.`,
            );
            continue;
          }

          if (matches(file, files)) continue;

          found.push(
            path.startsWith('./dist/')
              ? `${at}: ${where} names ${path}, which no pack entry builds. Add its entry to the package's build config, or point it at a file that's there.`
              : `${at}: ${where} names ${path}, which isn't tracked. Point it at a file that's there.`,
          );
        }

        const types = isPath(target) ? undefined : target['types'];
        const packed = isPath(target) ? [] : ['types', 'import'].filter((key) => key in target);
        const first = isPath(target) ? undefined : Object.keys(target)[0];

        if (field === 'exports' && packed.length > 0 && first !== condition) {
          found.push(
            `${at}: ${name} has ${packed.join(' and ')} but not its source under "${condition}" first. Add "${condition}": its source file, ahead of ${packed.join(' and ')}.`,
          );
        }

        if (pack.length > 0 && types !== undefined && !built.has(posix.join(directory, types))) {
          found.push(
            `${at}: ${name} has types at ${types}, which no pack entry builds. Add "${entry}"'s source to the build config's entries.`,
          );
        }
      }
    }
  }

  return found;
};

/** The folders `patterns` match at `root` that hold a `package.json`, from the root, sorted. */
export const packageFolders = (root: string, patterns: ReadonlyArray<string>) =>
  [
    ...new Set(
      patterns.flatMap((pattern) =>
        globSync(posix.join(pattern, 'package.json'), { cwd: root }).map((path) =>
          posix.dirname(path),
        ),
      ),
    ),
  ].sort();

/** Each package in `folders`, with the builds its pack config declares. */
const readPackages = async (
  root: string,
  folders: ReadonlyArray<string>,
  { packConfig, packKey }: Pick<Options, 'packConfig' | 'packKey'>,
): Promise<ReadonlyArray<Package>> =>
  Promise.all(
    folders.map(async (directory) => {
      const at = join(directory, 'package.json');
      const manifest = decodeManifest(at, readFileSync(join(root, at), 'utf8'));
      const config = join(root, directory, packConfig);
      if (!existsSync(config)) return { directory, manifest, pack: [] };

      const loaded: unknown = (await import(pathToFileURL(config).href)).default;
      const pack = packKey === '.' ? loaded : isRecord(loaded) ? loaded[packKey] : undefined;
      if (pack === undefined) return { directory, manifest, pack: [] };

      const builds: ReadonlyArray<unknown> = Array.isArray(pack) ? pack : [pack];
      if (!builds.every(isBuild)) throw new Error(`${join(directory, packConfig)}: its ${packKey} has no entry list`);

      return { directory, manifest, pack: builds };
    }),
  );

/** What `package-exports` reads: which folders hold packages, and the source condition. */
export interface Options {
  readonly packages: ReadonlyArray<string>;
  readonly condition: string;
  readonly packConfig: string;
  readonly packKey: string;
}

/** Checks the packages of the repo at `root`, prints each problem, and answers the exit code. */
export const packageExports = async (root: string, { packages, condition, packConfig, packKey }: Options) => {
  const folders = packageFolders(root, packages);

  if (folders.length === 0) {
    console.error(
      `package-exports: no package.json in ${packages.join(' or ')}. Name the packages' folders with --packages.`,
    );

    return 1;
  }

  const tracked = new Set(
    execFileSync('git', ['ls-files', '-z', '--', ...folders], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\0')
      .filter((path) => path !== ''),
  );
  const found = problems(await readPackages(root, folders, { packConfig, packKey }), tracked, condition);

  for (const line of found) console.error(line);

  if (found.length > 0) return 1;

  console.error(`package-exports: the exports of ${folders.length} packages hold`);

  return 0;
};
