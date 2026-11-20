#!/usr/bin/env node
/**
 * review-record.ts: whether a pull request's review is on record, as the review-gate skill says.
 * CI's result job runs it on a pull request's run; an agent runs it locally to count a change, or to
 * check a session comment before posting it.
 *
 *     node review-record.ts                          # CI: reads PR, GITHUB_REPOSITORY, GITHUB_SHA, GH_TOKEN, and BASE
 *     node review-record.ts --count                  # this branch's net lines of production source, its test code,
 *                                                    # and the files the local review list covers
 *     node review-record.ts --comment <file> [--covered]
 *                                                    # a session comment you're about to post; --covered when the
 *                                                    # change touches a path the review list names
 *
 * A review is on record when a person's comment holds a session, whose first line is a session's at
 * `requiredEffort` with 1 to 8 reviewers, or when the body has a line that starts `No review:` and
 * says why.
 * - Each session's `Reviewers:` line names as many reviewers as its first line counts, each as
 *   `<type>: <scope>` with one review type, since each reviewer is a run of its own.
 * - On a pull request that changes a file the review list covers, each session names every type in
 *   `consideredTypes` on its `Reviewers:` line or, with why, on its `Not run:` line.
 * - A large change, at least `largeChange` net lines of production source, needs a session with a
 *   code quality reviewer, whatever it touches. A `No review:` line doesn't cover it.
 * - A pull request that changes test code, as `testCode` lists it, needs a session with a tests
 *   reviewer, unless its body has a `No review: low risk` line and it changes `lowRiskLines` lines
 *   or fewer of test code.
 * - A `No review:` line doesn't cover a file the review list covers, as the base branch's copy of
 *   `reviewPaths` lists them, unless it says "low risk" and the pull request changes
 *   `lowRiskLines` lines or fewer of them. Reading the base's copy means a PR can't take its own
 *   files off the list.
 *
 * It checks the record's format and reviewer types. It doesn't check that a session covers the head
 * CI tested: before merging, the review-gate skill compares the reviewed head with the current one.
 *
 * Only members' comments count: a person whose author association is one of
 * `reviewerAssociations` (OWNER, MEMBER or COLLABORATOR), as review-recheck.yml requires before it
 * reruns the check. A bot's doesn't count, and neither does an outsider's, since anyone can comment
 * on a public repo.
 *
 * Runs: in CI's result job (no install: Node 24 and `gh` only), and locally. Tests:
 * `node --test review-record.test.ts`.
 * Configure: the repo's `.agents/repo/review-record.json` (SETTINGS below): your review types, which of them every covered change considers,
 * what counts as test code and production source, the thresholds, the effort and the list's path.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// SETTINGS: the repo's, in `.agents/repo/review-record.json`
// ---------------------------------------------------------------------------------------------
// The repo owns that file, so updating this script never touches its values. Its template is the
// agent-knowledge skill's templates/repo-facts/review-record.json. It's read from
// REVIEW_SETTINGS, or from `.agents/repo/review-record.json` in the folder this runs in; CI reads
// the base branch's copy, as it does the review list. A key it leaves out keeps the default below.

/** The defaults: the source repo's values, as examples. */
export const DEFAULTS = {
  /** The review types the repo accepts, in lowercase. A session naming another fails, by its name. */
  reviewTypes: [
    'stress test',
    'red team',
    'system design',
    'bounded verification',
    'fuzzing',
    'storage',
    'program design',
    'tests',
    'code quality',
    'experiment',
    'skeptic',
  ] as ReadonlyArray<string>,
  /** The types every session names, as run or as not run with why, on a change the list covers. */
  consideredTypes: ['stress test', 'system design', 'red team', 'storage', 'program design', 'bounded verification', 'fuzzing'] as ReadonlyArray<string>,
  /**
   * Test code, as globs in the review list's form, where `*` crosses folders and a `!` line takes a
   * path off: a pull request that changes it needs a tests reviewer.
   */
  testCode: ['*.test.ts', '*.test.tsx', '*/testing/*', '*/tests/*', 'scripts/test-*.ts', '!*.gen.*'] as ReadonlyArray<string>,
  /** Production source: these extensions, outside tests, fixtures, generated files and models, as regular expressions. */
  productionExtensions: String.raw`\.(ts|tsx|rs)$`,
  notProduction: String.raw`(\.test\.|\.fuzz\.|\/tests?\/|_test\.rs|\/testing\/|\/fixtures\/|\.gen\.|\/verification\/)`,
  /** Net lines of production source from which a change is large and needs a code quality reviewer: at least this many. */
  largeChange: 300,
  /** Lines in covered files, or in test code, up to which a `No review: low risk` line covers them. */
  lowRiskLines: 20,
  /** The effort every counted session runs at. */
  requiredEffort: 'high',
  /** The review list: globs of the paths whose changes need a review, read from the base branch. */
  reviewPaths: '.agents/repo/review-paths.txt',
  /** The base branch when CI doesn't pass BASE. */
  defaultBase: 'main',
  /**
   * The comment author associations whose sessions count. Keep this the same as review-recheck.yml's
   * list, so a comment that reruns the check is one that can satisfy it.
   */
  reviewerAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'] as ReadonlyArray<string>,
};
export type Settings = typeof DEFAULTS;

