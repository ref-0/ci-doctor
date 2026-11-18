/**
 * ci-cache.test.ts: tests for saving and restoring small files in the Actions cache, against a
 * cache service in memory. Run with `node --test ci-cache.test.ts`.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type Cache, main, restore, save } from './ci-cache.ts';

/**
 * A cache service in memory, as Blacksmith's or GitHub's answers `actions/cache`: a reservation takes a key
 * once, an upload goes to the address it gives, and a lookup also matches a key by its prefix.
 * `fail` names the calls, by method or `put` and `get`, that fail to answer, each once, and
 * `broken` those whose answer breaks off while its body is read.
 */
const service = (fail: Array<string> = [], broken: Array<string> = []) => {
  const reserved = new Set<string>();
  const uploads = new Map<string, Uint8Array<ArrayBuffer>>();
  const entries = new Map<string, Uint8Array<ArrayBuffer>>();
  const calls = new Array<string>();

  const answer = (status: number, body = '{}') => new Response(body, { status });

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const name = url.pathname.split('/').pop() ?? '';
    const method = url.host === 'blob' ? request.method.toLowerCase() : name;
    calls.push(method);

    const failing = fail.indexOf(method);

    if (failing >= 0) {
      fail.splice(failing, 1);
      throw new TypeError('fetch failed');
    }

    const breaking = broken.indexOf(method);

    if (breaking >= 0) {
      broken.splice(breaking, 1);

      return new Response(
        new ReadableStream({ pull: (controller) => controller.error(new TypeError('terminated')) }),
      );
    }

    if (method === 'put') {
      uploads.set(name, new Uint8Array(await request.arrayBuffer()));

      return answer(201, '');
    }

    if (method === 'get') return new Response(entries.get(name));

    // ci-cache.ts sends each call a key, and a commit its size.
    const body = (await request.json()) as { key: string; size_bytes?: string };

    if (method === 'CreateCacheEntry') {
      if (reserved.has(body.key)) return answer(409);
      reserved.add(body.key);

      return answer(
        200,
        JSON.stringify({ ok: true, signed_upload_url: `http://blob/${body.key}` }),
      );
    }

    if (method === 'FinalizeCacheEntryUpload') {
      const upload = uploads.get(body.key);
      if (upload === undefined || String(upload.length) !== body.size_bytes)
        return answer(200, JSON.stringify({ ok: false }));
      entries.set(body.key, upload);

      return answer(200, JSON.stringify({ ok: true, entry_id: '1' }));
    }

    const matched =
      [...entries.keys()].find((key) => key === body.key) ??
      [...entries.keys()].find((key) => key.startsWith(body.key));

    return matched === undefined
      ? answer(200, JSON.stringify({ ok: false }))
      : answer(
          200,
          JSON.stringify({
            ok: true,
            signed_download_url: `http://blob/${matched}`,
            matched_key: matched,
          }),
        );
  };

  const cache: Cache = { url: 'http://cache', token: 't', fetch, wait: async () => {} };

  return { cache, calls };
};

const text = (body: string) => new TextEncoder().encode(body);

describe('save and restore', () => {
  test('a saved file restores whole by its key, and a key saved once is refused again', async () => {
    const { cache } = service();

    await save(cache, 'test-claims-7-1-2-1.txt', text('0\n3 unsure\n'));

    strictEqual(
      new TextDecoder().decode(await restore(cache, 'test-claims-7-1-2-1.txt')),
      '0\n3 unsure\n',
    );
    await rejects(save(cache, 'test-claims-7-1-2-1.txt', text('4\n')), { message: new RegExp('holds') });
  });

  test("restores nothing for a key the cache holds only longer ones of, nor one it doesn't hold", async () => {
    const { cache } = service();

    await save(cache, 'test-claims-7-1-2-10', text('5\n'));

    strictEqual(await restore(cache, 'test-claims-7-1-2-1'), undefined);
    strictEqual(await restore(cache, 'test-flakes-7-1-fuzz.jsonl'), undefined);
  });

  test('tries a call that got no answer, or whose answer broke off, again, and fails after the third', async () => {
    const { cache, calls } = service([
      'CreateCacheEntry',
      'put',
      'GetCacheEntryDownloadURL',
      'get',
    ]);

    await save(cache, 'k.txt', text('1\n'));
    deepStrictEqual(await restore(cache, 'k.txt'), text('1\n'));
    deepStrictEqual(calls, [
      'CreateCacheEntry',
      'CreateCacheEntry',
      'put',
      'put',
      'FinalizeCacheEntryUpload',
      'GetCacheEntryDownloadURL',
      'GetCacheEntryDownloadURL',
      'get',
      'get',
    ]);

    const interrupted = service([], ['FinalizeCacheEntryUpload', 'get']);
    await save(interrupted.cache, 'k.txt', text('2\n'));
    deepStrictEqual(await restore(interrupted.cache, 'k.txt'), text('2\n'));

    const silent = service(Array.from({ length: 3 }, () => 'GetCacheEntryDownloadURL'));
    await rejects(restore(silent.cache, 'k.txt'), { message: new RegExp("didn't answer") });
  });
});

describe('main', () => {
  test('saves nothing for a missing or empty file, and restores each key found into the folder', async () => {
    const { cache, calls } = service();
    const folder = mkdtempSync(join(tmpdir(), 'ci-cache-'));
    writeFileSync(join(folder, 'claims'), '2\n');

    writeFileSync(join(folder, 'empty'), '');

    strictEqual(await main(['save', 'a.txt', join(folder, 'none')], {}, cache), 0);
    strictEqual(await main(['save', 'a.txt', join(folder, 'empty')], {}, cache), 0);
    deepStrictEqual(calls, []);
    strictEqual(await main(['save', 'a.txt', join(folder, 'claims')], {}, cache), 0);
    strictEqual(await main(['restore', join(folder, 'got'), 'a.txt', 'b.txt'], {}, cache), 0);

    deepStrictEqual(readdirSync(join(folder, 'got')), ['a.txt']);
    strictEqual(readFileSync(join(folder, 'got', 'a.txt'), 'utf8'), '2\n');
  });

  test('fails a restore the cache gave no answer for, and a key with a folder in it', async () => {
    const { cache } = service(Array.from({ length: 3 }, () => 'GetCacheEntryDownloadURL'));
    const folder = mkdtempSync(join(tmpdir(), 'ci-cache-'));

    strictEqual(await main(['restore', folder, 'a.txt'], {}, cache), 1);
    strictEqual(await main(['restore', folder, '../a.txt'], {}, cache), 2);
    strictEqual(await main(['save', 'a.txt', 'f'], {}), 2);
  });
});
