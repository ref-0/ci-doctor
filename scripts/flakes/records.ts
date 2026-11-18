/**
 * records.ts: the one-line JSON records CI prints into job logs, and how to read them back.
 *
 * Runs: imported by `flake-issues.ts`, `../budgets/ci-health.ts`, `../sweeps/sweep-bisect.ts` and
 * `../reuse/merge-pass.ts`. Nothing runs it directly.
 * Configure: `recordPrefix`, if you want another marker. Every writer and reader shares it, the
 * reporter `../records/test-record.ts` (`RECORD_PREFIX`) too.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * Records go to job logs, not artifacts: a log counts against no storage quota, and GitHub keeps
 * it for 90 days (docs/pages/13-records-evidence-of-what-ran.md). Two kinds:
 * - `tests`: one per test-runner invocation, from `../records/test-record.ts`: each file that ran,
 *   with its state and time, each failed test, and each test that passed only on a retry.
 * - `plan`: one per run, printed by your plan job, with what it chose. A step like this prints it:
 *
 *       jq -cn --arg sha "$SHA" --argjson pr "${PR:-null}" --argjson packages "$PACKAGES" \
 *         '{kind: "plan", event: env.EVENT, pr: $pr, sha: $sha, base: null, changed: null,
 *           packages: $packages, sandbox: []}' | sed 's/^/ci-record /'
 *
 *   `sha` is the commit the run tested (a pull request's merge commit), `packages` the test paths
 *   chosen or null for everything, and `sandbox` any separately-run heavy files it chose.
 */

/** What starts each record's line in a job's log. */
export const recordPrefix = 'ci-record ';

/** What one test-runner invocation in a job ran, and what failed. */
export interface TestsRecord {
  readonly kind: 'tests';
  /** Each file the run ran: its path from the repo's root, its state and its time in ms. */
  readonly files: ReadonlyArray<readonly [string, string, number]>;
  /** Each test that failed: its file and its full name. */
  readonly failed: ReadonlyArray<readonly [string, string]>;
  /** Each test that failed and then passed when it ran again, with how many times it ran again. */
  readonly flaky: ReadonlyArray<readonly [string, string, number]>;
  /** Errors outside any test, such as one thrown after a test ended. */
  readonly errors: number;
}

/** What a run's plan chose, as its plan job prints it. */
export interface PlanRecord {
  readonly kind: 'plan';
  readonly event: string;
  readonly pr: number | null;
  /** The commit checked: a pull request's merge into main. */
  readonly sha: string;
  /** A sweep's last passing commit, which its changes are measured from. */
  readonly base: string | null;
  /** The paths the changes touch, or null for a run by hand. */
  readonly changed: ReadonlyArray<string> | null;
  /** The ordinary tests' packages and files, or null for the whole workspace. */
  readonly packages: ReadonlyArray<string> | null;
  /** Heavy files run in jobs of their own, such as container tests. */
  readonly sandbox: ReadonlyArray<string>;
  /** Selected test paths and their rule. Absent in older plans. */
  readonly test_selection?: Readonly<Record<string, string>>;
}

export type CiRecord = TestsRecord | PlanRecord;

const isText = (value: unknown): value is string => typeof value === 'string';

const isTexts = (value: unknown): value is ReadonlyArray<string> => Array.isArray(value) && value.every(isText);

const isTestSelection = (value: unknown) =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  Object.values(value).every((reason) => isText(reason) && /^[a-z][a-z0-9-]*$/.test(reason));

const isTuple = (value: unknown, shape: ReadonlyArray<'s' | 'n'>) =>
  Array.isArray(value) &&
  value.length === shape.length &&
  shape.every((kind, index) => (kind === 's' ? isText(value[index]) : Number.isFinite(value[index])));

const isTuples = (value: unknown, shape: ReadonlyArray<'s' | 'n'>) =>
  Array.isArray(value) && value.every((each) => isTuple(each, shape));

/** A record's JSON, checked field by field, or undefined for a line this doesn't recognise. */
export const decodeRecord = (text: string): CiRecord | undefined => {
  let value: Record<string, unknown>;

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return undefined;

    value = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }

  if (value['kind'] === 'tests') {
    const ok =
      isTuples(value['files'], ['s', 's', 'n']) &&
      isTuples(value['failed'], ['s', 's']) &&
      isTuples(value['flaky'], ['s', 's', 'n']) &&
      Number.isFinite(value['errors']);

    return ok ? (value as unknown as TestsRecord) : undefined;
  }

  if (value['kind'] === 'plan') {
    const ok =
      isText(value['event']) &&
      (value['pr'] === null || Number.isFinite(value['pr'])) &&
      isText(value['sha']) &&
      (value['base'] === null || isText(value['base'])) &&
      (value['changed'] === null || isTexts(value['changed'])) &&
      (value['packages'] === null || isTexts(value['packages'])) &&
      (value['sandbox'] === undefined || isTexts(value['sandbox'])) &&
      (value['test_selection'] === undefined || isTestSelection(value['test_selection']));

    return ok ? ({ sandbox: [], ...value } as unknown as PlanRecord) : undefined;
  }

  return undefined;
};

/**
 * Each record printed in a job's log, in order. A line that only names the prefix, such as the
 * step's own script echoed into the log, is skipped.
 */
export const recordsIn = (log: string): ReadonlyArray<CiRecord> =>
  log.split('\n').flatMap((line) => {
    const at = line.indexOf(recordPrefix);
    if (at === -1) return [];

    const record = decodeRecord(line.slice(at + recordPrefix.length).trim());

    return record === undefined ? [] : [record];
  });

/** A record as one line of a log. */
export const recordLine = (record: CiRecord) => `${recordPrefix}${JSON.stringify(record)}\n`;
