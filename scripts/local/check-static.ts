#!/usr/bin/env node
/**
 * check-static.ts: runs the checks of CI's `static` and `lint` jobs ("Build and generated files" and
 * "Format, lint and types" in templates/github/workflows/ci.yml) one after another, on your machine,
 * and stops at the first that fails. Run it once before pushing, after committing.
 *
 *     node scripts/local/check-static.ts
 *
 * Runs: locally, never in CI, which runs these steps in its own jobs. Node 24 and `git` only.
 * Configure: the CONFIG block: the default branch, and `staticSteps`, one entry per step of your
 * workflow's static and lint jobs, in their order, with your commands. A step with a <placeholder>
 * left in it stops the run before anything starts.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * CI checks a pull request's merge into main from `HEAD^1` to `HEAD`, and main's sweep from its last
 * passing sweep. Here each range check runs from the merge base with the default branch to `HEAD`, so
 * it sees the branch's commits and not what's uncommitted: commit first. It doesn't build, as long as
 * your checks need no build, and runs no tests. A step can name a `local` command to run here in
 * place of CI's, such as the split lint (tools/workspace's `check`), which runs type-aware rules on
 * the changed files only, where CI lints every file with types. Each step says when it starts and
 * how long it took. The first that fails stops the run, with its name and exit code.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { argv, cwd, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

/** A step of CI's static or lint job: its name and command there, and what runs here instead. */
export interface Step {
  readonly name: string;
  readonly command: readonly [string, ...Array<string>];
  readonly local?: readonly [string, ...Array<string>];
}

// ---------------------------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------------------------

/** The branch a pull request merges into, as this clone names it. */
export const defaultBranch = 'origin/main';

/**
 * The static job's steps, other than building and what checks the build, then the lint job's, from
 * `base` to `HEAD`. Keep them in the workflow's order, and change both together.
 */
export const staticSteps = (base: string): ReadonlyArray<Step> => [
  { name: 'Generated files are current', command: ['<generated-files-check-command>'] },
  { name: 'Package exports', command: ['node', 'tools/workspace/src/bin.ts', 'package-exports'] },
  { name: 'No copied code', command: ['node', 'tools/workspace/src/bin.ts', 'symbols', 'check', base, 'HEAD'] },
  // The lint job's steps.
  { name: 'Types', command: ['<types-command>'] },
  // The split lint. If its `lint.before` runs the types too, drop the Types step above.
  { name: 'Format and lint', command: ['<lint-command>'], local: ['node', 'tools/workspace/src/bin.ts', 'check'] },
];

// ---------------------------------------------------------------------------------------------

/** The steps' commands that still hold a <placeholder>, by step name. */
export const unfilled = (steps: ReadonlyArray<Step>) =>
  steps.filter(({ command, local }) => (local ?? command).some((word) => /<[^>]+>/.test(word))).map(({ name }) => name);

/** Runs each step in order at `root`: the first failing step's exit code, or 0. */
export const run = (steps: ReadonlyArray<Step>, root: string) => {
  const took: Array<string> = [];

  for (const { name, command, local } of steps) {
    console.error(`check-static: ${name} started`);
    const start = performance.now();
    const [program, ...args] = local ?? command;
    const { status, signal, error } = spawnSync(program, args, { cwd: root, stdio: 'inherit' });
    const seconds = `${((performance.now() - start) / 1000).toFixed(1)}s`;
    took.push(`${name} ${seconds}`);

    if (status !== 0) {
      const why = error?.message ?? (signal === null ? `exit ${String(status)}` : `killed by ${signal}`);
      console.error(`check-static: ${name} failed after ${seconds}, ${why}. Took: ${took.join(', ')}`);

      return status ?? 1;
    }

    console.error(`check-static: ${name} passed in ${seconds}`);
  }

  console.error(`check-static: passed. Took: ${took.join(', ')}`);

  return 0;
};

/** The commit the branch at `root` left `branch` from. */
export const baseOf = (root: string, branch = defaultBranch) =>
  execFileSync('git', ['merge-base', branch, 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

if (argv[1] === fileURLToPath(import.meta.url)) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: cwd(), encoding: 'utf8' }).trim();
  const base = baseOf(root);
  const steps = staticSteps(base);
  const left = unfilled(steps);

  if (left.length > 0) {
    console.error(`check-static: fill in the <placeholders> of ${left.join(', ')} in staticSteps first.`);
    exit(2);
  }

  console.error(`check-static: from ${base.slice(0, 9)}, the merge base with ${defaultBranch}, to HEAD`);
  exit(run(steps, root));
}
