#!/usr/bin/env node
/**
 * pass-key.ts: the content key of an expensive compiled component (a Rust crate, in the repo this
 * comes from): a hash of everything its builds, its tests and its checks read at a commit, but the
 * release's version. CI's plan runs the component's checks when a change moves the key, and a pull
 * request skips them when main's own run passed them at the same key.
 *
 *     node scripts/reuse/pass-key.ts [--with-versions] [<commit>]
 *
 * Prints the key at `<commit>`, `HEAD` by default, and fails when the workflow's blocks it hashes
 * can't be found, so the plan runs the checks. With `--with-versions` it prints the binary key:
 * the same hash with the versions in, which moves whenever the binaries change, as the plan's
 * choice to build them reads it.
 *
 * Runs: in CI's plan job, which installs nothing: Node 24 and `git` only. See README.md for the
 * plan's steps and docs/pages/06-reuse-work-by-its-real-inputs.md.
 * Configure: the CONFIG block: the component's folder, what it reads outside it, what its
 * toolchain reads above it, the workflow jobs that build, test and check it, and which manifests
 * carry a version a release raises.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * It hashes, by git's object ids at the commit:
 * - Every tracked file under the component's folder, but the Markdown at its root, which no build
 *   or test reads: sources, tests, fixtures, fakes, the lockfile, the toolchain file, and each
 *   platform's npm package.
 * - `outsidePrefixes` and `outsideFiles`: the files outside the folder its sources or tests read
 *   (shared test vectors, say), and the workflow that builds and tests it. Keep a test that holds
 *   the sources to reading nothing else, or the key misses a read.
 * - What the toolchain reads from the folders above the package. For Rust: a `.cargo/` folder, a
 *   `Cargo.toml` that could make it a workspace's member, a lockfile, a toolchain file, and
 *   rustfmt's and Clippy's config, which each finds by searching up from the package.
 * And by their text in the CI workflow: its `env` and `defaults`, which every job inherits, and
 * each job in `jobs`. A missing job throws, as a renamed one would leave what it runs out of the key.
 *
 * The pass key vs the binary key. Each platform's npm package goes in by its text with its
 * `version` blanked, the one field a release raises in any of the key's files. So a release merge,
 * which changes only those versions, keeps main's pass: the checks never read the version, and
 * the tests that build it in hold the binary to that same value. The release's own run tests each
 * platform at its new version before it publishes. A package's text that isn't the JSON a release
 * writes, two-space indented and ending in a newline, goes in whole, so every byte but the
 * version's still counts, and a file it can't read moves the key. The binaries' cache goes by the
 * binary key, which keeps the versions: each binary names its release, so a snapshot never takes
 * one of another version.
 *
 * Not the runner's image, whose programs the tests run: a pass on main stands a day, so a new
 * image is tried within one.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { argv, cwd, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------------------------

export interface KeyConfig {
  /** Change it to change every key at once, such as when what a key hashes changes. */
  readonly keyVersion: string;
  /** The component's folder, from the repo's root, with a trailing slash. */
  readonly component: string;
  /** Folders outside the component its sources or tests read. */
  readonly outsidePrefixes: ReadonlyArray<string>;
  /** Files outside it its builds read: the workflow that builds and tests it, say. */
  readonly outsideFiles: ReadonlyArray<string>;
  /** The folders above the component, from the repo's root, with a trailing slash ('' is the root). */
  readonly above: ReadonlyArray<string>;
  /** What the toolchain reads in a folder above the component. */
  readonly aboveFiles: ReadonlyArray<string>;
  /** A folder above the component the toolchain reads whole, such as `.cargo/`. */
  readonly aboveFolders: ReadonlyArray<string>;
  /** The CI workflow whose jobs build, test and check it. */
  readonly workflowPath: string;
  /** Those jobs, by their ids in the workflow. A key needs each. */
  readonly jobs: ReadonlyArray<string>;
  /** The workflow's top-level blocks its jobs inherit, hashed when they're there. */
  readonly inherited: ReadonlyArray<string>;
  /** Whether a path is a manifest whose version a release raises, which the pass key leaves out. */
  readonly isVersioned: (path: string) => boolean;
}

export const config: KeyConfig = {
  keyVersion: 'pass-key 1',
  component: 'packages/<component>/',
  outsidePrefixes: [],
  outsideFiles: ['.github/workflows/<component>-builds.yml'],
  above: ['', 'packages/'],
  aboveFiles: ['Cargo.toml', 'Cargo.lock', 'rust-toolchain', 'rust-toolchain.toml', 'rustfmt.toml', '.rustfmt.toml', 'clippy.toml', '.clippy.toml'],
  aboveFolders: ['.cargo/'],
  workflowPath: '.github/workflows/ci.yml',
  jobs: ['<component>', '<component>-tests', 'rust'],
  inherited: ['env', 'defaults'],
  // Each platform's npm package, which carries the binary and the release's version.
  isVersioned: (path) => /^packages\/<component>\/npm\/[^/]+\/package\.json$/.test(path),
};

// ---------------------------------------------------------------------------------------------

/** Whether the key hashes a tracked file. */
export const isInput = (path: string, shape = config) =>
  (path.startsWith(shape.component) && !/^[^/]+\.md$/.test(path.slice(shape.component.length))) ||
  shape.outsidePrefixes.some((prefix) => path.startsWith(prefix)) ||
  shape.outsideFiles.includes(path) ||
  shape.above.some((folder) => shape.aboveFolders.some((inner) => path.startsWith(`${folder}${inner}`)) || shape.aboveFiles.some((file) => path === `${folder}${file}`));

