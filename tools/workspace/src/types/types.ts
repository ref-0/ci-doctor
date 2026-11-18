/**
 * Checks the types of every project the root `tsconfig.json` reaches, with the repo's own checker,
 * and fails on any error.
 *
 *     node tools/workspace/src/bin.ts types [--compiler <command>]
 *
 * Runs: locally, in the repo's `check:types` script, and in CI's types step.
 * Configure: `types.compiler`, `types.root` and `types.jobs` in `workspace-tools.json`, or
 * `--compiler`. Unset, the checker is the repo's `typescript`'s `tsc`. Any checker that keeps the
 * contract in the README's "The type driver" works: stock `tsc`, a native port, or a framework's
 * wrapper that reports its rules as type errors (Effect's `effect-tsgo tsrs`, for example), so a
 * separate framework-only pass isn't needed.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * Each file is checked with the options of the project that includes it. A project's program also
 * holds the workspace sources it imports, when packages export their source, and the checker
 * checks those under the importer's options too, such as a UI package's DOM code under a server
 * app's runtime types. So this keeps only the errors in a project's own files, global ones, and
 * those in a file no project includes, and prints each error once. It turns off the declarations
 * `composite` asks for: nothing here emits, and the projects are composite only so the root can
 * reference them.
 *
 * Each project's passing result is kept for every worktree on the machine, and a project whose
 * inputs match one, from this worktree or another, replays it, as `cache.ts` says.
 */
import { spawn } from 'node:child_process';
import { basename, relative, resolve } from 'node:path';

import type { Command } from '../config.ts';
import { splitListed, typesCache } from './cache.ts';
import { type Compiler, compilerOf, type Project, reachedProjects } from './projects.ts';

/** An error the checker reports: the file it's in, by absolute path, unless it's global, and its text. */
interface Diagnostic {
  readonly file: string | undefined;
  readonly text: string;
}

/**
 * What the checker printed for one project, but the files it read, how it exited, and whether
 * it's the result kept from before.
 */
interface Checked {
  readonly project: Project;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly replayed: boolean;
}

/** The checker's options for every project. `--listFiles` names the files its program read, for the key. */
export const options = ['--noEmit', '--composite', 'false', '--declaration', 'false', '--pretty', 'false', '--listFiles'];

/**
 * Runs the checker on `project` from `root`, so the paths it prints are from `root`, with the files
 * its program read, and when it started.
 */
const check = (root: string, compiler: Compiler, project: Project) =>
  new Promise<Checked & { readonly listed: ReadonlyArray<string>; readonly started: number }>((done, fail) => {
    const started = Date.now();
    const child = spawn(compiler.program, [...compiler.args, '--project', project.config, ...options], { cwd: root });
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', fail);
    child.on('close', (status) => {
      const { files, diagnostics } = splitListed(Buffer.concat(stdout).toString('utf8'));

      done({
        project,
        status,
        stdout: diagnostics,
        stderr: Buffer.concat(stderr).toString('utf8'),
        replayed: false,
        listed: files,
        started,
      });
    });
  });

/**
 * The errors in the checker's output, from `root`. Each starts a line, as `path(line,col): error
 * TS…` or, when it's global, `error TS…`, and its indented lines below are its chain and related
 * spans.
 */
const parseDiagnostics = (root: string, output: string): ReadonlyArray<Diagnostic> => {
  const diagnostics: Array<{ file: string | undefined; lines: Array<string> }> = [];

  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;

    const last = diagnostics.at(-1);

    if (/^\s/.test(line) && last !== undefined) {
      last.lines.push(line);
      continue;
    }

    const path = /^(.+?)\(\d+,\d+\): /.exec(line)?.[1];
    diagnostics.push({ file: path === undefined ? undefined : resolve(root, path), lines: [line] });
  }

  return diagnostics.map(({ file, lines }) => ({ file, text: lines.join('\n') }));
};

/**
 * The errors to report from each project's: those in its own files, or global, or in a file no
 * project includes, each once.
 */
const reportedErrors = (
  checked: ReadonlyArray<{ readonly project: Project; readonly diagnostics: ReadonlyArray<Diagnostic> }>,
): ReadonlyArray<Diagnostic> => {
  const owned = new Set(checked.flatMap(({ project }) => [...project.files]));
  const reported = new Map<string, Diagnostic>();

  for (const { project, diagnostics } of checked) {
    for (const diagnostic of diagnostics) {
      const { file, text } = diagnostic;
      if (file !== undefined && owned.has(file) && !project.files.has(file)) continue;

      reported.set(text, diagnostic);
    }
  }

  return [...reported.values()];
};

