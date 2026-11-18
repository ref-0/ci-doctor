/**
 * check.ts: the local check, split so it's light on a shared machine. The steps before lint (the
 * types, say), then format and lint without types over every file, then the type-aware rules on
 * the files changed since the branch left its base, committed or not. Every step runs, so one run
 * shows every error, and the check fails if any did.
 *
 *     node tools/workspace/src/bin.ts check [--fix]
 *
 * Runs: locally, as the repo's `check` script. CI lints every file with types instead, since a
 * type change can trip a rule in a file the change didn't touch.
 * Configure: `lint` in `workspace-tools.json`: the base, which files count, and the commands. The
 * defaults are Vite+'s, through two cached tasks, `lint:workspace` and `lint:files`. `--fix` writes
 * files, so its passes run the fix commands, fresh, never a cached task.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * Why split: type-aware lint first builds every project's program, and many agents checking at
 * once on one machine each held that in memory. Untyped lint everywhere plus typed lint on the
 * changed files kept most findings for a fraction of the memory.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { type Command, type Config, words } from '../config.ts';
import { modeVariable } from './config.ts';

/** Runs one command at the root with `env`, and answers whether it passed. */
export type Runner = (command: ReadonlyArray<string>, env: NodeJS.ProcessEnv) => boolean;

const spawnRunner =
  (root: string): Runner =>
  ([program, ...args], env) => {
    if (program === undefined) return false;

    return spawnSync(program, args, { cwd: root, stdio: 'inherit', env }).status === 0;
  };

const git = (root: string, args: ReadonlyArray<string>) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/**
 * The files changed since `base`'s merge base with the working tree, new untracked ones too, that
 * still exist and `pattern` matches, from the root.
 */
export const changedFiles = (root: string, base: string, pattern: RegExp) => {
  const mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  const listed = [
    ...git(root, ['diff', '--name-only', '-z', mergeBase]).split('\0'),
    ...git(root, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0'),
  ];

  return [...new Set(listed)].filter((file) => file !== '' && pattern.test(file) && existsSync(join(root, file))).sort();
};

/** Each step's name and whether it passed, and the exit code. */
export const runCheck = (
  root: string,
  lint: Config['lint'],
  { fix, run = spawnRunner(root), changed }: { readonly fix: boolean; readonly run?: Runner; readonly changed?: ReadonlyArray<string> },
) => {
  const steps: Array<{ readonly name: string; readonly passed: boolean }> = [];
  const step = (name: string, command: Command, env: NodeJS.ProcessEnv, extra: ReadonlyArray<string> = []) => {
    steps.push({ name, passed: run([...words(command), ...extra], env) });
  };

  for (const command of lint.before) step(words(command).join(' '), command, process.env);

  step('lint, no types, every file', fix ? lint.workspaceFix : lint.workspace, { ...process.env, [modeVariable]: 'none' });

  const files = changed ?? changedFiles(root, lint.base, new RegExp(lint.files));
  console.error(`check: the type-aware rules on ${files.length} changed files`);

  if (files.length > 0) {
    const { [modeVariable]: _, ...typed } = process.env;
    step(`lint, types, ${files.length} changed files`, fix ? lint.changedFix : lint.changed, typed, files);
  }

  for (const { name, passed } of steps) console.error(`check: ${passed ? 'passed' : 'FAILED'}  ${name}`);

  return steps.every(({ passed }) => passed) ? 0 : 1;
};
