#!/usr/bin/env node
/**
 * ci-records.ts: collects CI's records. It writes one line of JSON for each attempt of each
 * finished run of your CI workflow, with what its plan chose and what each test job ran and failed.
 *
 *     node scripts/records/ci-records.ts [--since <YYYY-MM-DD>] [--until <YYYY-MM-DD>] [--out <file.jsonl>] [--calls <n>] [--used <file>]
 *     node scripts/records/ci-records.ts --run <run id>
 *
 * Where it runs: on a maintainer's machine, from a nightly timer (`ci-records.sh` and its systemd
 * units). Not in CI, and not by agents: a week's backfill once used up the 5,000-an-hour API quota
 * that every `gh` on the login shares.
 *
 * Configure: the config block below (`REPO`, `WORKFLOW`, `RECORDED_JOBS`, `PLAN_JOB`), or the
 * `--repo` and `--workflow` flags. `RECORD_PREFIX` must match `test-record.ts`'s. Needs `gh`,
 * signed in, and Node 24 or later. No npm dependencies.
 *
 * How it works:
 *   - Each run's plan prints one `plan` record, and each Vitest run in a test job prints one `tests`
 *     record (`test-record.ts`). This reads those lines back from the jobs' logs, which GitHub keeps
 *     for 90 days, so collect them before then.
 *   - It reads one log zip per attempt, holding every job's log, so an attempt costs about 3 calls
 *     however many jobs it has. It reads 6 attempts at once.
 *   - It stops after `--calls` API calls (1,500 by default), or while fewer than 1,000 of the
 *     hour's calls are left for everything else, or when GitHub refuses one for the rate limit.
 *     It counts its own calls, as GitHub's count of what's left lags behind a burst. It exits 3
 *     when it stops early.
 *   - With `--out`, it appends only the attempts the file doesn't hold yet, so a second run goes on
 *     from where the first stopped.
 *   - A record whose recorded job's log it couldn't read has `complete: false` and names the job
 *     in `unreadable`. The next collection of that day drops and reads it again, until GitHub's
 *     90 days have dropped the logs; then it stays, incomplete. Leave incomplete records out of
 *     clean-run and timing claims.
 *   - It lists one day at a time: GitHub lists at most 1,000 runs for one query. A day past that is
 *     listed an hour at a time, and a listing that still falls short of GitHub's count is reported.
 *   - With `--used <file>`, it writes the API calls it made there on exit, for `ci-records.sh`'s
 *     nightly budget.
 *   - `--run <id>` prints one run's attempts: before enabling the timer, compare its jobs and
 *     record counts with the run's page.
 *   - `--since` defaults to 7 days ago and `--until` to today, both whole days in UTC. A run that
 *     ran no job, such as a draft's, is left out. `--run` prints one run's attempts, finished or not.
 *
 * A record is `{ run, attempt, event, branch, sha, created, conclusion, complete, unreadable, plan,
 * jobs, job_timings }`. `plan` is the plan's record, or null. Each test job has its name, its
 * conclusion, and `tests`: each Vitest run's record, or null when its log can't be read.
 * `job_timings` keeps the labels and timestamps of every job in the attempt.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { parseArgs, promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';

// ---- Config -------------------------------------------------------------------------------------

/** The repository whose runs to read. `--repo` overrides it. */
const REPO = '<org>/<repo>';

/** The workflow file whose runs to read. `--workflow` overrides it. */
const WORKFLOW = 'ci.yml';

/** The jobs whose logs hold records: the plan, and every job that runs Vitest. Match your names. */
const RECORDED_JOBS = /^(Plan$|Tests |Slow tests$|Sandbox )/;

/** The plan job's name: its record goes in `plan`, not in `jobs`. */
const PLAN_JOB = 'Plan';

/** What starts each record's line in a log. Keep it equal to `test-record.ts`'s. */
export const RECORD_PREFIX = 'ci-record ';

/** The default API-call cap for one collection. */
const DEFAULT_CALLS = 1500;

/** The fewest of the hour's API calls this leaves for every other `gh` on the login. */
const CALL_FLOOR = 1000;

/** How many attempts are read at once. Each read waits on GitHub, not on this machine. */
const READS_AT_ONCE = 6;

/** The most runs GitHub lists for one query. */
const LIST_CAP = 1000;

/** How long GitHub keeps a run's logs, in days: an incomplete record older can't be completed. */
const LOG_DAYS = 90;

// -------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null;

/**
 * A plan record, as your plan job prints it, e.g.
 * `echo "ci-record $(jq -nc '{kind:"plan", event:..., sha:..., changed:..., packages:..., sandbox:...}')"`.
 * Only `kind` is checked; the other fields are yours.
 */
const isPlanRecord = (value: unknown) => isObject(value) && value['kind'] === 'plan';

