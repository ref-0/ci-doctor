/**
 * test-record.ts: a Vitest reporter that prints one line of JSON when a run ends. The line lists
 * each test file the run ran, with its state and time; each test that failed; each test that passed
 * only on a retry; and what each file spent importing, with its slowest imports.
 *
 * Where it runs: in every CI job that runs Vitest. The line goes to the job's log, which GitHub keeps
 * for 90 days and which counts against no storage quota, as an artifact would. `ci-records.ts`,
 * beside this file, reads the lines back.
 *
 * Needs: Vitest 4 or later (its reporter API's `TestModule.relativeModuleId`).
 * Configure:
 *   - Wire it into your Vitest config when `CI_RECORD=1` (see README.md), or pass
 *     `--reporter=./scripts/records/test-record.ts` on the command line.
 *   - `RECORD_PREFIX` below must match the one in `ci-records.ts`.
 *   - Environment:
 *       TEST_RECORDS      append the line to this file instead of stdout. A test-task runner that
 *                         replays cached logs sets it, so it prints only the lines of tasks that
 *                         ran: a replay must never count as a run.
 *       TEST_RECORD_FILE  also write the record as JSON to this file (one per run, overwritten).
 *       TEST_FLAKES_FILE  when a test failed or passed only on a retry, append a line to this file
 *                         (relative to the repo root) with each such test and the start of its first
 *                         error. Keep it outside the checkout if your task cache hashes the root.
 *       CI_JOB            the job's name, written into the flakes line.
 *       GITHUB_RUN_ATTEMPT the attempt, written into the flakes line.
 *
 * Why a custom reporter: Vitest's built-in JSON reporter has no retry information, so it can't tell a
 * flaky pass from a clean one.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

// Type-only: erased when Node strips types, so this file parses without Vitest installed.
import type { Reporter, TestCase, TestModule } from 'vitest/node';

// ---- Config -------------------------------------------------------------------------------------

/** What starts each record's line in a job's log. Keep it equal to `ci-records.ts`'s. */
export const RECORD_PREFIX = 'ci-record ';

/** How many of a file's slowest imports a record keeps. Set Vitest's import limit one higher. */
export const SLOWEST_IMPORTS = 5;

/** The most tests one flakes line lists. */
export const LINE_LIMIT = 50;

/** The longest error excerpt a flakes line keeps, in characters. */
export const EXCERPT_LIMIT = 1500;

// -------------------------------------------------------------------------------------------------

/** What one Vitest run in a job ran, and what failed. */
export interface TestsRecord {
  readonly kind: 'tests';
  /**
   * Each file the run ran: its path from the repo's root, its state, and Vitest's module duration
   * in ms (`diagnostic().duration`). That is the module's own test time: its collection is in
   * `imports`, and neither is the wall time of the command that ran the file. Time a file's whole
   * command separately where you pack by wall time (containers).
   */
  readonly files: ReadonlyArray<readonly [string, string, number]>;
  /** Each test that failed: its file and its full name. */
  readonly failed: ReadonlyArray<readonly [string, string]>;
  /** Each test that failed and then passed when it ran again, with how many times it ran again. */
  readonly flaky: ReadonlyArray<readonly [string, string, number]>;
  /** Errors outside any test, such as one thrown after a test ended. */
  readonly errors: number;
  /**
   * Each file's import: its path, the ms it took to import the file and run its suites' callbacks,
   * and its slowest imports, each with the ms spent in the module itself and with what it imports.
   */
  readonly imports?: ReadonlyArray<
    readonly [string, number, ReadonlyArray<readonly [string, number, number]>]
  >;
}

/** One line of the flakes file: what failed, and what passed only on a retry, with excerpts. */
export interface FlakesLine {
  readonly attempt: number;
  readonly job: string;
  readonly failed: ReadonlyArray<readonly [string, string, string]>;
  readonly flaky: ReadonlyArray<readonly [string, string, number, string]>;
}

/** Whether `value` has the shape of a `TestsRecord`. Plain checks, no schema library. */
export const isTestsRecord = (value: unknown): value is TestsRecord => {
  if (typeof value !== 'object' || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    record['kind'] === 'tests' &&
    Array.isArray(record['files']) &&
    Array.isArray(record['failed']) &&
    Array.isArray(record['flaky']) &&
    typeof record['errors'] === 'number' &&
    (record['imports'] === undefined || Array.isArray(record['imports']))
  );
};

/** A record as one line of a log. */
export const recordLine = (record: TestsRecord) => `${RECORD_PREFIX}${JSON.stringify(record)}\n`;

/** Terminal colour escapes and control characters removed. */
const plain = (text: string) =>
  // oxlint-disable-next-line no-control-regex -- the escapes a terminal's colours are written in.
  text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');

