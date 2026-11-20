/**
 * test-claims.ts: the queue a CI run's test shards share. Each shard runs its own files from the
 * plan, then claims the queue's batches one at a time, so a shard on a fast machine takes more of
 * them and one on a slow machine fewer (`test-shards.ts`). One runner ran a shard's files up to 1.6
 * times as long as the median shard's.
 *
 * Where it runs: imported by `test-lanes.ts` in each test shard. Node's built-in modules only.
 *
 * How a claim works: it reserves a key in the Actions cache, which takes a key once. The first shard
 * to reserve `<prefix>-<batch>` owns the batch; every other shard's reservation is refused with 409.
 * The prefix carries the run's ID and attempt, and the cache scopes reservations by branch, so
 * neither another run nor another branch can take a run's batches.
 *
 * Measured: 10 and 20 jobs raced for 540 keys each, and exactly one won each key. A claim took a
 * small fraction of a second, with a tight tail. A key reserved but never saved stayed reserved
 * minutes later. A run on another branch could reserve the first run's keys again.
 *
 * Each batch a shard owns is a line in its claims file, written before its files run. The shard
 * keeps that file in the Actions cache too, under a key per attempt (`ci-cache.ts`). A final CI job
 * reads them to check that every batch had an owner, and a rerun of the shard reads them to run its
 * batches again.
 *
 * Configure: nothing here. The cache's address and token come from the `ci-cache` action.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { cacheService } from './ci-cache.ts';

/**
 * What a claim found: the batch is this shard's, another's, or unknown after every retry failed.
 * An unknown batch runs here too, since a reservation that failed to answer may still have taken
 * the key, and then no other shard would run it. Duplicate work beats a lost batch.
 */
export type Claim = 'won' | 'lost' | 'unsure';

/** Waits before each retry of a claim that got no answer: three tries in all. */
const retries = [250, 1000];

/** The version every claim's key is reserved under. The cache requires one, and any will do. */
const claimVersion = createHash('sha256').update('test-claims').digest('hex');

/** Whether the cache's answer to a reservation says it made it: `{ ok: true, ... }`. */
const reservedOk = (text: string) => {
  try {
    const reply: unknown = JSON.parse(text);

    return typeof reply === 'object' && reply !== null && (reply as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
};

/** The Actions cache's address and token, which only a JavaScript action sees, and the prefix. */
export interface CacheClaims {
  readonly url: string;
  readonly token: string;
  readonly prefix: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly wait?: (ms: number) => Promise<void>;
}

/** Claims each batch by reserving `<prefix>-<batch>` in the Actions cache. */
export const cacheClaims =
  ({ url, token, prefix, fetch = globalThis.fetch, wait = sleep }: CacheClaims) =>
  async (batch: number): Promise<Claim> => {
    const endpoint = cacheService(url, 'CreateCacheEntry');

    for (const delay of [0, ...retries]) {
      if (delay > 0) await wait(delay);

      const answer = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ key: `${prefix}-${batch}`, version: claimVersion }),
        signal: AbortSignal.timeout(10_000),
      }).then(
        async (response) => ({ status: response.status, text: await response.text() }),
        () => ({ status: 0, text: '' }),
      );
      if (answer.status === 409) return 'lost';

      if (answer.status === 200 && reservedOk(answer.text)) return 'won';
    }

    return 'unsure';
  };

/** A line of a shard's claims file: the batch, and `unsure` when its claim got no answer. */
export const claimLine = (batch: number, claim: Exclude<Claim, 'lost'>) =>
  claim === 'won' ? `${batch}\n` : `${batch} unsure\n`;

/** The batches a claims file names. */
export const claimedIn = (text: string) =>
  text.split('\n').flatMap((line) => {
    const batch = /^(\d+)( unsure)?$/.exec(line)?.[1];

    return batch === undefined ? [] : [Number(batch)];
  });
