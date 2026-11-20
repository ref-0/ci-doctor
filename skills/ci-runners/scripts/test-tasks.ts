/**
 * test-tasks.ts: the ordinary tests as Vite Task tasks, one per group of test files, so a run
 * replays each group whose inputs haven't changed, from this machine's task cache or a remote one
 * (`../local/task-cache.ts`), and runs the rest. `test-lanes.ts` runs them.
 *
 * Where it runs: imported by your root `vite.config.ts`, only when `TEST_TASKS` holds a request,
 * which `test-lanes.ts` writes into each `vp run`'s environment:
 *
 *     const request = process.env.TEST_TASKS;
 *     const tasks = request ? (await import('./scripts/shards/test-tasks.ts')).testTasks(request) : [];
 *     export default defineConfig({ run: { tasks: Object.fromEntries(tasks) } });
 *
 * Why the details below matter:
 *   - Each task's Vitest loads a test-only config (`TEST_CONFIG`), not `vite.config.ts`, so an edit
 *     to lint's settings or another task moves no test's key. And it looks for its own files alone
 *     (`TEST_INCLUDE`), so a file added outside its folder moves no key either. Of 1,030 commits on
 *     the default branch in two weeks, 538 moved every key before this, and about 48 after.
 *   - A cached task's inputs are what Vite Task saw it read (`{ auto: true }` tracks reads in every
 *     process it starts), but for the caches that change with no change to the code (`volatile`).
 *   - Vite Task runs a task with only the variables it names, and those that change a pass are part
 *     of its key (`env`). Those that don't, such as where records go, are `untrackedEnv`.
 *   - It restores no output: a test's pass is the whole result.
 *
 * Configure: `TEST_CONFIG`, `WORKSPACE_READERS`, the `env` and `untrackedEnv` lists, and how
 * `packageFolders` finds your packages.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { createHash } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TestGroup } from './test-groups.ts';

// ---- Config -------------------------------------------------------------------------------------

/** The Vitest config each task loads: the test settings alone, without lint's or the tasks'. */
export const TEST_CONFIG = 'test.config.ts';

/**
 * Test files whose pass reads `pnpm-workspace.yaml` itself, so their groups keep it as an input,
 * and why. Read your tests for it: most name it only in a fixture, or run `pnpm exec`.
 */
export const WORKSPACE_READERS: ReadonlyMap<string, string> = new Map([
  ['packages/example/src/pack.test.ts', "packs a package, whose `catalog:` versions pnpm reads from it"],
]);

/**
 * What changes a pass, which Vite Task passes only when it's named, and keys on: CI's flag, colour,
 * a failed test's retries, fuzz runs and seed, your harness's overrides. And what Vite Task passes
 * unnamed but leaves out of the key: the time zone and the locale, since a date a test formats falls
 * on another day in another zone, and `NODE_OPTIONS`, whose `--conditions` picks another build of a
 * package. Not `PATH` or `HOME`, which would key a pass to one machine.
 */
export const KEYED_ENV: ReadonlyArray<string> = [
  'CI',
  'LANG',
  'LANGUAGE',
  'LC_*',
  'NODE_OPTIONS',
  'NO_COLOR',
  'TEST_RETRY',
  'TZ',
];

/**
 * Passed through, but no part of the key: the machine's test slots' cap and log, which change when
 * a file waits, not what it passes; what CI's runs record (`../records/test-record.ts`); and
 * `TMPDIR`, where a test's temporary files go. Vite Task passes `TMP` and `TEMP` unnamed, but not
 * `TMPDIR`, so without it a run that sets one still filled `/tmp`.
 */
export const UNTRACKED_ENV: ReadonlyArray<string> = [
  'CI_JOB',
  'CI_RECORD',
  'TEST_FLAKES_FILE',
  'TEST_RECORDS',
  'TEST_SLOTS',
  'TMPDIR',
  'XDG_STATE_HOME',
];

// -------------------------------------------------------------------------------------------------

/** A task, as Vite Task's `run.tasks` takes one. */
export interface TestTask {
  readonly command: string;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly cache:
    | false
    | {
        readonly env: ReadonlyArray<string>;
        readonly untrackedEnv: ReadonlyArray<string>;
        readonly input: ReadonlyArray<string | { auto: true }>;
        readonly output: ReadonlyArray<string>;
      };
}

/** `test-lanes.ts`'s request: every group to run. */
export interface TestRequest {
  readonly groups: ReadonlyArray<TestGroup>;
}

/** The task that runs every group, as `vp run test-cache` names it. */
export const allTask = 'test-cache';

/**
 * The install's files every task reads and no pass depends on: `pnpm-workspace.yaml`, which `vp`
 * reads to find the workspace before it starts Vitest, and pnpm's own copy of the lockfile, from
 * which Vitest hashes its module cache's folder. A test reads a package through its importer's
 * `node_modules` link and that package's `package.json`, so a version bump still moves exactly the
 * tasks that load the package. The root `pnpm-lock.yaml` stays an input wherever a test reads it.
 */
const installFiles = ['!pnpm-workspace.yaml', '!node_modules/.pnpm/lock.yaml'];

/** What a group leaves out of `installFiles`: all of them, but the workspace file for a reader. */
const installFilesOf = (group: TestGroup) =>
  group.files.some((file) => WORKSPACE_READERS.has(file))
    ? installFiles.filter((file) => file !== '!pnpm-workspace.yaml')
    : installFiles;