/** The repo's settings over the defaults; a key the defaults don't have is an error. */
export const readSettings = (path = env.REVIEW_SETTINGS ?? '.agents/repo/review-record.json'): Settings => {
  if (!existsSync(path)) return DEFAULTS;
  const given = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const unknown = Object.keys(given).filter((key) => !(key in DEFAULTS));
  if (unknown.length) throw new Error(`${path}: unknown settings ${unknown.join(', ')}`);
  return { ...DEFAULTS, ...given } as Settings;
};

const SETTINGS = readSettings();
export const reviewTypes = SETTINGS.reviewTypes;
export const consideredTypes = SETTINGS.consideredTypes;
export const testCode = SETTINGS.testCode;
export const productionExtensions = new RegExp(SETTINGS.productionExtensions);
export const notProduction = new RegExp(SETTINGS.notProduction);
export const largeChange = SETTINGS.largeChange;
export const lowRiskLines = SETTINGS.lowRiskLines;
export const requiredEffort = SETTINGS.requiredEffort;
export const reviewPaths = SETTINGS.reviewPaths;
export const defaultBase = SETTINGS.defaultBase;
export const reviewerAssociations = SETTINGS.reviewerAssociations;

// ---------------------------------------------------------------------------------------------

const escapeRegExp = (text: string) => text.replace(/[\\^$.|+()[\]{}*?]/g, '\\$&');

const sessionLine = new RegExp(
  `^## Review: [^,]+, ${escapeRegExp(requiredEffort)}, (?:([2-8]) reviewers|(1) reviewer), [0-9]+ rounds?, (?:clean|open) at [0-9a-f]{7,40}$`,
);

const noReviewLine = /^(?:[-*] )?(?:\*\*)?No review:(?:\*\*)?[ \t]*\S.*$/m;

const lowRisk = /No review:(?:\*\*)?\s*[Ll]ow risk/;

/** A changed file, as GitHub's `pulls/<n>/files` lists it, in the fields read here. */
export interface Change {
  readonly filename: string;
  readonly additions: number;
  readonly deletions: number;
  readonly previous_filename?: string;
}

/** Whether a path is production source, as a large change is counted. */
export const isProductionSource = (path: string) => productionExtensions.test(path) && !notProduction.test(path);

/** A change's net lines of production source: lines added less lines deleted. */
export const netProductionLines = (changes: ReadonlyArray<Change>) =>
  changes.filter((change) => isProductionSource(change.filename)).reduce((sum, change) => sum + change.additions - change.deletions, 0);

/** A bash glob as a regular expression, where `*` also matches `/`, as `[[ $file == $glob ]]` does. */
const globPattern = (glob: string) => new RegExp(`^${escapeRegExp(glob).replaceAll('\\*', '.*').replaceAll('\\?', '.')}$`);

/** Whether a list covers a path: a line matches it and no `!` line takes it off. `#` starts a comment. */
export const coveredBy = (list: string) => {
  const lines = list
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  const included = lines.filter((line) => !line.startsWith('!')).map(globPattern);
  const excluded = lines.filter((line) => line.startsWith('!')).map((line) => globPattern(line.slice(1)));

  return (path: string) => included.some((pattern) => pattern.test(path)) && !excluded.some((pattern) => pattern.test(path));
};

/** Whether a path is test code, as `testCode` lists it. */
export const isTestCode = coveredBy(testCode.join('\n'));

/**
 * The changed files a list matches, with their lines. A file renamed away from one counts its lines
 * there, once, so a move doesn't drop its edits.
 */
