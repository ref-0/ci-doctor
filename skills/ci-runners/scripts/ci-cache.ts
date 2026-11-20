#!/usr/bin/env node
/**
 * ci-cache.ts: saves and restores the small files a CI run's own jobs read back, in the Actions
 * cache: each test shard's claims, each test job's flakes, and each shard's times on the default
 * branch.
 *
 *     node scripts/shards/ci-cache.ts save <key> <file>
 *     node scripts/shards/ci-cache.ts restore <folder> <key>...
 *
 * Where it runs: in CI jobs, after the `ci-cache` composite action
 * (`templates/github/actions/ci-cache/`) exposes the cache's address and token. Node's built-in modules only, so a job that installs
 * nothing can run it.
 *
 * Configure: set `CI_CACHE_URL` and `CI_CACHE_TOKEN` from that action's outputs.
 *
 * Why not artifacts: they were artifacts until the organization's artifact storage filled up and
 * GitHub refused every upload, so each shard whose tests passed failed at its bookkeeping upload. A
 * cache entry counts against no artifact quota. On Blacksmith's runners the Actions cache is
 * Blacksmith's own storage, with the same protocol.
 *
 * Why not `actions/cache`: it restores one entry per step, and a run has up to 16 shards and as many
 * container jobs as its plan packs. So this calls the cache service itself, as `actions/cache`
 * does, and keeps each file whole, with no archive.
 *
 * Rules it follows:
 *   - The cache takes a key once, so a job saves under a key with the run's attempt in it, and a
 *     reader restores every key it could need, each attempt's of each job, and takes what it finds:
 *     a missing key is a job that kept nothing.
 *   - Each key ends in a suffix such as `.txt`, so none is a prefix of another: the service also
 *     matches a key by its prefix, and a restore takes only an entry whose key is the one asked for.
 *   - `save` saves nothing when the file is missing (a job with no flake has none) or empty (a
 *     shard that claimed no batch). Blacksmith's cache answered 500 to each upload of an empty file,
 *     and a missing key reads as the same nothing.
 *   - Either command fails when the cache gave no answer after three tries, or refused the save, so
 *     a reader never mistakes a cache that didn't answer for one with nothing in it.
 *   - The cache is scoped by branch: a run reads its own branch's entries and the default branch's,
 *     and writes its own branch's. So every key names the run's ID.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** A method of the Actions cache service, as `actions/cache` calls it, at the cache's address. */
export const cacheService = (url: string, method: string) =>
  `${url.replace(/\/?$/, '/')}twirp/github.actions.results.api.v1.CacheService/${method}`;

/** The version every file is saved under. The cache requires one, and any will do. */
const fileVersion = createHash('sha256').update('ci-cache').digest('hex');

/** Waits before each retry of a call that got no answer: three tries in all. */
const retries = [250, 1000];

/** How many keys a restore looks up at once. */
const lookups = 8;

/** A key this script saves or restores: also the restored file's name, so no folder in it. */
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The Actions cache's address and token, which only a JavaScript action sees. */
export interface Cache {
  readonly url: string;
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly wait?: (ms: number) => Promise<void>;
}

/** An answer: its status and body, or status 0 when the request got none. */
interface Answer {
  readonly status: number;
  readonly body: Uint8Array;
}

/** Each try of `request`, until one answers `done`, or undefined after the third. */
const tries = async (
  { wait = sleep }: Cache,
  request: () => Promise<Answer>,
  done: (answer: Answer) => boolean,
) => {
  for (const delay of [0, ...retries]) {
    if (delay > 0) await wait(delay);

    const answer = await request();
    if (done(answer)) return answer;
  }

  return undefined;
};

/**
 * One request, never thrown: a request that failed, timed out or broke off while its body was
 * read answers with status 0, so `tries` tries it again. A call to the service waits 10 s, as a
 * claim does, and a file's upload or download 30 s, so a cache that stalls ends a restore of a
 * run's flakes, two rounds of eight keys, within about a minute.
 */
