#!/usr/bin/env node
/**
 * times-fold.ts: between sweeps, the default branch's shard times take the new files its merged pull
 * requests' runs timed, from those runs' `test-times-<sha>` artifacts, and only from artifacts it can
 * trace to this repo's CI workflow run of the exact commit that merged.
 *
 *     node scripts/shards/times-fold.ts due <times.json> --sha <sha> [--merges <n>] [--hours <n>]
 *     node scripts/shards/times-fold.ts fold <times.json> --sha <sha> --out <folded.json>
 *
 * Where it runs: `due` in each merge's `report` job on the default branch, a cache restore and two
 * API calls; `fold` in the fold job it starts, which shares one concurrency group with the sweep's
 * test-times job, so the stored times have one writer at a time.
 *
 * - `due` prints `due=true` or `due=false`, for `$GITHUB_OUTPUT`, and why on stderr. A fold is due
 *   once `--merges` merges have landed since the stored times' `through`, counted as first-parent
 *   commits, or `--hours` hours have passed since their last fold (`foldedAt`), whichever comes
 *   first. Never while a sweep or server slot runs: its test-times job would wait in the group,
 *   and GitHub replaces a waiting job with a newer one, so a fold queued then could throw away the
 *   sweep's refresh. Stored times with no `through` start folding from this merge.
 * - `fold` writes the stored times with the new files of every merge since their `through`, and
 *   `through` moved to `--sha`. It writes nothing when `--sha` isn't ahead of `through`, as when an
 *   older merge's fold runs after a newer one's.
 * - An artifact counts only if GitHub says it came from a `pull_request` or `merge_group` run of this
 *   repo's own workflow file (`GITHUB_WORKFLOW_REF`, or `--workflow`) on that pull request's head
 *   commit, or the merge queue's: that run ran the code that merged. Its archive and its times file
 *   are each held to `artifactBytes`, and its files to the checkout's (`git ls-files`); `merged`
 *   holds each time to `longestFile` and each run's date to the present.
 *
 * Env: `GITHUB_REPOSITORY`, `GITHUB_REF_NAME`, `GITHUB_WORKFLOW_REF` and `RUNNER_TEMP`, as Actions
 * sets them, and `gh`, logged in with `actions: read`, `contents: read` and, for `fold`, `pull-requests: read`.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argv, env, exit, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { merged } from './test-shards.ts';

// ---- Config --------------------------------------------------------------------------------------

/**
 * The most bytes an artifact's archive, or the times file in it, may hold. An example value, far
 * above a run's times, each file's entry being a path and its samples.
 */
export const artifactBytes = 4 * 1024 * 1024;

/** The file the pull request's `report` puts in its artifact. */
export const timesFile = 'run-times.json';

/** The events whose runs ran a merged commit's code, and so may hand on its times. */
const trustedEvents = new Set(['pull_request', 'merge_group']);

/** Whether a run is a sweep or server slot, by the titles ci.yml's run-name gives them. */
export const isSweep = (title: string, branch: string) =>
  title.startsWith(`CI on ${branch}, `) || title === `Server tests on ${branch}`;

// -------------------------------------------------------------------------------------------------

/** GitHub's compare of two commits, as much of it as this reads. */
export interface Compare {
  readonly status: string;
  readonly total_commits: number;
  readonly commits: ReadonlyArray<{ readonly sha: string; readonly parents: ReadonlyArray<{ readonly sha: string }> }>;
}

/**
 * The first-parent commits from `head` back to `base`, newest first, `base` left out: one for each
 * merge, however many commits a merged branch held. Stops where the compare's list ends, which
 * GitHub cuts at 250 commits.
 */
export const firstParents = (compare: Compare, base: string, head: string) => {
  const parent = new Map(compare.commits.map((commit) => [commit.sha, commit.parents[0]?.sha]));
  const chain = new Array<string>();

  for (let at: string | undefined = head; at !== undefined && at !== base && parent.has(at); at = parent.get(at)) {
    chain.push(at);
  }

  return chain;
};

/** Whether a fold is due, and why, from what `due` read. */
export const isDue = (
  facts: {
    readonly status: string;
    readonly merges: number;
    readonly hours: number;
    readonly sweeping: boolean;
  },
  wants: { readonly merges: number; readonly hours: number },
) => {
  if (facts.status !== 'ahead') return { due: false, why: `this merge isn't ahead of the stored times (${facts.status})` };
  if (facts.sweeping) return { due: false, why: 'a sweep or server slot is running, and refreshes the times itself' };
  if (facts.merges >= wants.merges) return { due: true, why: `${facts.merges} merges since the last fold` };
  if (facts.hours >= wants.hours) return { due: true, why: `${Math.floor(facts.hours)} hours since the last fold` };

  return { due: false, why: `${facts.merges} merges and ${Math.floor(facts.hours)} hours since the last fold` };
};

