// The Gh client in-process, against the gh stub: what it caches, remembers and sends.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { RateLimitError } from '../src/errors.ts';
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

describe('GraphQL', () => {
  it('sends the query on stdin, so its length never meets a command-line limit', () => {
    const long = `query { repository(owner: "pip", name: "app") { ${Array.from({ length: 100 }, (_, i) => `f${i}: object(expression: "main:${'deep/'.repeat(60)}${i}.json") { ... on Blob { text } }`).join(' ')} } }`;
    assert.ok(long.length > 32_767);
    withStub({}, {}, (log) => {
      const answer = new Gh().graphql(long);
      assert.equal(Object.keys(answer.data.repository).length, 100);
      assert.ok(log()[0]!.includes('--input'));
      assert.ok(log()[0]!.every((a) => a.length < 1000));
    });
  });
});

describe('a rate limit', () => {
  const limited = {
    graphql: { status: 200, json: { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for installation ID 1.' }] } },
    rate_limit: { status: 200, json: { resources: { core: { reset: 1795100000 }, graphql: { reset: 1795133700 } } } },
  };

  it("on GraphQL, which answers 200, stops at once with the limit's reset time, without asking again", () => {
    withStub(limited, {}, (log) => {
      assert.throws(() => new Gh().graphql('query { viewer { login } }'), (e: Error) => {
        assert.ok(e instanceof RateLimitError);
        assert.equal(e.message, "Couldn't read graphql: API rate limit exceeded for installation ID 1. GitHub's rate limit for this account ran out; it resets at 2026-11-20 00:15 UTC.");
        return true;
      });
      assert.deepEqual(log().map((c) => c.find((a) => a === 'graphql' || a === 'rate_limit')), ['graphql', 'rate_limit']);
    });
  });

  it('without a reset time to read, still stops and says to try again once it resets', () => {
    withStub({ graphql: limited.graphql }, {}, () => {
      assert.throws(() => new Gh().graphql('query { viewer { login } }'), /ran out; try again once it resets/);
    });
  });
});