const filesIn = (changes: ReadonlyArray<Change>, matches: (path: string) => boolean) =>
  changes.flatMap((change) => {
    const lines = change.additions + change.deletions;
    if (matches(change.filename)) return [{ file: change.filename, lines }];

    return change.previous_filename !== undefined && matches(change.previous_filename) ? [{ file: change.previous_filename, lines }] : [];
  });

/** The entries of a session's line that starts with `label`, split on `; `, or none without one. */
const entriesOf = (body: string, label: string) => {
  const line = body.split('\n').find((text) => text.startsWith(`${label}:`));
  if (line === undefined) return undefined;

  return line
    .slice(label.length + 1)
    .split('; ')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
};

/** An entry's type, when it starts with one of the review types and a colon, then says something. */
const typeOf = (entry: string) =>
  reviewTypes.find((type) => entry.toLowerCase().startsWith(`${type}:`) && entry.slice(type.length + 1).trim() !== '');

/** Why an entry with no accepted type is refused, by the type it names when it names one. */
const refusal = (entry: string, label: string, form: string) => {
  const named = /^([a-z][a-z -]*):\s*\S/i.exec(entry)?.[1]?.trim().toLowerCase();
  if (named === undefined || reviewTypes.includes(named)) return undefined;

  return `the ${label} "${entry}" names the type "${named}", which isn't one this repo accepts: add it to reviewTypes in .agents/repo/review-record.json, or use one of ${reviewTypes.join(', ')} as "${form}"`;
};

/** A session comment, read. */
export interface Session {
  readonly head: string;
  readonly reviewers: ReadonlyArray<string>;
  readonly notRun: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<string>;
}

/** Whether a comment's first line is a session's. */
export const isSession = (comment: string) => sessionLine.test(comment.replace(/\r/g, '').split('\n')[0] ?? '');

/** A session comment's types run and not run, and what's wrong with its lines. */
export const readSession = (comment: string, covered: boolean): Session => {
  const body = comment.replace(/\r/g, '');
  const head = body.split('\n')[0] ?? '';
  const match = sessionLine.exec(head);
  const counted = Number(match?.[1] ?? match?.[2] ?? 0);
  const problems: Array<string> = [];

  if (match === null)
    problems.push(`its first line isn't "## Review: <model>, ${requiredEffort}, <k> reviewers, <n> rounds, <clean|open> at <short sha>", with 1 to 8 reviewers`);

  const reviewerEntries = entriesOf(body, 'Reviewers') ?? [];
  if (reviewerEntries.length === 0) problems.push('it has no "Reviewers:" line');
  else if (match !== null && reviewerEntries.length !== counted)
    problems.push(`its "Reviewers:" line names ${reviewerEntries.length}, joined by "; ", where its first line counts ${counted}`);

  const reviewers = reviewerEntries.flatMap((entry) => {
    const type = typeOf(entry);
    if (type !== undefined) return [type];

    problems.push(refusal(entry, 'reviewer', '<type>: <scope>') ?? `the reviewer "${entry}" doesn't start "<type>: <scope>" with one review type: each type is a run of its own`);
    return [];
  });

  const notRun = (entriesOf(body, 'Not run') ?? []).flatMap((entry) => {
    const type = typeOf(entry);
    if (type !== undefined) return [type];

    problems.push(refusal(entry, '"Not run:" entry', '<type>: <why>') ?? `the "Not run:" entry "${entry}" doesn't start "<type>: <why>" with a review type`);
    return [];
  });

  const missing = covered ? consideredTypes.filter((type) => !reviewers.includes(type) && !notRun.includes(type)) : [];
  if (missing.length > 0) problems.push(`it names neither as run nor, on its "Not run:" line with why, ${missing.join(', ')}`);

  return { head, reviewers, notRun, problems };
};

/** What a pull request's review on record needs, from what GitHub shows of it. */
export interface ReviewRecord {
  /** The bodies of people's comments on it. */
  readonly comments: ReadonlyArray<string>;
  readonly body: string;
  readonly changes: ReadonlyArray<Change>;
  /** The base branch's copy of the review list. */
  readonly list: string;
}

export type Verdict = { readonly ok: true; readonly why: string } | { readonly ok: false; readonly errors: ReadonlyArray<string> };

