/**
 * test-groups.ts: which test files may be replayed from a task cache, and the groups they run in.
 * Each group is one task: one Vitest process over a few files, cached by its inputs.
 *
 * Where it runs: imported by `test-shards.ts` (CI's plan job) and `test-lanes.ts` (each shard, and
 * locally). Node's own modules only, since a plan job may install nothing.
 *
 * Why groups are stable: a group's task is named by its files (`test-tasks.ts`), and the remote
 * cache keeps one result per task. So every run forms its groups from every test file in the
 * checkout, never from the files it was asked for. Then a shard's groups match the default branch's,
 * and a pull request replays the default branch's passes. A covered-only file is a group alone, as
 * `COVERED_ONLY` says.
 *
 * Configure: the config block below (`CACHED_AREAS`, `NEVER_CACHED`, `ORDINARY`, `LEFT_OUT`, `COVERED_ONLY`,
 * `SERVER_DIR` and the two groupings).
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { dirname } from 'node:path';

// ---- Config -------------------------------------------------------------------------------------

/**
 * The folders whose test files may be replayed. Add a folder only after reading its tests for what
 * they depend on outside the checkout.
 */
export const CACHED_AREAS: ReadonlyArray<string> = ['<app-dir>/', '<server-dir>/', 'packages/'];

/**
 * Test files inside `CACHED_AREAS` that run every time, and why: a pass that can turn into a
 * failure with nothing in the checkout changed. A test that reads the clock only to bound a wait,
 * or to name today's bucket, passes on any day, so it can be cached. The entries are examples of
 * the kinds we found; replace them with yours.
 */
export const NEVER_CACHED: ReadonlyMap<string, string> = new Map([
  // What the machine has installed, outside the checkout, so no input of the task changes with it.
  ['<app-dir>/src/browser.test.ts', "runs the machine's browser"],
  // A child's exact environment, to which the task runner's file tracking adds its own variables.
  ['<server-dir>/src/launcher.test.ts', "checks a child's whole environment"],
  // Reads the listing of the folder the checkout is in, which changes as other worktrees come and go.
  ['packages/example/src/checkout-listing.test.ts', "lists the checkout's own folder"],
  // Properties with no fixed seed, which check new cases each run.
  ['packages/example/src/properties.test.ts', 'samples a property'],
]);

/**
 * What your ordinary Vitest project runs. Sandbox and proof files run elsewhere. Keep it equal to
 * the workflow's `ORDINARY_TESTS` and the planner's `testFile`, so the plan never counts a file
 * the runner ignores.
 */
export const ORDINARY = (file: string) =>
  /\.test\.tsx?$/.test(file) &&
  !/\.(sandbox|proof)\.test\.tsx?$/.test(file) &&
  !file.split('/').some((part) => part === 'node_modules' || part === 'dist');

/** A test file that isn't ordinary, which a run leaves out: a container's or a proof's. */
export const LEFT_OUT = (file: string) => /\.(sandbox|proof)\.test\.tsx?$/.test(file);

/**
 * The covered-only test files and folders, the keys of the planner's `coveredOnly`: keep the two
 * equal. Each file under one is a group alone. A test runs with all its group, so a covered-only
 * file that shared a folder's group ran whenever that group ran, though the plan left it out: two
 * slow oracles did, in every full run that missed their group's cache.
 */
export const COVERED_ONLY: ReadonlyArray<string> = [
  // '<server-dir>/src/pack-ceiling.test.ts',
  // '<server-dir>/verification/',
];

/** Whether `file` is covered-only: listed itself, or under a listed folder. */
export const isCoveredOnly = (file: string, coveredOnly: ReadonlyArray<string> = COVERED_ONLY) =>
  coveredOnly.some((path) => file === path || (path.endsWith('/') && file.startsWith(path)));

/**
 * The folder whose test files each start a heavy harness (a local server, a database, a Worker
 * runtime). Each took over ten times as long as an ordinary file, so CI runs each alone.
 */
export const SERVER_DIR = '<server-dir>/';

// -------------------------------------------------------------------------------------------------

/** Whether a file's pass may be replayed. */
export const cacheable = (file: string) =>
  CACHED_AREAS.some((area) => file.startsWith(area)) && !NEVER_CACHED.has(file);

/** Whether a file is one of the heavy harness's. */
export const isServerFile = (file: string) => file.startsWith(SERVER_DIR);

/**
 * The other test files Vitest runs when given `file`: it matches a path as part of a path, so
 * `scripts/a.test.ts` would also run `apps/x/scripts/a.test.ts`. Pass exact files through an
 * include list instead of positional filters when this matters.
 */
export const alsoMatched = (file: string, files: ReadonlyArray<string>) =>
  files.filter((other) => other !== file && other.toLowerCase().includes(file.toLowerCase()));

/**
 * A group of test files, one task: replayed when `cached` and nothing it read changed, its Vitest
 * running `workers` of them at once.
 */
export interface TestGroup {
  readonly files: ReadonlyArray<string>;
  readonly cached: boolean;
  readonly workers: number;
}

/** How a run groups its files: how many to a group in each folder, and each group's workers. */
export interface Grouping {
  readonly size: (folder: string) => number;
  readonly workers: number;
}

/** A local run: 4 files to a group, two at once, sharing the machine's test slots. */
export const localGrouping: Grouping = { size: () => 4, workers: 2 };

/**
 * A run in CI, whose shards run one lane per worker (`test-lanes.ts`'s `--lanes`). A group costs
 * seconds to start, and a group's second worker waited on its slowest file: in one run, lanes were
 * held almost as long as their tests ran. So one worker each, a server file alone, and the rest 8 to
 * a group. Modelled on that run's times, a shard ran about a fifth faster than with 4 to a group on
 * two workers, though slower than one Vitest process (which can't be cached per group).
 */
export const ciGrouping: Grouping = {
  size: (folder) => (`${folder}/`.startsWith(SERVER_DIR) ? 1 : 8),
  workers: 1,
};

/** The grouping for a run with `env`: CI's when `CI` is set, as it is in every CI job. */
export const groupingFor = (env: Readonly<Record<string, string | undefined>>) =>
  env['CI'] === undefined || env['CI'] === '' ? localGrouping : ciGrouping;

/**
 * Groups of `grouping`'s sizes, each from one folder, in order, cached or not. A covered-only file
 * is a group alone.
 */
export const groupsOf = (
  files: ReadonlyArray<string>,
  grouping: Grouping = groupingFor(process.env),
  coveredOnly: ReadonlyArray<string> = COVERED_ONLY,
): Array<TestGroup> => {
  const folders = new Map<string, Array<string>>();

  for (const file of [...files].sort()) {
    const key = isCoveredOnly(file, coveredOnly) ? `\0${file}` : `${String(cacheable(file))}\0${dirname(file)}`;
    folders.set(key, [...(folders.get(key) ?? []), file]);
  }

  return [...folders.values()].flatMap((inFolder) => {
    const size = grouping.size(dirname(inFolder[0] ?? ''));

    return Array.from({ length: Math.ceil(inFolder.length / size) }, (_, index) => {
      const group = inFolder.slice(index * size, (index + 1) * size);

      return {
        files: group,
        cached: cacheable(group[0] ?? ''),
        workers: Math.min(group.length, grouping.workers),
      };
    });
  });
};

/** The groups of `groups` that hold any of `files`, in order. */
export const groupsWith = (groups: ReadonlyArray<TestGroup>, files: Iterable<string>) => {
  const wanted = new Set(files);

  return groups.filter((group) => group.files.some((file) => wanted.has(file)));
};
