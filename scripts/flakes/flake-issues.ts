#!/usr/bin/env node
/**
 * flake-issues.ts: one GitHub issue per flaky test, filed by the CI run that hits it, with a
 * tally the daily health check reads back to close it.
 *
 *     node scripts/flakes/flake-issues.ts <folder>
 *
 * Runs: in CI's final aggregate job (the one a merge reads), after every test job, on every
 * attempt. `../budgets/ci-health.ts` imports the marker functions and closes quiet issues daily.
 * Configure: the CONFIG block below: labels, the aggregate job's name, which files only the
 * sweep runs, and the command that proves a fix.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * CI retries each failed test once, in-process, so a flake doesn't turn a run red, but a recovery
 * is recorded, never hidden (docs/pages/11-flakes.md). Each test run in a test job appends a line
 * to the file `TEST_FLAKES_FILE` names when a test failed or passed only on its retry
 * (`../records/test-record.ts`). The job saves that file (Actions cache or artifact) as
 * `flakes-<run>-<attempt>-<job>.jsonl`. The aggregate job restores every test job's file of every
 * attempt into `<folder>` and runs this. For each test that passed only on its retry in this
 * attempt it opens the issue `Flaky: <file> › <test>`, or comments on it, reopening it when it's
 * closed. A job that failed in an earlier attempt of the run and passed in this one counts too:
 * each test its failed attempt's lines name is flaky, and when they name none, or more than
 * `jobTestsLimit`, the issue is `Flaky job: <job>`.
 *
 * - Each comment names the run, its event, the pull request or branch, the commit and the start
 *   of the failed attempt's error. On a pull request's run it says when the PR changes the test's
 *   file: a branch's own bug isn't a flake.
 * - A closed issue stays closed when the run's commit lacks the commit that closed it, such as a
 *   pull request's run that started before the fix merged.
 * - Each issue's body keeps a tally in a hidden marker, `<!-- ci-flake {...} -->`: when it was
 *   seen, how often, and how many runs since passed its file without it. `ci-health.ts` counts
 *   those each day and closes the issue by `closes`. Three occurrences in 7 days raise it to P1.
 * - At most `flakesLimit` issues per run; the rest are listed in the run's summary.
 *
 * Env: `GH_TOKEN` (the run's token, with `issues: write`, `actions: read`, `contents: read`,
 * `pull-requests: read`), `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, and from the
 * workflow: `EVENT`, `PR`, `BRANCH`, `SHA` (the commit tested) and `SWEEP=true` on the sweep.
 * It makes at most six API calls a flake. A failure here warns and never fails the report job.
 * No dependencies: Node 24 and `gh`.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------------------------

/** The labels a new flake's issue gets. `flake` is how the health check finds them. */
export const labels = ['flake', 'bug', 'ci', 'P2'];

/** The label a hot flake moves to, and the ones it replaces. */
export const hotLabel = 'P1';

export const coolerLabels = ['P2', 'P3'];

/** The aggregate job's name on the run's page. It reruns for reasons of its own, so it's never a flake. */
export const resultJob = 'CI result';

/** The jobs that rerun with whatever failed, never flakes: the result and the report after it. */
export const bookkeepingJobs: ReadonlySet<string> = new Set([resultJob, 'CI report']);

/**
 * Files that mostly only the daily sweep runs, such as container or proof tests, which close after
 * `quiet.sweepRuns` clean runs, about a week of daily sweeps, instead of `quiet.runs`.
 */
export const sweepOnly = (file: string) => /\.(sandbox|proof)\.test\.[cm]?[jt]sx?$/.test(file);

/**
 * The run by hand that proves a fix to a flaky test's file: many runs of it with no retry. Use
 * whatever your CI's manual trigger takes; `<org>/<repo>` and the inputs are placeholders.
 * `--ref` picks the workflow's revision and `-f ref` the code's: pass both, or a fix to the
 * workflow itself runs the default branch's. The template's ci.yml declares `test_paths` and
 * `repeat`; `heavy_file` only exists once you add a heavy-file job and its input.
 */
export const proofOf = (file: string) =>
  sweepOnly(file)
    ? `gh workflow run ci.yml --repo <org>/<repo> --ref <branch> -f ref=<branch> -f heavy_file=${file} -f repeat=20`
    : `gh workflow run ci.yml --repo <org>/<repo> --ref <branch> -f ref=<branch> -f test_paths=${file} -f repeat=${String(quiet.runs)}`;