/** An artifact, as GitHub's artifacts API lists it. */
export interface Artifact {
  readonly id: number;
  readonly name: string;
  readonly size_in_bytes: number;
  readonly expired: boolean;
  readonly created_at: string;
  readonly archive_download_url: string;
  readonly workflow_run?: { readonly id?: number; readonly head_sha?: string; readonly repository_id?: number };
}

/** A workflow run, as GitHub's runs API gives it. */
export interface WorkflowRun {
  readonly id: number;
  readonly path: string;
  readonly event: string;
  readonly head_sha: string;
  readonly repository: { readonly id: number; readonly full_name: string };
}

/** Why `artifact` can't be trusted for `head`'s times, or undefined when it can. */
export const refused = (
  artifact: Artifact,
  run: WorkflowRun | undefined,
  { repo, workflow, head }: { readonly repo: string; readonly workflow: string; readonly head: string },
) => {
  if (artifact.expired) return 'expired';
  if (!(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= artifactBytes)) return 'too big';
  if (artifact.workflow_run?.head_sha !== head) return 'from another commit';
  if (run === undefined || run.id !== artifact.workflow_run?.id) return 'no run';
  if (run.repository.full_name !== repo || run.repository.id !== artifact.workflow_run?.repository_id) return 'from another repo';
  if (run.path.split('@')[0] !== workflow) return 'from another workflow';
  if (!trustedEvents.has(run.event)) return `from a ${run.event} run`;
  if (run.head_sha !== head) return 'from another commit';

  return undefined;
};

