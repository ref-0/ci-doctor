#!/usr/bin/env node
/**
 * type-coverage.ts: fails when a tracked TypeScript file is in no project the root `tsconfig.json`
 * reaches, or, when you configure a lint-files command, when lint ignores it.
 *
 *     node scripts/docs/type-coverage.ts
 *
 * A project-references type check (`tsc --build` on the root) checks the projects the root
 * reaches, each file with the options of the project that includes it, and a file that none
 * includes not at all. One outside them goes unseen: in the repo this comes from, one once gave a
 * package's source no Node types and hid 44 errors. So this follows the root's references, and each
 * project's own, asks TypeScript which files each project includes (`tsc --showConfig`), and names
 * every tracked `.ts`, `.tsx`, `.mts` or `.cts` file that none does.
 *
 * Lint's rules, its type-aware ones too, read only the files lint doesn't ignore: lint ignoring a
 * folder there once hid 57 errors. So when `lintFilesCommand` is set, this asks lint which files it
 * reads, and names every tracked TypeScript file it doesn't, other than files a tool writes.
 *
 * Runs: in CI's static job, from the repo's root, with the repo's own `typescript` installed.
 * Node 24 and `git`. See docs/pages/09-workspace-tooling.md.
 * Configure: the CONFIG block: the root tsconfig, the lint-files command, and what a tool writes.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { argv, cwd, execPath, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// ---------------------------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------------------------

export interface CoverageConfig {
  /** The root config, from the repo's root, whose references are the workspace's projects. */
  readonly tsconfig: string;
  /**
   * A command that prints the files lint reads, one path from the root per line, or undefined to
   * skip the lint half. Vite+ prints them with `vp lint --debug=files`; for another linter, write a
   * small script that does.
   */
  readonly lintFilesCommand: ReadonlyArray<string> | undefined;
  /** What a tool writes, which lint may ignore: a step checks each against its source instead. */
  readonly generated: RegExp;
  /** How to bring a file into lint, for the message. */
  readonly lintHint: string;
}

export const config: CoverageConfig = {
  tsconfig: 'tsconfig.json',
  lintFilesCommand: undefined, // e.g. ['pnpm', 'exec', 'vp', 'lint', '--debug=files']
  generated: /\.gen\.(?:d\.)?ts$/u,
  lintHint: "take it out of lint's ignore patterns",
};

// ---------------------------------------------------------------------------------------------

const run = promisify(execFile);

/** The file `specifier` names, resolved from the repo at `root`, as its own scripts would. */
const fromRoot = (root: string, specifier: string) => createRequire(join(root, 'package.json')).resolve(specifier);

/** A project's config as TypeScript resolves it: the files it includes, and its references. */
const decodeConfig = (text: string) => {
  const value = JSON.parse(text) as { files?: unknown; references?: unknown };
  const files = Array.isArray(value.files) ? value.files.filter((file): file is string => typeof file === 'string') : [];
  const references = Array.isArray(value.references)
    ? value.references.flatMap((reference: unknown) => {
        const path = (reference as { path?: unknown } | null)?.path;

        return typeof path === 'string' ? [path] : [];
      })
    : [];

  return { files, references };
};

/** A reference's `path` names a project's directory or its config file. */
const configAt = (path: string) => (path.endsWith('.json') ? path : join(path, 'tsconfig.json'));

/** A project: its config file, and the files it includes, each by absolute path. */
export interface Project {
  readonly config: string;
  readonly files: ReadonlySet<string>;
}

/**
 * The config at `tsconfig` and each project it reaches, through nested references, each once, as
 * the TypeScript of the repo at `root` resolves them.
 */
export const reachedProjects = async (root: string, tsconfig: string): Promise<ReadonlyArray<Project>> => {
  const tsc = join(dirname(fromRoot(root, 'typescript/package.json')), 'bin/tsc');
  const projects: Array<Project> = [];
  const seen = new Set([tsconfig]);
  let next = [tsconfig];

  while (next.length > 0) {
    const configs = await Promise.all(
      next.map(async (path) => {
        const { stdout } = await run(execPath, [tsc, '--project', path, '--showConfig'], { maxBuffer: 64 * 1024 * 1024 });

        return { config: path, ...decodeConfig(stdout) };
      }),
    );
    next = [];

    for (const { config: path, files, references } of configs) {
      const directory = dirname(path);
      projects.push({ config: path, files: new Set(files.map((file) => resolve(directory, file))) });

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

/** The files lint reads in the workspace at `root`, by path from it, or undefined when unasked. */
const lintedFiles = async (root: string, command: ReadonlyArray<string> | undefined): Promise<ReadonlySet<string> | undefined> => {
  if (command === undefined) return undefined;

  const [program = '', ...args] = command;
  const { stdout } = await run(program, args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });

  return new Set(stdout.split('\n').filter((path) => path !== ''));
};

/** Checks the repo at `root`, names each file outside, and answers the exit code. */
export const typeCoverage = async (root: string, shape = config) => {
  const { stdout: listed } = await run('git', ['ls-files', '-z', '--', '*.ts', '*.tsx', '*.mts', '*.cts'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const tracked = listed.split('\0').filter((path) => path !== '');

  const [projects, linted] = await Promise.all([reachedProjects(root, join(root, shape.tsconfig)), lintedFiles(root, shape.lintFilesCommand)]);

  const reached = new Set(projects.flatMap(({ files }) => [...files]));
  const uncovered = tracked.filter((path) => !reached.has(join(root, path)));
  const unlinted = linted === undefined ? [] : tracked.filter((path) => !linted.has(path) && !shape.generated.test(path));

  for (const path of uncovered)
    console.error(`::error file=${path}::${path} is in no project the root ${shape.tsconfig} reaches: include it in one, or reference its project from ${shape.tsconfig}.`);

  for (const path of unlinted) console.error(`::error file=${path}::${path} is a file lint ignores, so no lint rule reads it: ${shape.lintHint}.`);

  if (uncovered.length > 0 || unlinted.length > 0) {
    console.error(`type-coverage: of ${String(tracked.length)} TypeScript files, ${String(uncovered.length)} are in no project and lint ignores ${String(unlinted.length)}`);

    return 1;
  }

  console.log(
    `type-coverage: all ${String(tracked.length)} TypeScript files are in a project the root reaches${linted === undefined ? '' : ", and lint reads each one a tool doesn't write"}`,
  );

  return 0;
};

if (argv[1] === fileURLToPath(import.meta.url)) {
  try {
    exit(await typeCoverage(cwd()));
  } catch (error) {
    console.error(`::error::type-coverage: ${error instanceof Error ? error.message : String(error)}`);
    exit(1);
  }
}
