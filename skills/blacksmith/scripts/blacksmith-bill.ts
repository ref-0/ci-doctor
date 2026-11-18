#!/usr/bin/env node
/**
 * What: the Blacksmith adapter for ci-workflows' ci-time.ts: each job's billed vCPU-minutes from
 *   Blacksmith's job records, and a job's CPU from its stats.
 * Where: loaded by `ci-time.ts --bill blacksmith`, from this folder when the blacksmith skill is
 *   installed beside ci-workflows, or from `--adapter-dir`.
 * Configure: nothing here. Needs Node 24 and the `blacksmith` CLI, logged in to <org> by a person
 *   (`blacksmith auth login`). It never reads the CLI's credentials.
 * Tests: `node --test blacksmith-bill.test.ts`, from this folder.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * Blacksmith bills a job's started minutes times its vCPUs, and its `jobs list` records carry that as
 * `billable_minutes`, already multiplied. Its records name a run and a job by name, not by GitHub's job
 * ID, so a run's jobs of one name add up across every attempt, while ci-time.ts times only the latest.
 * It asks for records back to `since`, in whole days, and pages until it passes it. A run with no record
 * here falls back to ci-time.ts's label estimate, which ci-time.ts counts apart.
 *
 * An adapter is a module named `<provider>-bill.ts` that exports two functions, each given ci-time.ts's
 * `run` (which runs a command and returns its stdout, and throws when the command fails):
 * - `billed(repo, workflowName, runIds, since, run)` maps run id, then job name, to billed vCPU-minutes;
 * - `cpu(jobId, run)` returns a short CPU summary for one job, or null.
 */

/** Runs a command, as `run('blacksmith', 'jobs', ...)`, and returns its stdout. */
export type Run = (...args: string[]) => string;
/** Billed vCPU-minutes by run id, then by job name. */
export type Bill = Record<string, Record<string, number>>;

type JobRecord = { run_id: number | string; job_name: string; billable_minutes: number; created_at: string };
type Page = { jobs?: JobRecord[]; next_cursor?: string | null };

export const when = (stamp: string) => Date.parse(stamp) / 1000;

/** Blacksmith's job records for `runIds`, paged back until `since`, as run id -> job name -> vCPU-minutes. */
export function billed(repo: string, workflowName: string, runIds: ReadonlySet<string>, since: number, run: Run, now?: number): Bill {
  const found: Bill = {};
  let cursor: string | null | undefined;
  const days = Math.max(1, Math.ceil(((now ?? Date.now() / 1000) - since) / 86400));

  while (true) {
    const args = ['blacksmith', 'jobs', 'list', '--repo', repo, '--workflow', workflowName, '--since', `${days}d`,
      '--limit', '200', '--format', 'json'];
    const page = JSON.parse(run(...args, ...(cursor ? ['--cursor', cursor] : []))) as Page;
    const jobs = page.jobs ?? [];
    for (const job of jobs) {
      const id = String(job.run_id);
      if (!runIds.has(id)) continue;
      const byName = (found[id] ??= {});
      byName[job.job_name] = (byName[job.job_name] ?? 0) + job.billable_minutes;
    }

    cursor = page.next_cursor;
    if (!cursor || !jobs.length || Math.min(...jobs.map((j) => when(j.created_at))) < since) return found;
  }
}

/** A job's CPU p50 and p90 from `blacksmith jobs stats`, or null when it has no metrics. */
export function cpu(jobId: number | string, run: Run): string | null {
  try {
    const stats = JSON.parse(run('blacksmith', 'jobs', 'stats', String(jobId), '--format', 'json'));
    const aggregates = stats.vm_metrics.cpu.aggregates;
    if (typeof aggregates.p50 !== 'number' || typeof aggregates.p90 !== 'number') return null;
    return `CPU p50 ${aggregates.p50.toFixed(0)}%, p90 ${aggregates.p90.toFixed(0)}%`;
  } catch {
    return null;
  }
}
