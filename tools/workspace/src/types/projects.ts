/**
 * The type checker, as the repo names it, and the projects a config reaches through its
 * references, each with the files it includes, as that checker resolves the config.
 *
 * Runs: imported by `types.ts`.
 * Configure: `types.compiler` in `workspace-tools.json`. Unset, it is the repo's own `tsc`.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { execPath } from 'node:process';
import { promisify } from 'node:util';

import { type Command, words } from '../config.ts';

const run = promisify(execFile);

/** A checker as a program and the arguments before the driver's own. */
export interface Compiler {
  readonly program: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * The file `specifier` names, resolved from the repo at `root`, as its own scripts would: the
 * checker is the repo's, at the version it pins.
 */
export const fromRoot = (root: string, specifier: string) =>
  createRequire(join(root, 'package.json')).resolve(specifier);

/**
 * The checker `command` names. A script (`.js`, `.cjs`, `.mjs`, `.ts`) runs under this Node, a
 * path runs from the root, and a bare name from `PATH`. Unset, the repo's `typescript`'s `tsc`.
 */
export const compilerOf = (root: string, command: Command | undefined): Compiler => {
  if (command === undefined) {
    return { program: execPath, args: [join(dirname(fromRoot(root, 'typescript/package.json')), 'bin/tsc')] };
  }

  const [first, ...rest] = words(command);
  if (first === undefined) throw new Error('types.compiler is empty');

  const path = first.includes('/') ? (isAbsolute(first) ? first : resolve(root, first)) : first;

  return /\.[cm]?[jt]s$/.test(path) ? { program: execPath, args: [path, ...rest] } : { program: path, args: rest };
};

/** A project: its config file, and the files it includes, each by absolute path. */
export interface Project {
  readonly config: string;
  readonly files: ReadonlySet<string>;
}

/** What the driver reads of `--showConfig`'s output. Anything else in it is left alone. */
const parseShown = (config: string, text: string) => {
  const shown: unknown = JSON.parse(text);
  if (typeof shown !== 'object' || shown === null) throw new Error(`${config}: --showConfig printed no object`);

  const { files = [], references = [] } = shown as { files?: unknown; references?: unknown };
  const strings = (value: unknown): value is ReadonlyArray<string> =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');
  const paths = Array.isArray(references) ? references.map((reference: { path?: unknown }) => reference?.path) : [];
  if (!strings(files) || !strings(paths)) throw new Error(`${config}: --showConfig's files or references aren't paths`);

  return { files, references: paths };
};

/** A reference's `path` names a project's directory or its config file. */
const configAt = (path: string) => (path.endsWith('.json') ? path : join(path, 'tsconfig.json'));

/**
 * The config at `config` and each project it reaches, through nested references, each once, as
 * `compiler --project <config> --showConfig` resolves them.
 */
export const reachedProjects = async (root: string, compiler: Compiler, config: string): Promise<ReadonlyArray<Project>> => {
  const projects: Array<Project> = [];
  const seen = new Set([config]);
  let next = [config];

  while (next.length > 0) {
    const configs = await Promise.all(
      next.map(async (path) => {
        const { stdout } = await run(compiler.program, [...compiler.args, '--project', path, '--showConfig'], {
          cwd: root,
          maxBuffer: 64 * 1024 * 1024,
        });

        return { config: path, ...parseShown(path, stdout) };
      }),
    );
    next = [];

    for (const { config, files, references } of configs) {
      const directory = dirname(config);
      projects.push({ config, files: new Set(files.map((file) => resolve(directory, file))) });

      for (const reference of references) {
        const referenced = configAt(resolve(directory, reference));
        if (seen.has(referenced)) continue;

        seen.add(referenced);
        next.push(referenced);
      }
    }
  }

  return projects;
};
