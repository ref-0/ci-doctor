#!/usr/bin/env node
/**
 * merge-pass.ts: whether a merge to main records a pass for the component's key, from its pull
 * request's run, so main needn't run the expensive checks again for what the pull request proved.
 *
 *     node scripts/reuse/merge-pass.ts <sha>
 *
 * Prints the id of the CI run that passed the component's checks at the key of `<sha>`, a merge on
 * main, and nothing when none did. It says why on stderr. It fails when GitHub or git can't be read,
 * and the plan then records nothing.
 *
 * Runs: in CI's plan job on a push to main, when main holds no pass for the merge's key, with
 * `GH_TOKEN` (`actions: read`, `pull-requests: read`). Node 24, `gh` and `git` only: the plan
 * installs nothing. See README.md and docs/pages/06-reuse-work-by-its-real-inputs.md.
 * Configure: the CONFIG block: the jobs and steps a pass needs, the plan job's name, the workflow.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * The run is the merged pull request's last run of the CI workflow, a `pull_request` event from a
 * branch in this repo, on the pull request's final head. It counts when:
 * - each job in `passingJobs` succeeded, with each of its named steps. Skipped doesn't count, so a
 *   run that skipped them, on the strength of main's pass, records nothing.
 * - the commit it tested has the same key as `<sha>`. A pull request's run tests its merge into
 *   main's tip at the time, `refs/pull/<n>/merge`, whose sha its plan prints in CI's plan record.
 *   GitHub's API names no such commit for a run, but still serves it after the merge. This fetches
 *   it, holds its second parent to the pull request's final head, and computes both keys with this
 *   commit's `pass-key.ts`. Equal keys mean the same files and the same jobs, so the checks that
 *   passed there are the ones this commit's would run. When main moved what the key reads after
 *   that run, the keys differ.
 *
 * It trusts the run's workflow, the pull request's own, to report its jobs and its commit, as a
 * merge trusts that run's result. A branch in this repo is required: a fork's run is not trusted.
 */
import { spawnSync } from 'node:child_process';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

import { recordPrefix } from '../flakes/records.ts';
import { keyOf, sourceAt } from './pass-key.ts';

// ---------------------------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------------------------

const workflowPath = '.github/workflows/ci.yml';

/** The branch merges land on. */
const mainBranch = 'main';

/**
 * The jobs whose success a pass needs, by their names on a run's page, each with the steps that must
 * have succeeded in it. For a Rust crate: its tests on each platform, and the job whose steps run
 * rustfmt and Clippy.
 */
export const passingJobs: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ['<Component> tests / Linux on x64', []],
  ['<Component> tests / Linux on arm64', []],
  ['Rust', ['Format', 'Lint']],
]);

/** The name of the plan's job, whose log holds CI's record of the commit it tested. */
export const planJob = 'Plan';

// ---------------------------------------------------------------------------------------------

const sha = /^[0-9a-f]{40}$/;

interface Repo {
  readonly full_name: string;
}

/** A pull request, as GitHub's `commits/<sha>/pulls` lists it, in the fields read here. */
export interface Pull {
  readonly number: number;
  readonly merged_at: string | null;
  readonly merge_commit_sha: string | null;
  readonly base: { readonly ref: string; readonly repo: Repo };
  /** A fork that's gone has no repo. */
  readonly head: { readonly sha: string; readonly ref: string; readonly repo: Repo | null };
}

/** A workflow's run, as GitHub's `actions/workflows/<file>/runs` lists it. */
export interface Run {
  readonly id: number;
  readonly event: string;
  readonly path: string;
  readonly head_sha: string;
  readonly head_branch: string | null;
  readonly head_repository: Repo | null;
}

/** A run's job, as GitHub's `actions/runs/<id>/jobs` lists it. */
export interface Job {
  readonly id: number;
  readonly name: string;
  readonly conclusion: string | null;
  readonly steps?: ReadonlyArray<{ readonly name: string; readonly conclusion: string | null }>;
}