// ---------------------------------------------------------------------------------------------

/** One test run's line in a job's flakes file, as `../records/test-record.ts` writes it. */
export interface FlakesLine {
  readonly attempt: number;
  /** The job's name on the run's page, as `CI_JOB` gives it. */
  readonly job: string;
  /** Each test that failed: its file, its full name and the start of its first error. */
  readonly failed: ReadonlyArray<readonly [string, string, string]>;
  /** Each test that passed only on a retry: its file, its full name, its retries and its first error. */
  readonly flaky: ReadonlyArray<readonly [string, string, number, string]>;
}

const isText = (value: unknown): value is string => typeof value === 'string';

const isRow = (value: unknown, shape: ReadonlyArray<'s' | 'n'>) =>
  Array.isArray(value) &&
  value.length === shape.length &&
  shape.every((kind, index) => (kind === 's' ? isText(value[index]) : Number.isFinite(value[index])));

const decodeLine = (text: string): FlakesLine | undefined => {
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null;
    if (value === null || typeof value !== 'object') return undefined;

    const ok =
      Number.isFinite(value['attempt']) &&
      isText(value['job']) &&
      Array.isArray(value['failed']) &&
      value['failed'].every((row) => isRow(row, ['s', 's', 's'])) &&
      Array.isArray(value['flaky']) &&
      value['flaky'].every((row) => isRow(row, ['s', 's', 'n', 's']));

    return ok ? (value as unknown as FlakesLine) : undefined;
  } catch {
    return undefined;
  }
};

/** The most of a run's failed or retried tests a line keeps, and the longest excerpt. */
export const lineLimit = 50;

export const excerptLimit = 1500;

/** The most flakes one run files: the rest are only listed in the run's summary. */
export const flakesLimit = 10;

/** A job whose failed attempt named more tests than this is one flake of the job, not of each. */
export const jobTestsLimit = 5;

const markerStart = '<!-- ci-flake ';

const markerEnd = ' -->';

/** The most occurrence times a marker keeps, newest last. */
const seenLimit = 20;

const day = 24 * 60 * 60 * 1000;

/** How many occurrences in how many days raise an issue to `hotLabel`. */
export const hot = { occurrences: 3, days: 7 } as const;

/**
 * How long, and how many runs of its file, an issue waits with no occurrence before it closes:
 * `runs` for an ordinary test, which pull requests run too, and `sweepRuns` for a file only the
 * daily sweep runs, or a job, so about a run a day.
 */
export const quiet = { days: 7, runs: 50, sweepRuns: 7 } as const;

/** A flake to file: a test, or a job whose failed attempt named no test. */
export type Flake =
  | { readonly kind: 'test'; readonly file: string; readonly test: string; readonly excerpt: string; readonly how: string }
  | { readonly kind: 'job'; readonly job: string; readonly excerpt: string; readonly how: string };

/** What an issue's marker keeps. */
export interface Marker {
  readonly kind: 'test' | 'job';
  /** The test's file and full name, or the job's name. */
  readonly file?: string;
  readonly test?: string;
  readonly job?: string;
  /** Every occurrence counted, and the newest `seenLimit` of their times. */
  readonly count: number;
  readonly first: string;
  readonly seen: readonly [...Array<string>, string];
  /** Runs since the last occurrence that ran its file without it, counted up to `counted`. */
  readonly clean: number;
  readonly counted?: string;
}

const decodeMarker = (text: string): Marker | undefined => {
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null;
    if (value === null || typeof value !== 'object') return undefined;

    const optional = (key: string) => value[key] === undefined || isText(value[key]);
    const seen = value['seen'];
    const ok =
      (value['kind'] === 'test' || value['kind'] === 'job') &&
      optional('file') &&
      optional('test') &&
      optional('job') &&
      optional('counted') &&
      Number.isFinite(value['count']) &&
      isText(value['first']) &&
      Array.isArray(seen) &&
      seen.length > 0 &&
      seen.every(isText) &&
      Number.isFinite(value['clean']);

    return ok ? (value as unknown as Marker) : undefined;
  } catch {
    return undefined;
  }
};

/** How many clean runs the marker's issue waits for, as `quiet` says. */
export const quietRuns = (marker: Marker) =>
  marker.kind === 'job' || sweepOnly(marker.file ?? '') ? quiet.sweepRuns : quiet.runs;

/** Text with no terminal colours or control characters but new lines and tabs. */
export const plain = (text: string) =>
  // eslint-disable-next-line no-control-regex -- the escapes a terminal's colours are written in.
  text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');

