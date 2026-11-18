/**
 * config.ts: reads `workspace-tools.json` at the repo's root, when there is one. Every setting has
 * a default, and a command's own flag wins over the file.
 *
 * Runs: imported by `bin.ts`.
 * Configure: `workspace-tools.json` at the repo's root. `config.example.json` beside this
 * package's README shows every key.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A command as its words, or one string split on spaces. Use the array form when a word has one. */
export type Command = string | ReadonlyArray<string>;

export interface Config {
  readonly types: {
    /**
     * The type checker, run once per project. Unset: the repo's own `typescript`'s `tsc`. For
     * Effect's language service, `["node_modules/.bin/effect-tsgo", "tsrs"]`. The contract it must
     * keep is in the README, "The type driver".
     */
    readonly compiler?: Command;
    /** The root config whose references name every project. */
    readonly root: string;
    /** How many projects check at once. */
    readonly jobs: number;
  };
  readonly symbols: {
    /** Paths the index leaves out, as regular expressions on the path from the root. */
    readonly skip: ReadonlyArray<string>;
  };
  readonly packageExports: {
    readonly packages: ReadonlyArray<string>;
    readonly condition: string;
    /** Each package's config file that says what its build writes. */
    readonly packConfig: string;
    /** The key of that file's default export that holds the build, or `.` for the export itself. */
    readonly packKey: string;
  };
  /**
   * Only `check` reads it, and only when the file sets it: these defaults are Vite+'s tasks, as
   * config.lint-vite-plus.example.json shows. Set all four commands for your own linter.
   */
  readonly lint: {
    /** The base the changed files are counted from. */
    readonly base: string;
    /** Which files the typed pass lints. */
    readonly files: string;
    /** The untyped pass over every file. The mode variable is set to `none` for it. */
    readonly workspace: Command;
    readonly workspaceFix: Command;
    /** The typed pass. The changed files are appended. */
    readonly changed: Command;
    readonly changedFix: Command;
    /** Steps that run first, each to the end, such as the types: their exits count too. */
    readonly before: ReadonlyArray<Command>;
  };
}

export const defaults: Config = {
  types: { root: 'tsconfig.json', jobs: 4 },
  symbols: { skip: [] },
  packageExports: {
    packages: ['packages/*'],
    condition: 'workspace-source',
    packConfig: 'vite.config.ts',
    packKey: 'pack',
  },
  lint: {
    base: 'origin/main',
    files: '\\.[cm]?tsx?$',
    workspace: ['vp', 'run', 'lint:workspace'],
    workspaceFix: ['vp', 'check', '--fix'],
    changed: ['vp', 'run', 'lint:files'],
    changedFix: ['vp', 'lint', '--fix', '--no-error-on-unmatched-pattern'],
    before: [],
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The file's section `name`, over its defaults, refusing a key the defaults don't have. */
const section = <Section extends object>(file: Record<string, unknown>, name: string, fallback: Section): Section => {
  const given = file[name];
  if (given === undefined) return fallback;

  if (!isRecord(given)) throw new Error(`workspace-tools.json: "${name}" must be an object`);

  const known = new Set([...Object.keys(fallback), ...(name === 'types' ? ['compiler'] : [])]);
  const unknown = Object.keys(given).filter((key) => !known.has(key));
  if (unknown.length > 0) throw new Error(`workspace-tools.json: "${name}" has no ${unknown.join(', ')}`);

  return { ...fallback, ...given };
};

/** The config at `root`, or the defaults when it has none. */
export const loadConfig = (root: string): Config => {
  const path = join(root, 'workspace-tools.json');
  if (!existsSync(path)) return defaults;

  const file: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(file)) throw new Error('workspace-tools.json: must hold an object');

  return {
    types: section(file, 'types', defaults.types),
    symbols: section(file, 'symbols', defaults.symbols),
    packageExports: section(file, 'packageExports', defaults.packageExports),
    lint: section(file, 'lint', defaults.lint),
  };
};

/**
 * Whether the repo's file sets `lint`. The commands' defaults are Vite+'s, which a repo without it
 * can't run, so `check` asks for them rather than assume them.
 */
export const lintConfigured = (root: string) => {
  const path = join(root, 'workspace-tools.json');
  if (!existsSync(path)) return false;

  const file: unknown = JSON.parse(readFileSync(path, 'utf8'));

  return isRecord(file) && isRecord(file['lint']);
};

/** A command's words. */
export const words = (command: Command): ReadonlyArray<string> =>
  typeof command === 'string' ? command.split(/\s+/).filter(Boolean) : command;
