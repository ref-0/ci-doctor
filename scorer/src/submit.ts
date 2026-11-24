// --submit: adds a report to ci-doctor-db as a pull request from the person's own fork, through `gh api` and their
// own sign-in, with no clone. The file is the report `--json` prints, less any local path, plus who submitted it.
import { CliError } from './errors.ts';
import type { Gh } from './gh.ts';
import type { Report } from './score.ts';
import { smokeCheck, submissionPath } from './smoke.ts';

/** The public data repo submissions go to. */
export const DATA_REPO = 'ref-0/ci-doctor-db';

/** The file --submit adds: the report, what was read without the cache's folder, and who submitted it, when. */
export const submissionOf = (report: Report, read: { calls: number; fromCache: number }, login: string, now = Date.now()) =>
  `${JSON.stringify({ ...report, read: { calls: read.calls, fromCache: read.fromCache }, submitted: { by: login, at: new Date(now).toISOString() } }, null, 1)}\n`;

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export interface Submitted {
  url: string;
  /** An open pull request of this person's already added the file: nothing was sent. */
  already: boolean;
}

/**
 * Opens the pull request that adds `text` for `report`, or finds the open one that already does. `say` is told what
 * will be sent, and where, before anything is.
 */
export const submit = (gh: Gh, report: Report, text: string, login: string, say: (line: string) => void, now = Date.now()): Submitted => {
  const path = submissionPath(report.repo, report.date);
  const problems = smokeCheck(text, { path, now });
  if (problems.length) throw new CliError(`Not submitted: the report fails ci-doctor-db's checks.\n${problems.map((p) => `  - ${p}`).join('\n')}`);

  // Branches are named for the file, so an open pull request from one is this file's.
  const prefix = `submit/${report.repo.replace('/', '__')}/${report.date}-`;
  const open = (gh.json(`repos/${DATA_REPO}/pulls?state=open&per_page=100`, { noCache: true }) ?? []) as { html_url: string; user?: { login?: string }; head?: { ref?: string } }[];
  const mine = open.find((p) => p.user?.login === login && p.head?.ref?.startsWith(prefix));
  if (mine) return { url: mine.html_url, already: true };

  const existing = gh.json(`repos/${login}/ci-doctor-db`, { absentOn: [404], noCache: true });
  let fork: string | undefined = existing?.fork && existing.parent?.full_name === DATA_REPO ? existing.full_name : undefined;
  say(`Sending ${path} (${Math.ceil(Buffer.byteLength(text) / 1000)} KB: the report above, your login ${login} and the scorer's version) to ${DATA_REPO}, as a pull request from ${fork ?? `a new fork, ${login}/ci-doctor-db`}.`);

  const forked = !fork;
  if (!fork) fork = gh.send('POST', `repos/${DATA_REPO}/forks`, { default_branch_only: true }).full_name as string;
  const base = gh.json(`repos/${DATA_REPO}`, { noCache: true }).default_branch as string;
  const tip = gh.json(`repos/${DATA_REPO}/git/ref/heads/${base}`, { noCache: true }).object.sha as string;

  // A fork GitHub is still making answers 404 or 409 for a few seconds.
  const branch = `${prefix}${new Date(now).toISOString().slice(11, 19).replaceAll(':', '')}`;
  for (let attempt = 1; ; attempt++) {
    const ref = gh.send('POST', `repos/${fork}/git/refs`, { ref: `refs/heads/${branch}`, sha: tip }, forked ? { absentOn: [404, 409] } : {});
    if (ref) break;
    if (attempt === 10) throw new CliError(`GitHub hadn't finished making the fork ${fork} after 30 seconds. Run this again in a minute.`);
    sleep(3000);
  }
  gh.send('PUT', `repos/${fork}/contents/${path}`, {
    message: `Submit ${report.repo}'s report for ${report.date}`,
    content: Buffer.from(text).toString('base64'),
    branch,
  });
  const pr = gh.send('POST', `repos/${DATA_REPO}/pulls`, {
    title: `Submit ${report.repo}, ${report.date}`,
    head: `${fork.split('/')[0]}:${branch}`,
    base,
    body: `Adds \`${path}\`: ci-doctor ${report.scorerVersion}'s report of ${report.repo}, submitted by ${login} with \`npx @ref0/ci-doctor --submit\`.`,
    maintainer_can_modify: true,
  });
  return { url: pr.html_url as string, already: false };
};