/** At most `limit` characters of `text`, marked where it was cut. */
export const bounded = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);

/** One line of text: no line breaks, runs of space as one. */
const oneLine = (text: string) => plain(text).replace(/\s+/g, ' ').trim();

/**
 * The start of a test's first error, as an excerpt: its message, then its stack, without the frames
 * in `node_modules` or Node's own, and with paths from `root`, the repo's root.
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
  const relative = root === '' ? text : text.replaceAll(`file://${root}/`, '').replaceAll(`${root}/`, '');

  return bounded(plain(relative).trim(), excerptLimit);
};

/** `text` as inline code, its delimiter longer than any run of backticks inside. */
export const codeSpan = (text: string) => {
  const line = oneLine(text);
  const longest = Math.max(0, ...[...line.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = line.startsWith('`') || line.endsWith('`') ? ' ' : '';

  return `${fence}${pad}${line}${pad}${fence}`;
};

/** `text` as a fenced block, its fence longer than any run of backticks inside. */
export const fenced = (text: string) => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = '`'.repeat(longest + 1);

  return `${fence}text\n${text}\n${fence}`;
};

/** GitHub's longest title. */
const titleLimit = 256;

/** The issue's title, which finds it again: the same flake always has the same one. */
export const titleOf = (flake: Flake) =>
  bounded(
    flake.kind === 'test' ? `Flaky: ${oneLine(flake.file)} › ${oneLine(flake.test)}` : `Flaky job: ${oneLine(flake.job)}`,
    titleLimit,
  );

/** The marker in an issue's body, or undefined when it holds none this can read. */
export const markerIn = (body: string): Marker | undefined => {
  const start = body.lastIndexOf(markerStart);
  if (start === -1) return undefined;

  const end = body.indexOf(markerEnd, start + markerStart.length);
  if (end === -1) return undefined;

  return decodeMarker(body.slice(start + markerStart.length, end));
};

/** The marker as the body's last line, its JSON escaped so no text inside can end the comment. */
const markerLine = (marker: Marker) =>
  `${markerStart}${JSON.stringify(marker).replace(/[<>&]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}${markerEnd}`;

/** The newest occurrence's time. */
export const lastSeen = (marker: Marker) => marker.seen.at(-1) ?? marker.first;

/** How many of the marker's occurrences fell in the `hot.days` before `now`. */
export const recent = (marker: Marker, now: Date) =>
  marker.seen.filter((at) => now.getTime() - Date.parse(at) < hot.days * day).length;

/** Whether the marker's occurrences make the issue hot. */
export const isHot = (marker: Marker, now: Date) => recent(marker, now) >= hot.occurrences;

/** Whether the issue has been quiet long enough, and over enough runs, to close. */
export const closes = (marker: Marker, now: Date) =>
  now.getTime() - Date.parse(lastSeen(marker)) >= quiet.days * day && marker.clean >= quietRuns(marker);

/** The marker after one more occurrence at `now`: its clean runs start again from none. */
export const occurred = (held: Marker | undefined, flake: Flake, now: Date): Marker => {
  const at = now.toISOString();
  const seen: Marker['seen'] = [...(held?.seen ?? []).slice(1 - seenLimit), at];
  const what =
    flake.kind === 'test'
      ? { kind: 'test' as const, file: flake.file, test: flake.test }
      : { kind: 'job' as const, job: flake.job };

  return {
    ...what,
    count: (held?.count ?? 0) + 1,
    first: held?.first ?? at,
    seen,
    clean: 0,
    counted: at,
  };
};

const dayOf = (at: string) => at.slice(0, 10);

/** The issue's body: what the flake is, its tally, how it closes, and the marker. */
export const bodyOf = (marker: Marker, now: Date) => {
  const what =
    marker.kind === 'test'
      ? `The test ${codeSpan(marker.test ?? '')}, in ${codeSpan(marker.file ?? '')}, failed and then passed on the same commit in CI: on its retry, or when its job ran again.`
      : `The job ${codeSpan(marker.job ?? '')} failed and then passed when it ran again on the same commit, and its failed attempt named no test, or too many to be each a flake.`;

  return [
    what,
    '',
    '| Occurrences | In the last 7 days | First seen | Last seen | Runs since without it |',
    '| --- | --- | --- | --- | --- |',
    `| ${String(marker.count)} | ${String(recent(marker, now))} | ${dayOf(marker.first)} | ${dayOf(lastSeen(marker))} | ${String(marker.clean)} |`,
    '',
    `Each comment below is one occurrence, from the run of CI that hit it (\`scripts/flakes/flake-issues.ts\`). ${String(hot.occurrences)} in ${String(hot.days)} days make it \`${hotLabel}\`. CI's daily health check (\`scripts/budgets/ci-health.ts\`) counts the runs since the last occurrence that ran its file without it, and closes this once ${String(quiet.days)} days and ${String(quietRuns(marker))} such runs have passed. Cache replays don't count. A new occurrence reopens it.`,
    '',
    ...(marker.kind === 'test'
      ? ['A fix proves itself by running the file again and again with no retry:', '', fenced(proofOf(marker.file ?? '')), '']
      : []),
    markerLine(marker),
  ].join('\n');
};

/** The run a flake was found in, as a comment names it. */
export interface RunFacts {
  readonly url: string;
  readonly id: string;
  readonly attempt: number;
  /** `pull_request`, `push`, `schedule` or `workflow_dispatch`. */
  readonly event: string;
  readonly sweep: boolean;
  readonly pr: string;
  readonly branch: string;
  readonly sha: string;
  /** The files the pull request changes, or empty. */
  readonly changed: ReadonlySet<string>;
}

const whereOf = (run: RunFacts) => {
  const commit = codeSpan(run.sha.slice(0, 12));
  if (run.event === 'pull_request')
    return `a pull request's run, #${run.pr} from ${codeSpan(run.branch)}, on its merge into the base at ${commit}`;

  if (run.sweep) return `a sweep of ${codeSpan(run.branch)}, at ${commit}`;

  if (run.event === 'push') return `a merge's run on ${codeSpan(run.branch)}, at ${commit}`;

  return `a run by hand (${codeSpan(run.event)}) on ${codeSpan(run.branch)}, at ${commit}`;
};

/** One occurrence's comment: the run, where, whether the pull request changes the file, the error. */
export const commentOf = (flake: Flake, run: RunFacts) =>
  [
    `Flaked in [run ${run.id}, attempt ${String(run.attempt)}](${run.url}): ${whereOf(run)}. ${flake.how}`,
    ...(flake.kind === 'test' && run.changed.has(flake.file)
      ? ['', `**Likely this pull request's own:** it changes ${codeSpan(flake.file)}. Fix it there before it merges.`]
      : []),
    ...(flake.excerpt === '' ? [] : ['', 'The failed attempt:', '', fenced(flake.excerpt)]),
  ].join('\n');

/** A job of the run, any attempt's, as the API lists them with `filter=all`. */
export interface RunJob {
  readonly name: string;
  readonly conclusion: string | null;
  readonly run_attempt: number;
}

/**
 * The flakes this attempt of the run found: each test that passed only on its retry in it, and each
 * job that failed in an earlier attempt and passed in this one. The result and report jobs are left
 * out, since they rerun for reasons of their own.
 */
export const flakesOf = (
  lines: ReadonlyArray<FlakesLine>,
  attempt: number,
  jobs: ReadonlyArray<RunJob>,
): ReadonlyArray<Flake> => {
  const retried = lines
    .filter((line) => line.attempt === attempt)
    .flatMap(({ flaky }) =>
      flaky.map(([file, test, retries, excerpt]): Flake => ({
        kind: 'test',
        file,
        test,
        excerpt,
        how: `It failed, then passed when it ran again in the same job${retries > 1 ? `, after ${String(retries)} tries` : ''}.`,
      })),
    );

  const rerun = [...new Set(jobs.map((job) => job.name))]
    .filter((name) => !bookkeepingJobs.has(name))
    .flatMap((name): ReadonlyArray<Flake> => {
      const passed = jobs.some((job) => job.name === name && job.run_attempt === attempt && job.conclusion === 'success');
      // Its latest attempt before this one, which must have failed: a failure an attempt since
      // passed was that attempt's to file.
      const before = jobs
        .flatMap((job) => (job.name === name && job.run_attempt < attempt ? [job] : []))
        .toSorted((a, b) => a.run_attempt - b.run_attempt)
        .at(-1);
      if (!passed || before?.conclusion !== 'failure') return [];

      const failed = before.run_attempt;
      const how = `Its job, ${codeSpan(name)}, failed on attempt ${String(failed)} and passed on attempt ${String(attempt)}.`;
      const named = lines.filter((line) => line.job === name && line.attempt === failed).flatMap((line) => line.failed);
      if (named.length > 0 && named.length <= jobTestsLimit)
        return named.map(([file, test, excerpt]) => ({ kind: 'test', file, test, excerpt, how }));

      return [
        {
          kind: 'job',
          job: name,
          excerpt: named
            .map(([file, test]) => `${file} › ${test}`)
            .join('\n')
            .slice(0, excerptLimit),
          how:
            named.length === 0
              ? `${how} Its record named no failed test.`
              : `${how} It named ${String(named.length)} failed tests, listed below.`,
        },
      ];
    });

  // A test named twice, such as by its retry and by its job's rerun, is filed once.
  const byTitle = new Map<string, Flake>();

  for (const flake of [...retried, ...rerun]) if (!byTitle.has(titleOf(flake))) byTitle.set(titleOf(flake), flake);

  return [...byTitle.values()];
};

/** Each line of every flakes file under `folder`, as the saved files restored there hold them. */
export const linesIn = (folder: string): ReadonlyArray<FlakesLine> => {
  if (!existsSync(folder)) return [];

  const files = readdirSync(folder, { recursive: true, encoding: 'utf8' }).flatMap((name) => {
    const path = join(folder, name);

    return path.endsWith('.jsonl') && statSync(path).isFile() ? [path] : [];
  });

  return files.flatMap((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line) => {
        const decoded = decodeLine(line);

        return decoded === undefined ? [] : [decoded];
      }),
  );
};