/**
 * `tsc` exits 0 with no errors, and 1 or 2 with some. Anything else, or errors and none printed, is
 * the checker failing.
 */
const checkerFailed = (root: string, { status, stdout }: Pick<Checked, 'status' | 'stdout'>) =>
  status === null || status > 2 || (status !== 0 && parseDiagnostics(root, stdout).length === 0);

/** The errors in `run`'s own files, or global, or in a file no project of `projects` includes. */
const ownErrors = (root: string, projects: ReadonlyArray<Project>, run: Pick<Checked, 'project' | 'stdout'>) =>
  reportedErrors([
    ...projects.flatMap((project) => (project === run.project ? [] : [{ project, diagnostics: [] }])),
    { project: run.project, diagnostics: parseDiagnostics(root, run.stdout) },
  ]);

/**
 * Replays each project's kept result whose key holds, and runs the checker on the rest from
 * `root`, `jobs` at a time, the most files first, so the largest starts at once. All at once took
 * no less time on a 16-core machine, and held every project in memory. Each fresh result with no
 * error of its own is kept.
 */
const checkAll = async (root: string, compiler: Compiler, projects: ReadonlyArray<Project>, jobs: number) => {
  const cache = typesCache(root, projects, [basename(compiler.program), ...compiler.args, ...options]);
  const kept = await Promise.all(projects.map(async (project) => ({ project, result: await cache.replay(project) })));
  const runs: Array<Checked> = kept.flatMap(({ project, result }) =>
    result === undefined ? [] : [{ project, status: result.status, stdout: result.diagnostics, stderr: '', replayed: true }],
  );
  const queue = kept
    .filter(({ result }) => result === undefined)
    .map(({ project }) => project)
    .sort((a, b) => b.files.size - a.files.size);

  await Promise.all(
    Array.from({ length: Math.max(1, jobs) }, async () => {
      for (let project = queue.shift(); project !== undefined; project = queue.shift()) {
        const { listed, started, ...run } = await check(root, compiler, project);
        runs.push(run);

        // Only a pass is kept, a project with no error of its own. An error another project owns,
        // in a file this program imports, doesn't stop it: that project reports it. The installed
        // packages aren't in the key, which the lockfile stands for, so a worktree whose install
        // is broken, as when a package manager's store once emptied installed files, would
        // otherwise hand its errors to every other worktree at that lockfile.
        if (run.status !== null && !checkerFailed(root, run) && ownErrors(root, projects, run).length === 0) {
          await cache.keep(project, started, listed, { status: run.status, diagnostics: run.stdout });
        }
      }
    }),
  );

  return runs.sort((a, b) => projects.indexOf(a.project) - projects.indexOf(b.project));
};

export interface TypesOptions {
  readonly compiler?: Command;
  readonly root: string;
  readonly jobs: number;
}

/** Checks the types of the repo at `root`, prints each error, and answers the exit code. */
export const types = async (root: string, settings: TypesOptions) => {
  const start = performance.now();
  const compiler = compilerOf(root, settings.compiler);

  const projects = (await reachedProjects(root, compiler, resolve(root, settings.root))).filter(({ files }) => files.size > 0);

  const runs = (await checkAll(root, compiler, projects, settings.jobs)).map((run) => ({
    ...run,
    diagnostics: parseDiagnostics(root, run.stdout),
  }));

  const failed = runs.filter((run) => checkerFailed(root, run));

  for (const { project, status, stdout, stderr } of failed) {
    console.error(`types: the checker failed on ${relative(root, project.config)}, exit ${status}`);
    console.error(stderr || stdout);
  }

  const errors = reportedErrors(runs);

  for (const { text } of errors) console.log(text);

  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  const replayed = runs.filter((run) => run.replayed).length;
  const checked = `${projects.length} projects, ${replayed} replayed, in ${seconds}s`;

  if (failed.length > 0 || errors.length > 0) {
    console.error(`types: ${errors.length} errors and ${failed.length} checker failures in ${checked}`);

    return 1;
  }

  console.error(`types: no errors in ${checked}`);

  return 0;
};