/** What `main` reads and writes, so a test can stand in for GitHub, Git and the disk. */
export interface Io {
  /** `gh api <path>`'s output. */
  readonly api: (path: string) => string;
  /** An artifact's archive; throws past `limit` bytes. */
  readonly download: (url: string, limit: number) => Buffer;
  /** `name` from an archive; throws past `limit` bytes or without it. */
  readonly unzip: (archive: Buffer, name: string, limit: number) => string;
  /** The checkout's files. */
  readonly files: () => ReadonlyArray<string>;
  readonly read: (path: string) => string | undefined;
  readonly write: (path: string, text: string) => void;
  readonly log: (line: string) => void;
  readonly now: () => number;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The artifacts `head` may hand on, newest first, and how many were refused and why. */
const trustedFor = (io: Io, repo: string, workflow: string, head: string, refusals: Map<string, number>) => {
  const listed = JSON.parse(io.api(`repos/${repo}/actions/artifacts?name=test-times-${head}&per_page=20`)) as {
    readonly artifacts: ReadonlyArray<Artifact>;
  };
  const trusted = new Array<Artifact>();

  for (const artifact of listed.artifacts.toSorted((one, other) => other.created_at.localeCompare(one.created_at))) {
    const id = artifact.workflow_run?.id;
    const run = id === undefined ? undefined : (JSON.parse(io.api(`repos/${repo}/actions/runs/${id}`)) as WorkflowRun);
    const why = refused(artifact, run, { repo, workflow, head });
    if (why === undefined) trusted.push(artifact);
    else refusals.set(why, (refusals.get(why) ?? 0) + 1);
  }

  return trusted;
};

/** The pull requests' head commits behind each merge: the merge itself, for a merge queue's run, and the PR merged as it. */
const headsOf = (io: Io, repo: string, merges: ReadonlyArray<string>) =>
  [
    ...new Set(
      merges.flatMap((commit) => {
        const pulls = JSON.parse(io.api(`repos/${repo}/commits/${commit}/pulls`)) as ReadonlyArray<{
          readonly merged_at: string | null;
          readonly merge_commit_sha: string | null;
          readonly head: { readonly sha: string };
        }>;

        return [commit, ...pulls.filter((pull) => pull.merged_at !== null && pull.merge_commit_sha === commit).map((pull) => pull.head.sha)];
      }),
    ),
  ];

const usage =
  'Usage: node times-fold.ts due <times.json> --sha <sha> [--merges <n>] [--hours <n>] | fold <times.json> --sha <sha> --out <folded.json> [--workflow <path>]';

/** The CLI; returns its exit code. */
export const main = (args: ReadonlyArray<string>, io: Io): number => {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      sha: { type: 'string' },
      merges: { type: 'string', default: '10' },
      hours: { type: 'string', default: '24' },
      out: { type: 'string' },
      workflow: { type: 'string' },
    },
    allowPositionals: true,
  });
  const [command, timesPath] = positionals;
  const repo = io.env.GITHUB_REPOSITORY ?? '';
  const branch = io.env.GITHUB_REF_NAME ?? 'main';
  const sha = values.sha ?? '';
  if ((command !== 'due' && command !== 'fold') || timesPath === undefined || sha === '' || repo === '' || (command === 'fold' && values.out === undefined)) {
    io.log(usage);
    return 2;
  }

  const stored = io.read(timesPath);
  if (stored === undefined) {
    io.log(`${timesPath}: no stored times; the next sweep writes them.`);
    if (command === 'due') io.write('-', 'due=false\n');
    return 0;
  }
  const { through, foldedAt } = JSON.parse(stored) as { readonly through?: string; readonly foldedAt?: number };
  const compare =
    through === undefined ? undefined : (JSON.parse(io.api(`repos/${repo}/compare/${through}...${sha}`)) as Compare);
  const merges = compare === undefined || through === undefined ? [] : firstParents(compare, through, sha);

  if (command === 'due') {
    const runs = JSON.parse(
      io.api(`repos/${repo}/actions/workflows/${(io.env.GITHUB_WORKFLOW_REF ?? 'ci.yml').replace(/@.*$/, '').split('/').at(-1)}/runs?branch=${branch}&event=workflow_dispatch&per_page=30`),
    ) as { readonly workflow_runs: ReadonlyArray<{ readonly status: string; readonly display_title: string }> };
    const sweeping = runs.workflow_runs.some((run) => run.status !== 'completed' && isSweep(run.display_title, branch));
    const listedAll = compare !== undefined && compare.total_commits <= compare.commits.length;
    const { due, why } =
      compare === undefined
        ? { due: !sweeping, why: sweeping ? 'a sweep is running' : 'the stored times hold no fold yet: they start from this merge' }
        : isDue(
            {
              status: compare.status,
              // Past the compare's 250 commits, the count is at least what it lists.
              merges: listedAll ? merges.length : Math.max(merges.length, compare.total_commits),
              hours: (io.now() - (foldedAt ?? 0)) / 3_600_000,
              sweeping,
            },
            { merges: Number(values.merges), hours: Number(values.hours) },
          );
    io.log(`A fold of the shard times is ${due ? '' : 'not '}due: ${why}.`);
    io.write('-', `due=${String(due)}\n`);
    return 0;
  }

  if (compare !== undefined && compare.status !== 'ahead') {
    io.log(`The stored times already hold ${through}, which ${sha} isn't ahead of (${compare.status}): nothing to fold.`);
    return 0;
  }

  const workflow = values.workflow ?? (io.env.GITHUB_WORKFLOW_REF ?? '').replace(/@.*$/, '').split('/').slice(2).join('/');
  const refusals = new Map<string, number>();
  const texts = new Array<string>();
  const heads = headsOf(io, repo, merges);
  for (const head of heads) {
    for (const artifact of trustedFor(io, repo, workflow, head, refusals)) {
      try {
        texts.push(io.unzip(io.download(artifact.archive_download_url, artifactBytes), timesFile, artifactBytes));
        break;
      } catch (error) {
        const why = `unreadable (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`;
        refusals.set(why, (refusals.get(why) ?? 0) + 1);
      }
    }
  }

  const valid = texts.filter((text) => {
    try {
      JSON.parse(text);
      return true;
    } catch {
      refusals.set('not JSON', (refusals.get('not JSON') ?? 0) + 1);
      return false;
    }
  });
  const { text, added } = merged(valid, {
    fold: stored,
    through: sha,
    foldedAt: io.now(),
    inventory: new Set(io.files()),
    now: io.now(),
  });
  io.write(values.out ?? '', `${text}\n`);
  io.log(
    `Folded ${merges.length} merges: ${valid.length} of ${heads.length} commits' runs handed on times, ${added} new files timed.` +
      (refusals.size === 0 ? '' : ` Refused: ${[...refusals].map(([why, count]) => `${count} ${why}`).join(', ')}.`),
  );
  return 0;
};

/** The real GitHub, Git and disk. */
const realIo = (): Io => {
  const gh = (args: ReadonlyArray<string>, limit = 64 * 1024 * 1024) =>
    execFileSync('gh', ['api', ...args], { maxBuffer: limit, stdio: ['ignore', 'pipe', 'pipe'] });

  return {
    api: (path) => gh([path]).toString('utf8'),
    download: (url, limit) => gh([url], limit),
    unzip: (archive, name, limit) => {
      const dir = mkdtempSync(join(env.RUNNER_TEMP ?? tmpdir(), 'times-fold-'));
      try {
        writeFileSync(join(dir, 'a.zip'), archive);
        return execFileSync('unzip', ['-p', join(dir, 'a.zip'), name], { maxBuffer: limit, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    files: () =>
      execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\0')
        .filter((path) => path !== ''),
    read: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
    write: (path, text) => {
      if (path === '-') stdout.write(text);
      else writeFileSync(path, text);
    },
    log: (line) => console.error(line),
    now: () => Date.now(),
    env,
  };
};

if (argv[1] === fileURLToPath(import.meta.url)) exit(main(argv.slice(2), realIo()));