/** What `gh` prints. */
const gh = (args: ReadonlyArray<string>, input?: string) =>
  execFileSync('gh', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  }).trim();

interface Listed {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
}

/** Each line `gh` printed, as JSON. */
const linesOf = <A>(printed: string) =>
  printed.split('\n').flatMap((line) => (line === '' ? [] : [JSON.parse(line) as A]));

/** Print `markdown`, and add it to the step's summary. */
const say = (markdown: string) => {
  console.log(markdown);

  const summary = env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') appendFileSync(summary, `${markdown}\n\n`);
};

/** The commit that closed the issue, a merged pull request's or a pushed one's, or undefined. */
const fixOf = (repo: string, number: number) => {
  const [owner = '', name = ''] = repo.split('/');
  const oid = gh([
    'api',
    'graphql',
    '-f',
    'query=query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { closer { ... on PullRequest { mergeCommit { oid } } ... on Commit { oid } } } } } } } }',
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-F',
    `number=${String(number)}`,
    '--jq',
    '.data.repository.issue.timelineItems.nodes[0].closer | (.mergeCommit.oid // .oid // "")',
  ]);

  return /^[0-9a-f]{40}$/.test(oid) ? oid : undefined;
};

/**
 * Whether a closed issue's flake, seen at `sha`, predates its fix: `sha` lacks the commit that
 * closed it. A pull request's run that started before the fix merged tests a merge without it, and
 * its flake is the one the fix ended. An issue closed by no commit, as the health check closes one,
 * or a lookup that fails, predates nothing.
 */