/** A tests record, as `test-record.ts` prints it. */
const isTestsRecord = (value: unknown) =>
  isObject(value) &&
  value['kind'] === 'tests' &&
  Array.isArray(value['files']) &&
  Array.isArray(value['failed']) &&
  Array.isArray(value['flaky']) &&
  typeof value['errors'] === 'number';

/** Each record printed in a job's log, in order. A line that isn't a record's JSON is skipped. */
export const recordsIn = (log: string): ReadonlyArray<Json> =>
  log.split('\n').flatMap((line) => {
    const at = line.indexOf(RECORD_PREFIX);
    if (at === -1) return [];

    try {
      const value: unknown = JSON.parse(line.slice(at + RECORD_PREFIX.length));

      return isPlanRecord(value) || isTestsRecord(value) ? [value as Json] : [];
    } catch {
      return [];
    }
  });

interface Run {
  readonly id: number;
  readonly run_attempt: number;
  readonly event: string;
  readonly head_branch: string;
  readonly head_sha: string;
  readonly created_at: string;
  readonly conclusion: string | null;
}

interface Job {
  readonly id: number;
  readonly name: string;
  readonly conclusion: string | null;
  readonly labels: ReadonlyArray<string>;
  readonly created_at: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

const asRun = (value: unknown): Run => {
  if (
    !isObject(value) ||
    typeof value['id'] !== 'number' ||
    typeof value['run_attempt'] !== 'number' ||
    typeof value['created_at'] !== 'string'
  )
    throw new Error(`not a run: ${JSON.stringify(value)}`);

  return value as unknown as Run;
};

const asJob = (value: unknown): Job => {
  if (!isObject(value) || typeof value['id'] !== 'number' || typeof value['name'] !== 'string')
    throw new Error(`not a job: ${JSON.stringify(value)}`);

  return value as unknown as Job;
};

/** A record already in the file `--out` names. */
const asHeld = (value: unknown) => {
  if (!isObject(value) || typeof value['run'] !== 'number' || typeof value['attempt'] !== 'number')
    throw new Error('not a record');

  return { run: value['run'], attempt: value['attempt'] };
};

/**
 * The lines of an `--out` file to keep, and the attempts they hold. A record from `since` to `until`
 * with `complete: false` is dropped, so this collection reads it again, unless its logs are past
 * GitHub's keeping (`now`, in ms, decides).
 */
export const heldIn = (text: string, since: string, until: string, now: number) => {
  const kept: Array<string> = [];
  const held = new Set<string>();
  let dropped = 0;

  for (const line of text.split('\n')) {
    if (line === '') continue;

    const value: unknown = JSON.parse(line);
    const { run, attempt } = asHeld(value);
    const created = isObject(value) && typeof value['created'] === 'string' ? Date.parse(value['created']) : Number.NaN;
    const retry =
      isObject(value) &&
      value['complete'] === false &&
      Number.isFinite(created) &&
      dayOf(created) >= since &&
      dayOf(created) <= until &&
      now - created < (LOG_DAYS - 1) * day;

    if (retry) {
      dropped += 1;
      continue;
    }

    kept.push(line);
    held.add(`${run}/${attempt}`);
  }

  return { kept, held, dropped };
};

/** Each line of some JSON lines, decoded. */
const linesOf = <A>(decode: (value: unknown) => A, text: string) =>
  text.split('\n').flatMap((line) => (line === '' ? [] : [decode(JSON.parse(line))]));

/**
 * The files of a zip GitHub sends, such as a run's logs: each stored or deflated, in one disk, with
 * no zip64. Enough for those, not for any zip.
 */
export const unzipEntries = (zip: Buffer) => {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a zip');

  const count = zip.readUInt16LE(end + 10);
  const entries: Array<{ name: string; data: Buffer }> = [];

  for (let at = zip.readUInt32LE(end + 16), index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('bad zip directory');

    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);

    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip entry');

    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new Error('unknown zip method');

    entries.push({ name, data: method === 0 ? data : inflateRawSync(data) });
  }

  return entries;
};

/** The API calls this has made, which `--calls` caps. `rate_limit` costs none, so isn't counted. */
let calls = 0;

const gh = (...args: ReadonlyArray<string>) => {
  if (args[0] !== 'rate_limit') calls += 1;

  return execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });
};

const execGh = promisify(execFile);

