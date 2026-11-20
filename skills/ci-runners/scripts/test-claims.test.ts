/**
 * test-claims.test.ts: tests for cache-key claims. Run with `node --test test-claims.test.ts`.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, test } from 'node:test';

import { cacheClaims, claimedIn, claimLine } from './test-claims.ts';

/** A cache that answers each reservation with the next status, or fails to answer for 0. */
const cache = (statuses: Array<number>) => {
  const keys = new Array<string>();
  const fetch: typeof globalThis.fetch = async (url, init) => {
    keys.push(await new Request(url, init).text());

    const status = statuses.shift() ?? 500;
    if (status === 0) throw new TypeError('fetch failed');

    return new Response(status === 200 ? '{"ok":true,"signed_upload_url":"u"}' : '{}', { status });
  };

  return {
    keys,
    claim: cacheClaims({
      url: 'http://cache/',
      token: 't',
      prefix: 'test-claim-7-1',
      fetch,
      wait: async () => {},
    }),
  };
};

describe('cacheClaims', () => {
  test('owns a batch whose key it reserved, and not one another shard reserved first', async () => {
    const { keys, claim } = cache([200, 409]);

    strictEqual(await claim(3), 'won');
    strictEqual(await claim(4), 'lost');
    deepStrictEqual(
      keys.map((body) => body.slice(0, 31)),
      ['{"key":"test-claim-7-1-3","vers', '{"key":"test-claim-7-1-4","vers'],
    );
  });

  test('tries a claim that got no answer again, and is unsure after the third', async () => {
    strictEqual(await cache([0, 503, 200]).claim(1), 'won');
    strictEqual(await cache([500, 0, 409]).claim(1), 'lost');
    strictEqual(await cache([500, 0, 502, 200]).claim(1), 'unsure');
  });
});

test('a claims file names each batch a shard ran, sure or not', () => {
  deepStrictEqual(claimedIn(claimLine(0, 'won') + claimLine(12, 'unsure') + 'x\n'), [0, 12]);
});