const send = (cache: Cache, url: string, init: RequestInit, timeout: number): Promise<Answer> =>
  (cache.fetch ?? globalThis.fetch)(url, { ...init, signal: AbortSignal.timeout(timeout) })
    .then(async (response) => ({
      status: response.status,
      body: new Uint8Array(await response.arrayBuffer()),
    }))
    .catch(() => ({ status: 0, body: new Uint8Array() }));

/**
 * What a call to the cache service sends: a key, its version, and for a commit, its size. Named as
 * `actions/cache` names them, by the protocol's own snake_case field names: Blacksmith's cache
 * refused to commit an entry whose size came as `sizeBytes`.
 */
interface CacheCall {
  readonly key: string;
  readonly version: string;
  readonly restore_keys?: ReadonlyArray<string>;
  readonly size_bytes?: string;
}

/** A call to the cache service, with its JSON body. */
const call = (cache: Cache, method: string, request: CacheCall) =>
  send(
    cache,
    cacheService(cache.url, method),
    {
      method: 'POST',
      headers: { authorization: `Bearer ${cache.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    },
    10_000,
  );

/** The cache service's JSON answer, as far as this reads it, in either case it names fields in. */
interface Reply {
  readonly ok?: boolean;
  readonly signed_upload_url?: string;
  readonly signedUploadUrl?: string;
  readonly signed_download_url?: string;
  readonly signedDownloadUrl?: string;
  readonly matched_key?: string;
  readonly matchedKey?: string;
  readonly message?: string;
}

const replyOf = (answer: Answer): Reply => {
  try {
    // SAFETY: the cache service's JSON, its CacheService's messages, whose fields have these types
    // where they're given; a field left out reads as undefined.
    return (JSON.parse(new TextDecoder().decode(answer.body)) as Reply | null) ?? {};
  } catch {
    return {};
  }
};

const isOk = (answer: Answer) => answer.status === 200 && replyOf(answer).ok === true;

/** Why a call failed, as the service said: its status and its message, never an address. */
const whyOf = (answer: Answer | undefined) => {
  if (answer === undefined || answer.status === 0) return 'no answer';

  const { message } = replyOf(answer);

  return `status ${String(answer.status)}${message === undefined ? '' : `, ${message.slice(0, 200)}`}`;
};

/**
 * Saves `body` under `key`, as `actions/cache/save` does: reserves the key, uploads to the address
 * the reservation gives, as a single block, and commits it. Throws when any step fails three times,
 * or the key is taken.
 */
export const save = async (cache: Cache, key: string, body: Uint8Array) => {
  const version = fileVersion;

  let last: Answer | undefined;
  const reserved = await tries(
    cache,
    () => call(cache, 'CreateCacheEntry', { key, version }),
    (answer) => {
      last = answer;

      return answer.status === 409 || isOk(answer);
    },
  );
  if (reserved?.status === 409) throw new Error(`the cache holds ${key} already`);

  const reply = reserved === undefined ? {} : replyOf(reserved);
  const upload = reply.signed_upload_url ?? reply.signedUploadUrl;
  if (upload === undefined) throw new Error(`the cache didn't reserve ${key}: ${whyOf(last)}`);

  const put = await tries(
    cache,
    () =>
      send(
        cache,
        upload,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream', 'x-ms-blob-type': 'BlockBlob' },
          body: new Uint8Array(body), // fetch takes only bytes backed by a plain ArrayBuffer
        },
        30_000,
      ),
    (answer) => {
      last = answer;

      return answer.status >= 200 && answer.status < 300;
    },
  );

  if (put === undefined) {
    throw new Error(
      `the cache took no upload for ${key}: ${last?.status === 0 ? 'no answer' : `status ${String(last?.status)}`}`,
    );
  }

  const finalized = await tries(
    cache,
    () =>
      call(cache, 'FinalizeCacheEntryUpload', { key, version, size_bytes: String(body.length) }),
    (answer) => {
      last = answer;

      return isOk(answer);
    },
  );
  if (finalized === undefined) throw new Error(`the cache didn't commit ${key}: ${whyOf(last)}`);
};

/**
 * The file saved under exactly `key`, or undefined when the cache holds none. Throws when the
 * cache, or the download, gave no answer three times.
 */
export const restore = async (cache: Cache, key: string) => {
  const found = await tries(
    cache,
    () => call(cache, 'GetCacheEntryDownloadURL', { key, restore_keys: [], version: fileVersion }),
    (answer) => answer.status === 200 || answer.status === 404,
  );
  if (found === undefined) throw new Error(`the cache didn't answer for ${key}`);

  const reply = replyOf(found);
  const matched = reply.matched_key ?? reply.matchedKey;
  const download = reply.signed_download_url ?? reply.signedDownloadUrl;
  if (!isOk(found) || (matched !== undefined && matched !== key)) return undefined;

  if (download === undefined) throw new Error(`the cache gave no address for ${key}`);

  const got = await tries(
    cache,
    () => send(cache, download, { method: 'GET' }, 30_000),
    (answer) => answer.status === 200,
  );
  if (got === undefined) throw new Error(`the cache's download of ${key} failed`);

  return got.body;
};

/** Each of `items` through `run`, at most `limit` at once, in their order. */
const eachLimited = async <A, B>(
  items: ReadonlyArray<A>,
  limit: number,
  run: (item: A) => Promise<B>,
) => {
  const results = new Array<B>(items.length);
  const queue = items.entries();
  const lane = async () => {
    for (const [index, item] of queue) results[index] = await run(item);
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));

  return results;
};