/** Whether the review is on record: what passed it, or each reason it isn't. */
export const verdict = (record: ReviewRecord): Verdict => {
  const covered = filesIn(record.changes, coveredBy(record.list));
  const net = netProductionLines(record.changes);
  const large = net >= largeChange;

  const tests = filesIn(record.changes, isTestCode);
  const testLines = tests.reduce((sum, file) => sum + file.lines, 0);
  const testFiles = tests.map((file) => file.file).join(' ');
  const reason = noReviewLine.exec(record.body.replace(/\r/g, ''))?.[0];
  const testsLowRisk = reason !== undefined && lowRisk.test(reason) && testLines <= lowRiskLines;
  const needsTests = tests.length > 0 && !testsLowRisk;
  const testsNeeded = `This pull request changes ${testLines} lines of test code: ${testFiles}.`;
  const testsFix =
    testLines <= lowRiskLines
      ? `Run a review with a tests reviewer and post its session comment, or add a "No review: low risk" line to the body, which covers ${lowRiskLines} lines of test code or fewer.`
      : `A "No review:" line covers test code only when it says "low risk" and it changes ${lowRiskLines} lines or fewer, so run a review with a tests reviewer and post its session comment.`;

  const comments = record.comments.map((comment) => comment.replace(/\r/g, ''));
  const sessions = comments.filter(isSession).map((comment) => readSession(comment, covered.length > 0));
  const lookalikes = comments.map((comment) => comment.split('\n')[0] ?? '').filter((head) => /^#* *Review:/i.test(head) && !sessionLine.test(head));
  const errors: Array<string> = lookalikes.map(
    (head) => `"${head}" starts like a session's first line but isn't one: copy it from the review reference, filled in, at ${requiredEffort}, with 1 to 8 reviewers.`,
  );

  if (sessions.length > 0) {
    for (const session of sessions) for (const problem of session.problems) errors.push(`The session "${session.head}": ${problem}.`);

    if (large && !sessions.some((session) => session.reviewers.includes('code quality')))
      errors.push(`This change adds ${net} net lines of production source, at least ${largeChange}, so a session needs a code quality reviewer on its "Reviewers:" line.`);

    if (needsTests && !sessions.some((session) => session.reviewers.includes('tests')))
      errors.push(`${testsNeeded} Add a tests reviewer to a session's "Reviewers:" line: a pull request that changes test code needs one.`);

    const onRecord = `${sessions.length} session${sessions.length === 1 ? '' : 's'} on record`;

    return errors.length === 0 ? { ok: true, why: needsTests ? `${onRecord}, with a tests reviewer for ${testLines} lines of test code` : onRecord } : { ok: false, errors };
  }

  if (reason === undefined)
    return {
      ok: false,
      errors: [
        ...errors,
        `No review on record. Post the review's session comment, whose first line is "## Review: <model>, ${requiredEffort}, <k> reviewers, <n> rounds, <end>", or add a line to the body that starts "No review:" and says why.`,
        ...(needsTests ? [`${testsNeeded} ${testsFix}`] : []),
      ],
    };

  if (large)
    errors.push(
      `This change adds ${net} net lines of production source, at least ${largeChange}, so it needs a review session with a code quality reviewer, whatever it touches: a "No review:" line doesn't cover it.`,
    );

  const lines = covered.reduce((sum, file) => sum + file.lines, 0);
  const files = covered.map((file) => file.file).join(' ');

  if (covered.length > 0 && !(lowRisk.test(reason) && lines <= lowRiskLines))
    errors.push(
      `This pull request changes ${lines} lines in files a review covers, as ${reviewPaths} lists them: ${files}. A "No review:" line covers them only when it says "low risk" and they change ${lowRiskLines} lines or fewer. Run a review and post its session comment.`,
    );

  if (needsTests) errors.push(`${testsNeeded} ${testsFix}`);

  if (errors.length > 0) return { ok: false, errors };

  if (covered.length > 0) return { ok: true, why: `Low risk, with ${lines} changed lines in files a review covers: ${files}` };

  return tests.length > 0 ? { ok: true, why: `Low risk, with ${testLines} changed lines of test code: ${testFiles}` } : { ok: true, why: `The body says why there's no review: ${reason}` };
};

/** A branch's changes, as `git diff --numstat` counts them. */
export const changesOf = (numstat: string): ReadonlyArray<Change> =>
  numstat
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [additions = '-', deletions = '-', filename = ''] = line.split('\t');

      return { filename, additions: additions === '-' ? 0 : Number(additions), deletions: deletions === '-' ? 0 : Number(deletions) };
    });