/** At most `limit` characters of `text`, marked where it was cut. */
const bounded = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

/**
 * The start of a test's first error: its message, then its stack, without frames in
 * `node_modules` or Node's own, and with paths relative to `root`.
 */
export const excerptOf = (
  errors: ReadonlyArray<{ readonly message?: string; readonly stack?: string }> | undefined,
  root = '',
) => {
  const error = errors?.[0];
  if (error === undefined) return '';

  const message = error.message ?? '';
  const stack = error.stack ?? '';
  const text = (stack.includes(message) ? stack : `${message}\n${stack}`)
    .split('\n')
    .filter((line) => !/^\s+at .*(\/node_modules\/|\(node:|<anonymous>)/.test(line))
    .join('\n');
  const relativeText =
    root === '' ? text : text.replaceAll(`file://${root}/`, '').replaceAll(`${root}/`, '');

  return bounded(plain(relativeText).trim(), EXCERPT_LIMIT);
};

/** A module's path from the repo's root, or from its package for one in `node_modules`. */
const modulePath = (id: string) => {
  const inPackages = id.lastIndexOf('/node_modules/');

  return inPackages === -1
    ? relative(process.cwd(), id)
    : id.slice(inPackages + '/node_modules/'.length);
};

/** A test file's slowest imports, without the file itself. */
const slowestOf = (module: TestModule) =>
  Object.entries(module.diagnostic().importDurations ?? {})
    .filter(([id]) => id !== module.moduleId)
    .sort(([, a], [, b]) => b.totalTime - a.totalTime)
    .slice(0, SLOWEST_IMPORTS)
    .map(
      ([id, { selfTime, totalTime }]) =>
        [modulePath(id), Math.round(selfTime), Math.round(totalTime)] as const,
    );

/** A test's file and full name, with the start of its first error. */
const excerpt = (path: string, test: TestCase) =>
  [path, test.fullName, excerptOf(test.result().errors, process.cwd())] as const;

/** The run's line for the flakes file: what failed, and what passed only on a retry. */
export const flakesLine = (
  tests: ReadonlyArray<{ readonly path: string; readonly test: TestCase }>,
  job: string,
  attempt: number,
): FlakesLine => ({
  attempt,
  job,
  failed: tests
    .filter(({ test }) => test.result().state === 'failed')
    .slice(0, LINE_LIMIT)
    .map(({ path, test }) => excerpt(path, test)),
  flaky: tests
    .flatMap(({ path, test }) => {
      const diagnostic = test.diagnostic();
      if (diagnostic?.flaky !== true) return [];

      const [file, name, first] = excerpt(path, test);

      return [[file, name, diagnostic.retryCount, first] as const];
    })
    .slice(0, LINE_LIMIT),
});

const env = (name: string) => {
  const value = process.env[name];

  return value === undefined || value === '' ? undefined : value;
};

export default class TestRecord implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>, errors: ReadonlyArray<unknown>) {
    const tests = modules.flatMap((module) =>
      [...module.children.allTests()].map((test) => ({ path: module.relativeModuleId, test })),
    );

    const record: TestsRecord = {
      kind: 'tests',
      files: modules.map((module) => [
        module.relativeModuleId,
        module.state(),
        Math.round(module.diagnostic().duration),
      ]),
      failed: tests.flatMap(({ path, test }) =>
        test.result().state === 'failed' ? [[path, test.fullName] as const] : [],
      ),
      flaky: tests.flatMap(({ path, test }) => {
        const diagnostic = test.diagnostic();

        return diagnostic?.flaky === true
          ? [[path, test.fullName, diagnostic.retryCount] as const]
          : [];
      }),
      errors: errors.length,
      imports: modules.map((module) => [
        module.relativeModuleId,
        Math.round(module.diagnostic().collectDuration),
        slowestOf(module),
      ]),
    };

    const records = env('TEST_RECORDS');
    if (records === undefined) process.stdout.write(recordLine(record));
    else appendFileSync(records, recordLine(record));

    const file = env('TEST_RECORD_FILE');
    if (file !== undefined) writeFileSync(file, JSON.stringify(record));

    const flakes = env('TEST_FLAKES_FILE');
    if (flakes === undefined || (record.failed.length === 0 && record.flaky.length === 0)) return;

    const line = flakesLine(tests, env('CI_JOB') ?? '', Number(env('GITHUB_RUN_ATTEMPT') ?? '1'));
    // Relative paths are from the directory Vitest runs in, the repo's root.
    appendFileSync(resolve(process.cwd(), flakes), `${JSON.stringify(line)}\n`);
  }
}