/** What the key reads at a commit. */
export interface Source {
  /** Each tracked file, with its mode, type and git's object id, as `ls-tree` prints them. */
  readonly files: ReadonlyMap<string, string>;
  /** The text of each file in `files` that `isVersioned` names, by its path. */
  readonly texts: ReadonlyMap<string, string>;
  /** The CI workflow's text. */
  readonly workflow: string;
}

const git = (args: ReadonlyArray<string>, directory: string) => {
  const done = spawnSync('git', args, { cwd: directory, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (done.status !== 0) throw new Error(`git ${args[0] ?? ''} failed: ${done.stderr}`);

  return done.stdout;
};

/** The source at `head`, in the repo at `directory`. */
export const sourceAt = (head: string, directory = cwd(), shape = config): Source => {
  const files = new Map(
    git(['ls-tree', '-r', '-z', '--full-tree', head], directory)
      .split('\0')
      .flatMap((line) => {
        const tab = line.indexOf('\t');

        return tab === -1 ? [] : [[line.slice(tab + 1), line.slice(0, tab)] as const];
      }),
  );
  const texts = new Map(
    [...files].flatMap(([path, entry]) => (shape.isVersioned(path) ? [[path, git(['cat-file', 'blob', entry.split(' ')[2] ?? ''], directory)] as const] : [])),
  );
  const workflow = git(['show', `${head}:${shape.workflowPath}`], directory);

  return { files, texts, workflow };
};

const indentOf = (line: string) => line.length - line.trimStart().length;

/** Whether a line says nothing to YAML: blank, or only a comment. */
const silent = (line: string) => /^\s*(#.*)?$/.test(line);

/**
 * The block a key starts at a given indent in YAML's text, from its line to the next line that
 * says something at that indent or less, without the comments and blank lines at its end.
 */
const blockAt = (lines: ReadonlyArray<string>, start: number) => {
  const indent = indentOf(lines[start] ?? '');
  let end = start + 1;

  while (end < lines.length) {
    const line = lines[end] ?? '';
    if (!silent(line) && indentOf(line) <= indent) break;

    end += 1;
  }

  while (end > start + 1 && silent(lines[end - 1] ?? '')) end -= 1;

  return lines.slice(start, end).join('\n');
};

/**
 * The text of each block of the workflow the key hashes, by name: each job in `jobs`, and each
 * block in `inherited` that's there. Throws when a job is missing. Jobs are found as two-space
 * indented keys under a top-level `jobs:`, as most workflows write them.
 */
export const blocksOf = (workflow: string, shape = config) => {
  const lines = workflow.split('\n');
  const blocks = new Map<string, string>();
  const jobsLine = lines.findIndex((line) => line === 'jobs:');

  for (const name of shape.inherited) {
    const start = lines.findIndex((line) => line === `${name}:` || line.startsWith(`${name}: `));
    if (start !== -1) blocks.set(name, blockAt(lines, start));
  }

  for (const name of shape.jobs) {
    const start = lines.findIndex((line, at) => at > jobsLine && line === `  ${name}:`);
    if (jobsLine === -1 || start === -1) throw new Error(`no job ${name} in ${shape.workflowPath}`);

    blocks.set(`jobs.${name}`, blockAt(lines, start));
  }

  return blocks;
};

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * A versioned manifest's text with its version blanked, or none when the text isn't JSON as a
 * release writes it: an object with a string `version`, two-space indented and ending in a
 * newline. Blanked in place, so the field's position still counts, and that JSON is the one text of
 * its value, so every other byte counts too.
 */
export const versionless = (text: string) => {
  let value: { version?: unknown } | null;

  try {
    value = JSON.parse(text) as { version?: unknown } | null;
  } catch {
    return undefined;
  }

  if (!text.startsWith('{') || `${JSON.stringify(value, null, 2)}\n` !== text) return undefined;

  if (!(JSON.stringify(value?.version) ?? '').startsWith('"')) return undefined;

  return JSON.stringify({ ...value, version: '' });
};

/** How the key holds a file: by its mode and git's id, or a versioned manifest by its versionless text. */
const entryOf = (source: Source, path: string, id: string, versions: boolean, shape: KeyConfig) => {
  const text = versions || !shape.isVersioned(path) ? undefined : source.texts.get(path);
  const kept = text === undefined ? undefined : versionless(text);

  return kept === undefined ? id : `${id.split(' ')[0] ?? ''} versionless ${sha256(kept)}`;
};

/**
 * The key of a source: 64 hex digits. With `versions`, the binary key: each versioned manifest goes
 * in whole, as the plan's choice to build the binaries reads it.
 */
export const keyOf = (source: Source, { versions = false, shape = config }: { versions?: boolean; shape?: KeyConfig } = {}) => {
  const files = [...source.files].flatMap(([path, id]) => (isInput(path, shape) ? [`${path}\0${entryOf(source, path, id, versions, shape)}\n`] : [])).sort();
  const blocks = [...blocksOf(source.workflow, shape)].map(([name, text]) => `${name}\0${sha256(text)}\n`);

  return sha256([versions ? `${shape.keyVersion} with versions` : shape.keyVersion, ...files, ...blocks].join(''));
};

if (argv[1] === fileURLToPath(import.meta.url)) {
  const args = argv.slice(2);
  const versions = args[0] === '--with-versions';
  const [head = 'HEAD', ...rest] = versions ? args.slice(1) : args;

  if (rest.length > 0 || head.startsWith('-')) {
    console.error('usage: node scripts/reuse/pass-key.ts [--with-versions] [<commit>]');
    exit(2);
  }

  try {
    console.log(keyOf(sourceAt(head), { versions }));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    exit(1);
  }
}