const predatesFix = (repo: string, number: number, sha: string) => {
  if (!/^[0-9a-f]{40}$/.test(sha)) return undefined;

  try {
    const fix = fixOf(repo, number);
    if (fix === undefined) return undefined;

    const status = gh(['api', `repos/${repo}/compare/${fix}...${sha}`, '--jq', '.status']);

    return status === 'ahead' || status === 'identical' ? undefined : fix;
  } catch {
    return undefined;
  }
};

/**
 * File each flake: open its issue, or comment on it, reopen it and raise it to `hotLabel`. A closed
 * issue stays closed when the run's commit predates the commit that closed it.
 */
const file = (repo: string, flakes: ReadonlyArray<Flake>, run: RunFacts, now: Date) => {
  const listed = linesOf<Listed>(
    gh([
      'api',
      '--paginate',
      `repos/${repo}/issues?labels=flake&state=all&per_page=100`,
      '--jq',
      '.[] | select(.pull_request == null) | {number, title, state, body: (.body // ""), labels: [.labels[].name]} | @json',
    ]),
  );

  for (const flake of flakes) {
    const title = titleOf(flake);
    // The newest issue of that title, open or closed.
    const issue = listed.filter((each) => each.title === title).toSorted((a, b) => b.number - a.number)[0];
    const marker = occurred(issue === undefined ? undefined : markerIn(issue.body), flake, now);
    const body = bodyOf(marker, now);
    const comment = commentOf(flake, run);

    if (issue === undefined) {
      const number = gh(['api', `repos/${repo}/issues`, '--input', '-', '--jq', '.number'], JSON.stringify({ title, body, labels }));
      gh(['api', `repos/${repo}/issues/${number}/comments`, '--input', '-', '--jq', '.id'], JSON.stringify({ body: comment }));
      say(`- Opened #${number}: ${title}`);
      continue;
    }

    const fix = issue.state === 'open' ? undefined : predatesFix(repo, issue.number, run.sha);

    if (fix !== undefined) {
      say(
        `- Left #${String(issue.number)} closed: ${title}. This run's commit, ${codeSpan(run.sha.slice(0, 12))}, predates its fix, ${codeSpan(fix.slice(0, 12))}.`,
      );
      continue;
    }

    const number = String(issue.number);
    gh(['api', `repos/${repo}/issues/${number}/comments`, '--input', '-', '--jq', '.id'], JSON.stringify({ body: comment }));
    gh(['api', '-X', 'PATCH', `repos/${repo}/issues/${number}`, '--input', '-', '--jq', '.number'], JSON.stringify({ body, state: 'open' }));

    if (isHot(marker, now) && !issue.labels.includes(hotLabel)) {
      gh(['api', `repos/${repo}/issues/${number}/labels`, '--input', '-', '--jq', 'length'], JSON.stringify({ labels: [hotLabel] }));

      for (const lower of coolerLabels.filter((name) => issue.labels.includes(name)))
        gh(['api', '-X', 'DELETE', `repos/${repo}/issues/${number}/labels/${lower}`, '--jq', 'length']);
    }

    say(
      `- ${issue.state === 'open' ? 'Commented on' : 'Reopened'} #${number}: ${title}${isHot(marker, now) ? `, ${hotLabel} at ${String(recent(marker, now))} in ${String(hot.days)} days` : ''}`,
    );
  }
};