/** A pull request merged by a commit. */
export interface Merged {
  readonly number: number;
  /** Its final head. */
  readonly head: string;
  readonly branch: string;
}

/**
 * The pull request `merge` merged, from GitHub's `commits/<sha>/pulls`: merged into main, by that
 * commit, from a branch in `repo`. None when no one or more than one is.
 */
export const mergedBy = (pulls: ReadonlyArray<Pull>, merge: string, repo: string): Merged | undefined => {
  const found = pulls.filter(
    (pull) =>
      pull.merged_at !== null &&
      pull.merge_commit_sha === merge &&
      pull.base.ref === mainBranch &&
      pull.base.repo.full_name === repo &&
      pull.head.repo?.full_name === repo,
  );
  const [pull] = found;
  if (pull === undefined || found.length > 1 || !sha.test(pull.head.sha)) return undefined;

  return { number: pull.number, head: pull.head.sha, branch: pull.head.ref };
};

/**
 * The id of the pull request's last run of the workflow on its final head: a `pull_request` event
 * from its branch in `repo`. Only the last counts, passed or not, as it's the one the merge went by.
 */
export const lastRun = (runs: ReadonlyArray<Run>, pull: Merged, repo: string) =>
  runs
    .filter(
      (run) =>
        run.event === 'pull_request' &&
        run.path === workflowPath &&
        run.head_sha === pull.head &&
        run.head_branch === pull.branch &&
        run.head_repository?.full_name === repo,
    )
    .reduce<number | undefined>((newest, run) => Math.max(newest ?? run.id, run.id), undefined);

/**
 * Why a run's jobs, its latest attempt's, don't pass the component, or the id of its plan's job
 * when they do. Each job in `passingJobs` appears once and succeeded, with each of its steps there,
 * so a second job of the same name can't stand in for one, and the plan's job appears once.
 */
export const componentPassed = (jobs: ReadonlyArray<Job>, required = passingJobs): { plan: number } | { why: string } => {
  const named = (name: string) => jobs.filter((job) => job.name === name);

  for (const [name, steps] of required) {
    const [job, ...more] = named(name);
    if (job === undefined) return { why: `it didn't run "${name}"` };

    if (more.length > 0) return { why: `it has ${String(more.length + 1)} jobs named "${name}"` };

    if (job.conclusion !== 'success') return { why: `"${name}" ended ${String(job.conclusion)}` };

    for (const step of steps) {
      const [ran, ...again] = (job.steps ?? []).filter((each) => each.name === step);
      if (ran?.conclusion !== 'success' || again.length > 0) return { why: `"${name}" didn't pass its step "${step}"` };
    }
  }

  const [plan, ...more] = named(planJob);
  if (plan === undefined || more.length > 0) return { why: 'its plan job is unclear' };

  return { plan: plan.id };
};

/** A record's JSON, or nothing when it isn't JSON. */
const recordOf = (text: string) => {
  try {
    // A line the plan's record step printed, with jq, as an object; each field is checked where
    // it's read.
    return JSON.parse(text) as { kind?: unknown; sha?: unknown } | null;
  } catch {
    return null;
  }
};

/** The commit a run tested, from the first plan record in its plan's log. */
export const testedCommit = (log: string) => {
  for (const line of log.split('\n')) {
    const at = line.indexOf(recordPrefix);
    if (at === -1) continue;

    const record = recordOf(line.slice(at + recordPrefix.length).trim());
    if (record?.kind !== 'plan') continue;

    return typeof record.sha === 'string' && sha.test(record.sha) ? record.sha : undefined;
  }

  return undefined;
};

/** A commit's parents, from `git cat-file commit`'s text: the header, before its first blank line. */
export const parentsOf = (commit: string) =>
  (commit.split('\n\n')[0] ?? '').split('\n').flatMap((line) => (line.startsWith('parent ') ? [line.slice('parent '.length)] : []));

