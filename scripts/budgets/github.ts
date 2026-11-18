/**
 * github.ts: the one issue a scheduled watch keeps open, through `gh`: find it by its title, open
 * it, comment on it or replace its body, and close it. Plus the run summary.
 *
 * Runs: imported by `ci-health.ts` and `../sweeps/sweep-bisect.ts`, inside Actions jobs.
 * Env: `GH_TOKEN` and `GITHUB_REPOSITORY`, as a workflow's run sets them.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { env } from 'node:process';

/** What `gh` prints, or throws. */
export const gh = (args: ReadonlyArray<string>) =>
  execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 256 * 1024 * 1024 }).trim();

/** The repository the run is in, as `owner/name`. */
export const repo = () => {
  const name = env['GITHUB_REPOSITORY'] ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error("GITHUB_REPOSITORY isn't a repository");

  return name;
};

/** Print `markdown`, and add it to the run's summary. */
export const say = (markdown: string) => {
  console.log(markdown);

  const summary = env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') appendFileSync(summary, `${markdown}\n\n`);
};

/** The issue's number, from the URL `gh issue create` prints. */
export const issueNumberOf = (url: string) => {
  const number = /\/issues\/(\d+)$/.exec(url)?.[1];
  if (number === undefined) throw new Error('gh issue create printed no issue URL');

  return number;
};

/** Each line `gh` printed, parsed as JSON. */
const linesOf = <A>(printed: string) =>
  printed
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as A);

/** A watch's issue, with its body and then each comment, oldest first. */
export interface WatchIssue {
  readonly number: string;
  readonly open: boolean;
  readonly posted: ReadonlyArray<string>;
}

/**
 * The issues titled `title`, each with its body and comments: those open, however old, and with
 * `closedSince`, those closed since then. Read through the REST API, not search, since search lags
 * the last post by up to a minute.
 */
export const watchIssues = (title: string, closedSince?: Date): ReadonlyArray<WatchIssue> => {
  const select = `.[] | select(.pull_request == null and .title == ${JSON.stringify(title)}) | {number, state, body: (.body // "")} | @json`;
  const listed = [
    ...linesOf<{ number: number; state: string; body: string }>(
      gh(['api', '--paginate', `repos/${repo()}/issues?state=open&per_page=100`, '--jq', select]),
    ),
    ...(closedSince === undefined
      ? []
      : linesOf<{ number: number; state: string; body: string }>(
          gh(['api', '--paginate', `repos/${repo()}/issues?state=closed&since=${closedSince.toISOString()}&per_page=100`, '--jq', select]),
        )),
  ];

  return listed.map((issue) => {
    const comments = gh(['api', '--paginate', `repos/${repo()}/issues/${String(issue.number)}/comments?per_page=100`, '--jq', '.[] | .body // "" | @json']);

    return { number: String(issue.number), open: issue.state === 'open', posted: [issue.body, ...linesOf<string>(comments)] };
  });
};

/** Open an issue, and return its number. */
export const openIssue = (title: string, labels: string, body: string) =>
  issueNumberOf(gh(['issue', 'create', '--repo', repo(), '--title', title, '--label', labels, '--body', body]));

/** Replace the body of the issue `number`. */
export const editIssue = (number: string, body: string) => {
  gh(['issue', 'edit', number, '--repo', repo(), '--body', body]);
};

/** Comment on the issue `number`. */
export const commentOn = (number: string, body: string) => {
  gh(['issue', 'comment', number, '--repo', repo(), '--body', body]);
};

/** Close the issue `number`, saying why. */
export const closeIssue = (number: string, comment: string) => {
  gh(['issue', 'close', number, '--repo', repo(), '--comment', comment]);
};