const main = (args: ReadonlyArray<string>) => {
  const folder = args[0];

  if (folder === undefined) {
    console.error('usage: node scripts/flakes/flake-issues.ts <folder>');

    return 2;
  }

  const repo = env['GITHUB_REPOSITORY'] ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("GITHUB_REPOSITORY isn't a repository");

  const id = env['GITHUB_RUN_ID'] ?? '';
  const attempt = Number(env['GITHUB_RUN_ATTEMPT'] ?? '1');
  const lines = linesIn(folder);
  const jobs =
    attempt > 1
      ? linesOf<RunJob>(
          gh([
            'api',
            '--paginate',
            `repos/${repo}/actions/runs/${id}/jobs?filter=all&per_page=100`,
            '--jq',
            '.jobs[] | {name, conclusion, run_attempt} | @json',
          ]),
        )
      : [];
  const found = flakesOf(lines, attempt, jobs);

  if (found.length === 0) {
    console.log('No test passed only on its retry, and no job failed and then passed.');

    return 0;
  }

  const event = env['EVENT'] ?? '';
  const pr = env['PR'] ?? '';
  const changed =
    event === 'pull_request' && /^[0-9]+$/.test(pr)
      ? new Set(gh(['api', '--paginate', `repos/${repo}/pulls/${pr}/files?per_page=100`, '--jq', '.[].filename']).split('\n'))
      : new Set<string>();
  const run: RunFacts = {
    url: `${env['GITHUB_SERVER_URL'] ?? 'https://github.com'}/${repo}/actions/runs/${id}/attempts/${String(attempt)}`,
    id,
    attempt,
    event,
    sweep: env['SWEEP'] === 'true',
    pr,
    branch: env['BRANCH'] ?? '',
    sha: env['SHA'] ?? '',
    changed,
  };

  say(`### Flakes\n\n${String(found.length)} found in this attempt.`);
  file(repo, found.slice(0, flakesLimit), run, new Date());

  if (found.length > flakesLimit)
    say(
      `Not filed, past the ${String(flakesLimit)} a run files:\n\n${found
        .slice(flakesLimit)
        .map((flake) => `- ${codeSpan(titleOf(flake))}`)
        .join('\n')}`,
    );

  return 0;
};

// A failure's message alone, as an annotation on the run's page. The step never fails CI's result.
if (argv[1] === fileURLToPath(import.meta.url)) {
  try {
    exit(main(argv.slice(2)));
  } catch (error) {
    console.error(`::warning::${error instanceof Error ? error.message : String(error)}`);
    exit(1);
  }
}