/**
 * What every cached task leaves out of what it read: caches that change with no code change, and
 * Wrangler's `.wrangler/`, whose `tmp/` holds a folder for each harness while it runs. And the
 * listings of the folders tests and builds add to: each `node_modules`, which gains `.cache` and
 * `.vite-temp`, and each package's, which gains `.wrangler` and `dist`. And pnpm's store, whose
 * listing holds what earlier lockfiles installed, as an install never prunes it, so it differs
 * between two checkouts at one lockfile.
 *
 * Vite Task still counts an excluded folder's name in its parent's listing, so leaving out a
 * folder's files alone misses a task when a test makes the folder. A folder's own path, excluded,
 * leaves its listing out and still tracks each file read under it. So a test that lists a package's
 * folder belongs in `NEVER_CACHED` (`test-groups.ts`). Give a harness its package's folder as its
 * root, never the checkout's, whose listing every task reads.
 *
 * And a build's `dist/` folders, which a test reads only as a build it made from the source it also
 * reads: every group that read one passed with each `dist/` moved aside. A test whose pass needs a
 * `dist/` it didn't build belongs in `NEVER_CACHED`.
 */
export const volatile = (packages: ReadonlyArray<string>) => [
  '!**/node_modules/.vite/**',
  '!**/node_modules/.vitest-cache/**',
  '!**/node_modules/.cache/**',
  '!**/.wrangler/**',
  '!**/dist',
  '!**/dist/**',
  '!**/node_modules',
  '!**/node_modules/.pnpm',
  ...packages.map((folder) => `!${folder}`),
];

/**
 * The patterns of `pnpm-workspace.yaml`'s `packages:` list, read without a YAML library: one
 * `- pattern` per line under the key, quoted or not. Use a YAML parser if yours is fancier.
 */
export const workspacePatterns = (yaml: string) => {
  const patterns = new Array<string>();
  let inPackages = false;

  for (const line of yaml.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }

    if (inPackages && /^\S/.test(line)) break;

    const item = inPackages ? /^\s+-\s+['"]?([^'"#\s]+)['"]?/.exec(line)?.[1] : undefined;
    if (item !== undefined) patterns.push(item);
  }

  return patterns;
};

/** The workspace's package folders, such as `apps/web`, as `pnpm-workspace.yaml` names them. */
export const packageFolders = (root: string) =>
  globSync(
    workspacePatterns(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))
      .filter((pattern) => !pattern.startsWith('!'))
      .map((pattern) => `${pattern}/package.json`),
    { cwd: root },
  )
    .map(dirname)
    .toSorted();

/** A group's task name: a hash of its files, so it stays while they do. */
export const taskName = (files: ReadonlyArray<string>) =>
  `test-cache:${createHash('sha256').update(files.join('\0')).digest('hex').slice(0, 16)}`;

const quote = (file: string) => `'${file.replaceAll("'", `'"'"'`)}'`;

/** One group's task, given the workspace's package folders. */
export const groupTask = (group: TestGroup, packages: ReadonlyArray<string> = []): TestTask => {
  const files = group.files.map(quote).join(' ');
  // `vp test` through Node, not as Vite+'s built-in: Vite Task keyed a built-in by the absolute path
  // of Vite+'s entry in the checkout, so another worktree never replayed it. Check whether that
  // still holds in your version. Without `FORCE_COLOR`, which Vite Task sets in a cached task, so
  // tests of coloured output see what a plain run sees. With `TEST_INCLUDE`, so its Vitest looks
  // for its own files alone (wire `include` to it in your test config).
  const vitest = `node node_modules/vite-plus/bin/vp test run --config ${TEST_CONFIG} --maxWorkers=${group.workers}`;
  const command = `env -u FORCE_COLOR TEST_INCLUDE=${quote(group.files.join(' '))} ${vitest} ${files}`;
  if (!group.cached) return { command, cache: false };

  return {
    command,
    cache: {
      env: KEYED_ENV,
      untrackedEnv: UNTRACKED_ENV,
      input: [{ auto: true }, ...volatile(packages), ...installFilesOf(group)],
      output: [],
    },
  };
};

const isGroup = (value: unknown): value is TestGroup => {
  if (typeof value !== 'object' || value === null) return false;

  const group = value as Record<string, unknown>;
  const files = group['files'];

  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.every(
      (file) =>
        typeof file === 'string' &&
        /^(?:[\w@-][\w.@-]*\/)*[\w@-][\w.@-]*\.test\.tsx?$/u.test(file),
    ) &&
    typeof group['cached'] === 'boolean' &&
    Number.isSafeInteger(group['workers']) &&
    (group['workers'] as number) > 0
  );
};

/** Reads a request from JSON: test files in the checkout, with no `..`, each in one group. */
export const parseRequest = (raw: string): TestRequest => {
  const request: unknown = JSON.parse(raw);
  const groups = (request as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups) || !groups.every(isGroup)) {
    throw new Error('TEST_TASKS holds no groups of test files in the checkout');
  }

  const files = groups.flatMap((group) => group.files);
  const twice = files.find((file, index) => files.indexOf(file) !== index);
  if (twice !== undefined) throw new Error(`TEST_TASKS names ${twice} twice`);

  return { groups };
};

/** The tasks for `TEST_TASKS`'s request, and the one that runs them all; none without one. */
export const testTasks = (raw: string | undefined, root = fileURLToPath(new URL('../..', import.meta.url))) => {
  if (raw === undefined || raw === '') return new Map<string, TestTask>();

  const packages = packageFolders(root);
  const tasks = new Map<string, TestTask>(
    parseRequest(raw).groups.map((group) => [taskName(group.files), groupTask(group, packages)] as const),
  );

  return tasks.set(allTask, { command: 'node -e ""', dependsOn: [...tasks.keys()], cache: false });
};