const usage = 'Usage: node ci-cache.ts save <key> <file> | restore <folder> <key>...';

/** The command line, with the cache from the environment. */
export const main = async (args: ReadonlyArray<string>, from = env, cache?: Cache) => {
  const [command, ...rest] = args;
  const keys = command === 'save' ? rest.slice(0, 1) : rest.slice(1);
  const known =
    (command === 'save' && rest.length === 2) || (command === 'restore' && rest.length >= 1);

  if (!known || !keys.every((key) => keyPattern.test(key))) {
    console.error(usage);

    return 2;
  }

  const url = from['CI_CACHE_URL'] ?? '';
  const token = from['CI_CACHE_TOKEN'] ?? '';
  const at = cache ?? { url, token };

  if (at.url === '' || at.token === '') {
    console.error('ci-cache.ts needs CI_CACHE_URL and CI_CACHE_TOKEN');

    return 2;
  }

  if (command === 'save') {
    const [key = '', file = ''] = rest;

    const body = existsSync(file) ? readFileSync(file) : undefined;

    if (body === undefined || body.length === 0) {
      console.log(
        `${body === undefined ? 'No' : 'An empty'} ${file}, so nothing saved under ${key}.`,
      );

      return 0;
    }

    try {
      await save(at, key, body);
    } catch (error) {
      console.log(
        `::error::Saving ${file} failed: ${error instanceof Error ? error.message : ''}.`,
      );

      return 1;
    }

    console.log(`Saved ${file}, ${String(body.length)} bytes, under ${key}.`);

    return 0;
  }

  const [folder = ''] = rest;
  mkdirSync(folder, { recursive: true });
  const results = await eachLimited(keys, lookups, (key) =>
    restore(at, key).then(
      (body) => ({ key, body, error: undefined }),
      (error: Error) => ({ key, body: undefined, error: error.message }),
    ),
  );

  const found = results.flatMap(({ key, body }) => (body === undefined ? [] : [key]));

  for (const { key, body } of results) {
    if (body !== undefined) writeFileSync(join(folder, key), body);
  }

  console.log(
    `Restored ${String(found.length)} of ${String(keys.length)} keys into ${folder}${found.length === 0 ? '.' : `: ${found.join(' ')}`}`,
  );

  const failed = results.flatMap(({ error }) => (error === undefined ? [] : [error]));

  for (const error of failed) console.log(`::error::Restoring failed: ${error}.`);

  return failed.length === 0 ? 0 : 1;
};

if (argv[1] === fileURLToPath(import.meta.url)) {
  exit(await main(argv.slice(2)));
}