const run = (command: string, args: ReadonlyArray<string>) => {
  const done = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (done.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${done.stderr}`);

  return done.stdout;
};

/**
 * The `jq` filter over a page of issue comments that keeps each counted comment's body, as one line
 * of JSON: a person's (`User`, not `Bot`) whose association is in `reviewerAssociations`.
 */
export const memberComments = `.[] | select(.user.type == "User" and (.author_association | IN(${reviewerAssociations
  .map((association) => JSON.stringify(association))
  .join(', ')}))) | .body | tojson`;

/** A paginated GitHub API path's items, each printed by `jq` as one line of JSON. */
const items = <A>(path: string, jq: string) =>
  run('gh', ['api', '--paginate', path, '--jq', jq])
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as A);

const recordOf = (repo: string, pull: string, base: string, sha: string): ReviewRecord => {
  const raw = (ref: string) => run('gh', ['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/${reviewPaths}?ref=${ref}`]);

  // The base's list, or this pull request's own until the base has one.
  let list: string;
  try {
    list = raw(base);
  } catch {
    list = raw(sha);
  }

  return {
    comments: items<string>(`repos/${repo}/issues/${pull}/comments`, memberComments),
    body: run('gh', ['api', `repos/${repo}/pulls/${pull}`, '--jq', '.body // ""']),
    changes: items<Change>(`repos/${repo}/pulls/${pull}/files`, '.[] | {filename, additions, deletions, previous_filename} | with_entries(select(.value != null)) | tojson'),
    list,
  };
};

const usage = 'usage: node review-record.ts [--count | --comment <file> [--covered]]   (in CI: PR, GITHUB_REPOSITORY, GITHUB_SHA and GH_TOKEN; BASE defaults to main)';

if (argv[1] === fileURLToPath(import.meta.url)) {
  const args = argv.slice(2);

  if (args.length === 1 && args[0] === '--count') {
    const base = run('git', ['merge-base', `origin/${env.BASE ?? defaultBase}`, 'HEAD']).trim();
    const changes = changesOf(run('git', ['diff', '--numstat', '--no-renames', base, 'HEAD']));
    const net = netProductionLines(changes);
    const testLines = changes.filter((change) => isTestCode(change.filename)).reduce((sum, change) => sum + change.additions + change.deletions, 0);

    console.log(net);
    console.error(
      net >= largeChange
        ? `Large: at least ${largeChange} net lines of production source, so a session needs a code quality reviewer.`
        : `Not large: under ${largeChange} net lines of production source.`,
    );
    if (testLines > 0)
      console.error(`Tests: ${testLines} changed lines of test code, so a session needs a tests reviewer${testLines <= lowRiskLines ? ', or the body a "No review: low risk" line' : ''}.`);
    if (existsSync(reviewPaths)) {
      const covered = filesIn(changes, coveredBy(readFileSync(reviewPaths, 'utf8'))).map((file) => file.file);
      console.error(`Review list: ${reviewPaths} covers ${covered.length} changed file(s)${covered.length > 0 ? `: ${covered.join(' ')}; run with --covered` : ''}.`);
    } else console.error(`Review list: no ${reviewPaths} here, so no change is covered; CI reads the base branch's copy.`);
    exit(0);
  }

  if (args[0] === '--comment' && args[1] !== undefined && args.length <= 3 && (args[2] === undefined || args[2] === '--covered')) {
    const session = readSession(readFileSync(args[1], 'utf8'), args[2] === '--covered');

    for (const problem of session.problems) console.log(`${args[1]}: ${problem}.`);
    if (session.problems.length > 0) exit(1);

    console.log(`${args[1]}: a session with ${session.reviewers.length} reviewer(s): ${session.reviewers.join(', ')}.`);
    exit(0);
  }

  const { PR: pull, GITHUB_REPOSITORY: repo, GITHUB_SHA: sha } = env;
  const base = env.BASE ?? defaultBase;

  if (args.length > 0 || !pull || !repo || !sha) {
    console.error(usage);
    exit(2);
  }

  const result = verdict(recordOf(repo, pull, base, sha));

  if (result.ok) {
    console.log(result.why);
    exit(0);
  }

  for (const error of result.errors) console.log(`::error::${error}`);
  exit(1);
}