/** `gh api`, without waiting on it, so several attempts are read at once. */
const ghAsync = async (...args: ReadonlyArray<string>) => {
  calls += 1;

  return (await execGh('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 1 << 30 })).stdout;
};

/** `gh api` for a binary answer, such as a zip. */
const ghBytes = async (...args: ReadonlyArray<string>) => {
  calls += 1;

  return (await execGh('gh', ['api', ...args], { encoding: 'buffer', maxBuffer: 1 << 30 })).stdout;
};

/** Whether gh's failure, as text, says GitHub refused the call for the login's rate limit. */
const rateLimited = (failure: string) => /rate limit exceeded/i.test(failure);

const day = 24 * 60 * 60 * 1000;

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

const isDay = (text: string) =>
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text) && dayOf(Date.parse(text)) === text;

const callsLeft = () => Number(gh('rate_limit', '--jq', '.resources.core.remaining').trim());

/** A run's fields, as `--jq` prints them. */
const runFields = '{id, run_attempt, event, head_branch, head_sha, created_at, conclusion} | @json';

const usage = () => {
  console.error(`usage: node ci-records.ts [--repo <org>/<repo>] [--workflow <file>] [--since <YYYY-MM-DD>] [--until <YYYY-MM-DD>] [--out <file.jsonl>] [--calls <n>]
       node ci-records.ts [--repo <org>/<repo>] --run <run id>`);

  return 2;
};

/** A job's name as its file in a run's log zip has it, `<n>_<name>.txt`, with only letters and digits. */
export const zipKey = (name: string) => name.replace(/[^A-Za-z0-9]+/g, '');

const collector = (repo: string) => {
  /** A job's log, or undefined while it runs or once GitHub has dropped it. */
  const logOf = async (id: number) => {
    try {
      return await ghAsync(`repos/${repo}/actions/jobs/${id}/logs`, '--allow-escape-sequences');
    } catch (error) {
      if (rateLimited(String(error))) throw error;

      return undefined;
    }
  };

  /** Each job's whole log in an attempt's log zip, by its `zipKey`: one call for all of them. */
  const logsOf = async (run: number, attempt: number) => {
    try {
      const zip = await ghBytes(`repos/${repo}/actions/runs/${run}/attempts/${attempt}/logs`);

      return new Map(
        unzipEntries(zip).flatMap(({ name, data }) => {
          const job = /^[0-9]+_(.+)\.txt$/.exec(name)?.[1];

          return job === undefined ? [] : [[zipKey(job), data.toString('utf8')] as const];
        }),
      );
    } catch (error) {
      if (rateLimited(String(error))) throw error;

      return undefined;
    }
  };

  return async (run: Run, attempt: number) => {
    const jobs = linesOf(
      asJob,
      await ghAsync(
        '--paginate',
        `repos/${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`,
        '--jq',
        '.jobs[] | {id, name, conclusion, labels, created_at, started_at, completed_at} | @json',
      ),
    );
    const recorded = jobs.filter(
      (job) => job.conclusion !== 'skipped' && RECORDED_JOBS.test(job.name),
    );
    const logs = recorded.length === 0 ? undefined : await logsOf(run.id, attempt);
    // A job the zip doesn't hold under its name is read on its own.
    const read = await Promise.all(
      recorded.map(async (job) => {
        const log = logs?.get(zipKey(job.name)) ?? (await logOf(job.id));

        return { job, records: log === undefined ? undefined : recordsIn(log) };
      }),
    );
    const unreadable = read.flatMap(({ job, records }) => (records === undefined ? [job.name] : []));

    return {
      run: run.id,
      attempt,
      event: run.event,
      branch: run.head_branch,
      sha: run.head_sha,
      created: run.created_at,
      // The run's own conclusion is its latest attempt's.
      conclusion:
        attempt === run.run_attempt
          ? run.conclusion
          : (
              await ghAsync(
                `repos/${repo}/actions/runs/${run.id}/attempts/${attempt}`,
                '--jq',
                '.conclusion',
              )
            ).trim(),
      complete: unreadable.length === 0,
      unreadable,
      plan:
        read.flatMap(({ records }) => records ?? []).find(({ kind }) => kind === 'plan') ?? null,
      job_timings: jobs.map(({ id, name, conclusion, labels, created_at, started_at, completed_at }) => ({
        id,
        name,
        conclusion,
        labels: labels ?? [],
        created_at: created_at ?? null,
        started_at: started_at ?? null,
        completed_at: completed_at ?? null,
      })),
      jobs: read.flatMap(({ job, records }) =>
        job.name === PLAN_JOB
          ? []
          : [
              {
                name: job.name,
                conclusion: job.conclusion,
                tests: records?.filter(({ kind }) => kind === 'tests') ?? null,
              },
            ],
      ),
    };
  };
};

const main = async (args: ReadonlyArray<string>) => {
  const { values } = parseArgs({
    args: [...args],
    options: {
      repo: { type: 'string' },
      workflow: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      out: { type: 'string' },
      run: { type: 'string' },
      calls: { type: 'string' },
      used: { type: 'string' },
    },
  });
  const used = values.used;
  if (used !== undefined) process.on('exit', () => writeFileSync(used, `${calls}\n`));

  const repo = values.repo ?? REPO;
  const workflow = values.workflow ?? WORKFLOW;
  if (repo.includes('<')) {
    console.error('ci-records: set REPO in the config block, or pass --repo <org>/<repo>.');

    return 2;
  }

  const recordOf = collector(repo);

  if (values.run !== undefined) {
    if (!/^[0-9]+$/.test(values.run)) return usage();

    const [run] = linesOf(asRun, gh(`repos/${repo}/actions/runs/${values.run}`, '--jq', runFields));
    if (run === undefined) return 1;

    for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) {
      process.stdout.write(`${JSON.stringify(await recordOf(run, attempt))}\n`);
    }

    return 0;
  }

  const today = new Date().toISOString().slice(0, 10);
  const since = values.since ?? dayOf(Date.parse(today) - 7 * day);
  const until = values.until ?? today;
  if (!isDay(since) || !isDay(until)) return usage();

  const cap = Number(values.calls ?? DEFAULT_CALLS);
  if (!Number.isInteger(cap) || cap < 1) return usage();

  const out = values.out;
  let held = new Set<string>();
  if (out !== undefined && existsSync(out)) {
    const file = heldIn(readFileSync(out, 'utf8'), since, until, Date.now());
    held = file.held;
    if (file.dropped > 0) {
      writeFileSync(out, file.kept.map((line) => `${line}\n`).join(''));
      console.error(`ci-records: reading ${file.dropped} incomplete attempts again.`);
    }
  }

  /** A window's completed runs, and how many GitHub says it holds. */
  const listed = (created: string) => {
    const query = `repos/${repo}/actions/workflows/${workflow}/runs?status=completed&created=${created}`;
    const total = Number(gh(`${query}&per_page=1`, '--jq', '.total_count').trim());
    const runs = total === 0 ? [] : linesOf(asRun, gh('--paginate', `${query}&per_page=100`, '--jq', `.workflow_runs[] | ${runFields}`));

    return { runs, total };
  };

  /** A day's runs: whole, or an hour at a time past GitHub's cap, warning of any it can't list. */
  const runsOn = (date: string) => {
    const whole = listed(date);
    const parts =
      whole.total <= LIST_CAP
        ? [whole]
        : Array.from({ length: 24 }, (_, hour) => {
            const at = `${date}T${String(hour).padStart(2, '0')}`;

            return listed(`${at}:00:00Z..${at}:59:59Z`);
          });
    const runs = parts.flatMap((part) => part.runs);
    if (runs.length < whole.total) {
      console.error(`ci-records: listed ${runs.length} of the ${whole.total} runs GitHub counts on ${date}; that day's records are incomplete.`);
    }

    return runs;
  };

  const stop = (at: number, why: string) => {
    console.error(
      `ci-records: stopped at ${dayOf(at)}, after ${calls} API calls, ${why}. Every gh on this login shares the hour's 5,000. Run it again later; with --out it goes on from here.`,
    );

    return 3;
  };

  // A day at a time: GitHub lists at most 1,000 runs for one query, and a busy day can pass 400.
  for (let at = Date.parse(since); at <= Date.parse(until); at += day) {
    if (calls >= cap) return stop(at, `its cap of ${cap}`);

    let runs: ReadonlyArray<Run>;

    try {
      runs = runsOn(dayOf(at));
    } catch (error) {
      if (rateLimited(String(error))) return stop(at, 'as GitHub refused one for the rate limit');
      throw error;
    }

    // A draft's run, and one waiting for approval, ran no job, so it has nothing to record.
    const attempts = runs.flatMap((run) =>
      run.conclusion === 'skipped' || run.conclusion === 'action_required'
        ? []
        : Array.from({ length: run.run_attempt }, (_, index) => index + 1).flatMap((attempt) =>
            held.has(`${run.id}/${attempt}`) ? [] : [{ run, attempt }],
          ),
    );

    for (let first = 0; first < attempts.length; first += READS_AT_ONCE) {
      if (calls >= cap) return stop(at, `its cap of ${cap}`);

      const left = callsLeft();
      if (left < CALL_FLOOR) return stop(at, `with ${left} of the hour's left`);

      let records;

      try {
        records = await Promise.all(
          attempts
            .slice(first, first + READS_AT_ONCE)
            .map(({ run, attempt }) => recordOf(run, attempt)),
        );
      } catch (error) {
        if (rateLimited(String(error))) return stop(at, 'as GitHub refused one for the rate limit');
        throw error;
      }

      const lines = records.map((record) => `${JSON.stringify(record)}\n`).join('');
      if (out === undefined) process.stdout.write(lines);
      else appendFileSync(out, lines);
    }
  }

  return 0;
};

if (import.meta.main) exit(await main(argv.slice(2)));
