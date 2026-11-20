// The Gh client in-process, against the gh stub: what it caches, remembers and sends.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ApiCache, Gh } from '../src/gh.ts';
import { scratch, withStub } from './helpers.ts';

const ROUTES = { 'repos/pip/private-app/contents/package.json?ref=main': { status: 200, raw: '{"name":"secret"}' } };
const READ = 'repos/pip/private-app/contents/package.json?ref=main';

describe('the API cache', () => {
  it("keys answers by the token's hash, so clients with different tokens sharing a folder never read each other's", () => {
    const dir = join(scratch(), 'cache');
    withStub(ROUTES, {}, (log) => {
      const a = new Gh(new ApiCache(dir), 'token-a');
      assert.equal(a.text(READ, { raw: true }), '{"name":"secret"}');

      const b = new Gh(new ApiCache(dir), 'token-b');
      b.text(READ, { raw: true });
      assert.equal(b.fromCache, 0);
      assert.equal(log().length, 2);

      const again = new Gh(new ApiCache(dir), 'token-a');
      again.text(READ, { raw: true });
      assert.equal(log().length, 2, 'the same token reads its own cached answer');
    });
    for (const f of readdirSync(dir)) assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), /token-[ab]/);
  });
});

describe('remembering answers', () => {
  it('asks for an absent file once, however often it is read', () => {
    withStub({}, {}, (log) => {
      const gh = new Gh();
      assert.equal(gh.text('repos/pip/app/contents/.github/workflows/gone.yml?ref=main', { raw: true, absentOn: [404] }), undefined);
      assert.equal(gh.text('repos/pip/app/contents/.github/workflows/gone.yml?ref=main', { raw: true, absentOn: [404] }), undefined);
      assert.equal(log().length, 1);
    });
  });
});