const spawn = (command: string, args: ReadonlyArray<string>) => spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const run = (command: string, args: ReadonlyArray<string>) => {
  const done = spawn(command, args);
  if (done.status !== 0) throw new Error(`${command} ${args[0] ?? ''} failed: ${done.stderr}`);

  return done.stdout;
};

/** A GitHub API path's JSON, which the caller names the documented shape of. */
const api = <A>(path: string) => JSON.parse(run('gh', ['api', path])) as A;

/**
 * A job's log. Its lines hold terminal colours, which a newer `gh` prints only when asked and an
 * older one doesn't know how to be asked.
 */
const logOf = (repo: string, job: number) => {
  const path = `repos/${repo}/actions/jobs/${String(job)}/logs`;
  const asked = spawn('gh', ['api', '--allow-escape-sequences', path]);
  if (asked.status === 0) return asked.stdout;

  if (!asked.stderr.includes('unknown flag')) throw new Error(`gh api failed: ${asked.stderr}`);

  return run('gh', ['api', path]);
};

/** Every job of a run's latest attempt, a page of 100 at a time. */
const jobsOf = (repo: string, id: number) => {
  const jobs: Array<Job> = [];

  for (let page = 1; ; page += 1) {
    const got = api<{ total_count: number; jobs: ReadonlyArray<Job> }>(`repos/${repo}/actions/runs/${String(id)}/jobs?filter=latest&per_page=100&page=${String(page)}`);
    jobs.push(...got.jobs);

    if (got.jobs.length === 0 || jobs.length >= got.total_count) return jobs;
  }
};

/** The run whose pass the merge records, or why there's none. */
const passOf = (merge: string, repo: string): { run: number } | { why: string } => {
  const key = keyOf(sourceAt(merge));

  const pull = mergedBy(api<ReadonlyArray<Pull>>(`repos/${repo}/commits/${merge}/pulls`), merge, repo);
  if (pull === undefined) return { why: `no one pull request from ${repo} merged ${merge}` };

  const workflow = workflowPath.split('/').pop() ?? '';
  const runs = api<{ workflow_runs: ReadonlyArray<Run> }>(`repos/${repo}/actions/workflows/${workflow}/runs?event=pull_request&head_sha=${pull.head}&per_page=100`);
  const id = lastRun(runs.workflow_runs, pull, repo);
  if (id === undefined) return { why: `#${String(pull.number)} has no run of ${workflow} on ${pull.head}` };

  const passed = componentPassed(jobsOf(repo, id));
  if ('why' in passed) return { why: `#${String(pull.number)}'s last run, ${String(id)}: ${passed.why}` };

  const tested = testedCommit(logOf(repo, passed.plan));
  if (tested === undefined) return { why: `run ${String(id)}'s plan names no commit it tested` };

  // The synthetic merge commit GitHub tested: its second parent must be the pull request's head.
  run('git', ['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', tested]);
  const parents = parentsOf(run('git', ['cat-file', 'commit', tested]));
  if (parents.length !== 2 || parents[1] !== pull.head) return { why: `run ${String(id)} tested ${tested}, which doesn't merge #${String(pull.number)}'s head` };

  const testedKey = keyOf(sourceAt(tested));
  if (testedKey !== key) return { why: `run ${String(id)} tested ${tested}, whose key, ${testedKey}, isn't ${merge}'s, ${key}: main moved what it reads since` };

  return { run: id };
};

if (argv[1] === fileURLToPath(import.meta.url)) {
  const [merge = '', ...rest] = argv.slice(2);

  if (rest.length > 0 || !sha.test(merge)) {
    console.error('usage: node scripts/reuse/merge-pass.ts <sha>');
    exit(2);
  }

  try {
    const pass = passOf(merge, env['GITHUB_REPOSITORY'] ?? '<org>/<repo>');
    if ('why' in pass) console.error(`No pass from the merged pull request: ${pass.why}.`);
    else console.log(pass.run);
  } catch (error) {
    console.error(`No pass from the merged pull request, as ${String(error)}`);
    exit(1);
  }
}
