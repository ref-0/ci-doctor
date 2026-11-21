/**
 * Who may read and write the task cache, and what admits a request. The policy and admission
 * cases are upstream's `test/service.test.ts` and `test/failures.test.ts` at the pinned commit,
 * with the tests of the two upstream fixes taken since (`upstream fixes`, below),
 * against this Worker, with the two local changes to the policy: a private repository, and a run by
 * hand on one of its branches.
 *
 * Run with `npx vitest run src/worker.test.ts` from this folder: it starts the Worker in Miniflare,
 * with no Cloudflare account. These are invariants: the fixture scope has its own policy
 * (`fixturePolicy`), so they hold for any policy you set in `migrations/0003_project.sql`.
 * `policy.test.ts` checks that one. Reference implementation from a production monorepo; adapt to your
 * repo.
 */
import { encode } from 'cborg';
import { afterEach, describe, expect, it } from 'vitest';

import {
  Admission,
  REQUEST_BYTES,
} from '../vendor/vite-plus-remote-cache-cloudflare/src/admission.ts';
import {
  cleanup,
  getScope,
  reserve,
} from '../vendor/vite-plus-remote-cache-cloudflare/src/database.ts';
import {
  defaults,
  MiB,
  PART_SIZE,
} from '../vendor/vite-plus-remote-cache-cloudflare/src/limits.ts';
import { multipart } from '../vendor/vite-plus-remote-cache-cloudflare/src/multipart.ts';
import { Observations } from '../vendor/vite-plus-remote-cache-cloudflare/src/observations.ts';
import {
  decodeMetadata,
  uploadBlob,
} from '../vendor/vite-plus-remote-cache-cloudflare/src/store.ts';
import {
  collect,
  Deadline,
  Input,
} from '../vendor/vite-plus-remote-cache-cloudflare/src/streams.ts';
import {
  basic,
  bytes,
  type Claims,
  credentials,
  decodeFetched,
  decodeResponse,
  endpoint,
  fixturePolicy,
  harness,
  namespace,
  origin,
} from './testing/harness.ts';

type Harness = Awaited<ReturnType<typeof harness>>;

let open: Harness | undefined;

const started = async (options?: Parameters<typeof harness>[0]) => {
  open = await harness(options);

  return open;
};

afterEach(async () => {
  await open?.close();
  open = undefined;
});

const writer = basic(credentials.writer.name, credentials.writer.token);

const reader = basic(credentials.reader.name, credentials.reader.token);

/** The audience Vite+ asks GitHub for in CI: its configured URL, the read token its userinfo. */
const ciAudience = `https://${credentials.reader.name}:${credentials.reader.token}@${endpoint.slice('https://'.length)}`;

/** `size` bytes in chunks of `chunk` bytes, as a request's body arrives. */
async function* chunks(size: number, chunk = 64 * 1024): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < size; offset += chunk) {
    yield new Uint8Array(Math.min(chunk, size - offset)).fill(offset % 251);
  }
}

/** `uploadBlob` into an R2 that records each call, with the harness's D1, holding `lease`. */
const recordedUpload = async (
  h: Harness,
  lease = new Admission().acquire(),
  limit = defaults.blob,
) => {
  const calls: Array<string> = [];
  const artifacts = {
    put: async (_key: string, value: Uint8Array) => {
      calls.push(`put ${value.length}`);

      return {};
    },
    createMultipartUpload: async () => ({
      uploadId: 'upload',
      uploadPart: async (part: number, value: Uint8Array) => {
        calls.push(`part ${part} ${value.length}`);

        return { partNumber: part, etag: `etag-${part}` };
      },
      complete: async () => {
        calls.push('complete');

        return {};
      },
      abort: async () => {},
    }),
  };
  // SAFETY: Miniflare's D1 is workerd's, typed by Miniflare's copy of the Workers types.
  const INDEX = h.db as D1Database;
  const scope = await getScope(INDEX, namespace);
  const generation = await reserve(INDEX, scope, Math.floor(Date.now() / 1000) + 900, 1024);

  const upload = async (source: AsyncIterable<Uint8Array>) => {
    const deadline = new Deadline(10_000);
    const env = { ARTIFACTS: artifacts, INDEX };

    try {
      await uploadBlob(env, generation, source, limit, deadline, new Observations(), lease);
    } finally {
      deadline.dispose();
    }

    return { calls, size: generation.blob_size };
  };

  return upload;
};

describe('reads', () => {
  it('take a reader or a writer, and nothing else', async () => {
    const h = await started();
    const stored = await h.store(bytes('A'), bytes('S'), bytes('V'), bytes('out'), writer);
    expect(stored.status).toBe(200);
    const blobId = String((await decodeResponse(stored)).blob_id);

    expect((await h.fetch(bytes('A'), bytes('S'), null)).status).toBe(401);
    expect((await h.fetch(bytes('A'), bytes('S'), `Bearer ${await h.token()}`)).status).toBe(401);
    expect((await h.fetch(bytes('A'), bytes('S'), basic('ci', 'x'.repeat(43)))).status).toBe(401);
    expect((await h.fetch(bytes('A'), bytes('S'), basic('nobody', 'r'.repeat(43)))).status).toBe(
      401,
    );
    expect((await h.blob(blobId, null)).status).toBe(401);

    for (const authorization of [reader, writer]) {
      expect(await decodeFetched(await h.fetch(bytes('A'), bytes('S'), authorization))).toEqual({
        kind: 'exact',
        entries: [{ value: bytes('V'), blob_id: blobId }],
      });
      expect(await (await h.blob(blobId, authorization)).text()).toBe('out');
    }

    expect((await h.fetch(bytes('B'), bytes('T'))).status).toBe(404);
  });

  it('answers only its one namespace, with no query string', async () => {
    const h = await started();
    const headers = { Authorization: reader, 'Content-Type': 'application/cbor' };

    for (const url of [
      `${origin}/projects/other/fetch`,
      `${endpoint}/fetch?x=1`,
      `${endpoint}/unknown`,
    ]) {
      expect((await h.mf.dispatchFetch(url, { method: 'POST', headers })).status).toBe(404);
    }

    expect((await h.mf.dispatchFetch(`${endpoint}/fetch`, { headers })).status).toBe(404);
  });
});

// Each reply as Vite+ 1.7.0 reads it, vite-task cb1ea8d's `crates/vt_remote_cache/src/lib.rs`:
// `fetch` decodes `Fetched`, `store` needs only a 200, and `download` streams a 200's body.
describe("Vite+ 1.7.0's replies", () => {
  it('answer an exact match with entries, and a fallback with its key', async () => {
    const h = await started();
    const stored = await h.store(bytes('A'), bytes('S'), bytes('V'), bytes('out'), writer);
    const blobId = String((await decodeResponse(stored)).blob_id);
    await h.store(bytes('B'), bytes('T'), bytes('W'), undefined, writer);

    expect(await decodeFetched(await h.fetch(bytes('A'), bytes('S')))).toEqual({
      kind: 'exact',
      entries: [{ value: bytes('V'), blob_id: blobId }],
    });
    expect(await decodeFetched(await h.fetch(bytes('B'), bytes('T')))).toEqual({
      kind: 'exact',
      entries: [{ value: bytes('W'), blob_id: null }],
    });
    expect(await decodeFetched(await h.fetch(bytes('C'), bytes('S')))).toEqual({
      kind: 'fallback',
      key: bytes('A'),
    });
    // The pin's shape, which 1.7.0 refused: every exact match was a miss.
    const before = new Response(encode({ kind: 'exact', value: bytes('V'), blob_id: blobId }));
    await expect(decodeFetched(before)).rejects.toThrow('entries');
  });

  it("answer a blob with 200 and its bytes, which 1.7.0 streams into a task's outputs", async () => {
    const h = await started();
    const blob = new Uint8Array(1024).map((_, i) => i % 251);
    const stored = await h.store(bytes('A'), bytes('S'), bytes('V'), blob, writer);
    const answer = await decodeFetched(await h.fetch(bytes('A'), bytes('S')));
    const blobId = answer.kind === 'exact' ? answer.entries[0]?.blob_id : undefined;

    expect(blobId).toBe((await decodeResponse(stored)).blob_id);
    const downloaded = await h.blob(String(blobId));
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(blob);
  });
});

describe('a writer', () => {
  it('writes, and a reader may not', async () => {
    const h = await started();

    expect((await h.store(bytes('A'), bytes('S'), bytes('V'), undefined, reader)).status).toBe(403);
    expect((await h.fetch(bytes('A'), bytes('S'))).status).toBe(404);
    expect((await h.store(bytes('A'), bytes('S'), bytes('V'), undefined, writer)).status).toBe(200);
    expect(await decodeFetched(await h.fetch(bytes('A'), bytes('S')))).toEqual({
      kind: 'exact',
      entries: [{ value: bytes('V'), blob_id: null }],
    });
  });

  it('writes nothing once writes are off', async () => {
    const h = await started();
    await h.db.prepare("UPDATE scopes SET writes_enabled = 0 WHERE scope_id = 'test-project'").run();

    expect((await h.store(bytes('A'), bytes('S'), bytes('V'), undefined, writer)).status).toBe(403);
    expect((await h.db.prepare('SELECT count(*) AS n FROM generations').first())?.['n']).toBe(0);
  });
});

describe("a run's signed token", () => {
  const status = async (h: Harness, claims: Claims) =>
    (
      await h.store(
        bytes('A'),
        bytes('S'),
        bytes('V'),
        undefined,
        `Bearer ${await h.token(claims)}`,
      )
    ).status;

  it("writes from a push to main, with the read token in the token's audience", async () => {
    const h = await started();

    expect(await status(h, {})).toBe(200);
    expect(await status(h, { aud: ciAudience })).toBe(200);
    expect(await status(h, { repository_visibility: 'public' })).toBe(200);
  });

  it('denies other repositories, owners, events, branches and audiences', async () => {
    const h = await started();

    for (const claims of [
      { repository_id: '999' },
      { repository_id: 1000001 },
      { repository_owner_id: '999' },
      { repository_visibility: 'internal' },
      { event_name: 'pull_request' },
      { event_name: 'pull_request_target' },
      { event_name: 'workflow_run' },
      { ref: 'refs/heads/feature' },
      { ref_type: 'tag' },
      { aud: 'https://attacker.example' },
      { aud: `https://ci:x@attacker.example/projects/${namespace}` },
      { aud: [endpoint] },
    ]) {
      expect({ claims, status: await status(h, claims) }).toEqual({ claims, status: 403 });
    }

    expect((await h.db.prepare('SELECT count(*) AS n FROM generations').first())?.['n']).toBe(0);
  });

  it('refuses expired, early, unsigned and forged tokens', async () => {
    const h = await started();
    const now = Math.floor(Date.now() / 1000);

    for (const claims of [
      { exp: now - 1 },
      { nbf: now + 100 },
      { iat: now + 100 },
      { iat: 'bad' },
      { exp: null },
      { iss: 'https://attacker.example' },
    ]) {
      expect({ claims, status: await status(h, claims) }).toEqual({ claims, status: 401 });
    }

    const segments = (await h.token()).split('.');
    const signature = Buffer.from(segments[2] ?? '', 'base64url');
    signature[0] = (signature[0] ?? 0) ^ 1;
    segments[2] = signature.toString('base64url');
    expect(
      (await h.store(bytes('A'), bytes('S'), bytes('V'), undefined, `Bearer ${segments.join('.')}`))
        .status,
    ).toBe(401);
    expect(
      (await h.store(bytes('A'), bytes('S'), bytes('V'), undefined, 'Bearer forged')).status,
    ).toBe(401);
    expect((await h.mf.dispatchFetch(`${endpoint}/store`, { method: 'POST' })).status).toBe(401);

    for (let index = 0; index < 5; index++) {
      const token = await h.token({}, `unknown-${index}`);
      expect(
        (await h.store(bytes('A'), bytes('S'), bytes('V'), undefined, `Bearer ${token}`)).status,
      ).toBe(401);
    }

    expect(h.jwksRequests()).toBe(1);
  });

  it('writes from a same-repository pull request into main, and from no other base', async () => {
    const h = await started();
    const pr = {
      event_name: 'pull_request',
      ref: 'refs/pull/27/merge',
      base_ref: 'main',
      head_ref: 't3/remote-task-cache',
    };

    expect(await status(h, pr)).toBe(200);

    for (const claims of [
      { base_ref: 'feature' },
      { base_ref: 'refs/heads/main' },
      { base_ref: undefined },
      { ref: 'refs/heads/main' },
      { ref: 'refs/pull/27/head' },
      { ref_type: 'tag' },
      { repository_id: '999' },
    ]) {
      expect({ claims, status: await status(h, { ...pr, ...claims }) }).toEqual({
        claims,
        status: 403,
      });
    }

    await h.db.prepare("UPDATE scopes SET pull_requests = 0 WHERE scope_id = 'test-project'").run();
    expect(await status(h, pr)).toBe(403);
  });

  it("writes from a run by hand on one of the repository's branches, as a pull request may", async () => {
    const h = await started();
    const dispatch = { event_name: 'workflow_dispatch', ref: 'refs/heads/t3/remote-task-cache' };

    expect(await status(h, dispatch)).toBe(200);
    expect(await status(h, { ...dispatch, ref: 'refs/tags/v1' })).toBe(403);
    expect(await status(h, { ...dispatch, repository_id: '999' })).toBe(403);

    await h.db.prepare("UPDATE scopes SET pull_requests = 0 WHERE scope_id = 'test-project'").run();
    expect(await status(h, dispatch)).toBe(403);
  });

  it("writes from runs that arrive together, while one reads GitHub's keys", async () => {
    const h = await started();

    expect(await Promise.all(Array.from({ length: 6 }, () => status(h, {})))).toEqual(
      new Array(6).fill(200),
    );
  });

  it("fails closed while GitHub's keys can't be read, and waits before asking again", async () => {
    const h = await started({ jwksStatus: 503 });

    for (let index = 0; index < 3; index++) expect(await status(h, {})).toBe(503);
    expect(h.jwksRequests()).toBe(1);
  });
});

/** A store's metadata in CBOR, its value of `size` zeros one definite or chunked byte string. */
const metadataOf = (size: number, chunked: boolean) => {
  const text = (value: string) => [0x60 + value.length, ...new TextEncoder().encode(value)];
  const length = [0x5a, size >>> 24, (size >>> 16) & 255, (size >>> 8) & 255, size & 255];
  const head = [0xa3, ...text('key'), 0x41, 65, ...text('secondary_key'), 0x41, 83];
  const value = chunked ? [...text('value'), 0x5f, ...length] : [...text('value'), ...length];
  const tail = chunked ? [0xff] : [];

  return new Uint8Array([...head, ...value, ...new Array<number>(size).fill(0), ...tail]);
};

describe("a store's buffers", () => {
  it("hold the copy that decoding a chunked value makes, and free it when there's none", () => {
    const decoded = [false, true].map((chunked) => {
      const body = metadataOf(256 * 1024, chunked);
      const admission = new Admission(2 * REQUEST_BYTES + body.length);
      const { value } = decodeMetadata(body, defaults, admission.acquire());

      try {
        admission.acquire().hold(body.length);

        return { chunked, value: value.length, room: true };
      } catch {
        return { chunked, value: value.length, room: false };
      }
    });

    expect(decoded).toEqual([
      { chunked: false, value: 256 * 1024, room: true },
      { chunked: true, value: 256 * 1024, room: false },
    ]);
  });

  it('hold what a small store brings, with no 5 MiB buffer', async () => {
    const lease = new Admission(MiB).acquire();
    const upload = await recordedUpload(await started(), lease);

    expect((await collect(chunks(4096, 1), defaults.metadata, lease)).length).toBe(4096);
    expect(await upload(chunks(1024))).toEqual({ calls: ['put 1024'], size: 1024 });
  });

  it('upload a blob over one part in parts, the last one short', async () => {
    const upload = await recordedUpload(await started());

    expect(await upload(chunks(2 * PART_SIZE + 3))).toEqual({
      calls: [`part 1 ${PART_SIZE}`, `part 2 ${PART_SIZE}`, 'part 3 3', 'complete'],
      size: 2 * PART_SIZE + 3,
    });
  });

  it('store a blob over one part in parts, and replay it with a value over 4 MiB', async () => {
    const h = await started();
    const blob = new Uint8Array(2 * PART_SIZE + 3).map((_, i) => i % 251);
    const value = new Uint8Array(5 * MiB).fill(7);

    const stored = await h.store(bytes('A'), bytes('S'), value, blob, writer);
    expect(stored.status).toBe(200);
    const blobId = String((await decodeResponse(stored)).blob_id);
    const { blob_object } =
      (await h.db.prepare('SELECT blob_object FROM generations').first()) ?? {};
    const r2 = await h.mf.getR2Bucket('ARTIFACTS');

    // R2 tags an object uploaded in parts with its count of them.
    expect((await r2.head(String(blob_object)))?.etag).toMatch(/-3$/u);
    expect(await decodeFetched(await h.fetch(bytes('A'), bytes('S')))).toEqual({
      kind: 'exact',
      entries: [{ value, blob_id: blobId }],
    });
    expect(new Uint8Array(await (await h.blob(blobId)).arrayBuffer())).toEqual(blob);
  });

  it('still refuse a value, a metadata part or a blob past its limit', async () => {
    const h = await started();
    const upload = await recordedUpload(h, undefined, 10);
    const over = new Uint8Array(defaults.value + 1);

    expect((await h.store(bytes('A'), bytes('S'), over, undefined, writer)).status).toBe(413);
    await expect(collect(chunks(defaults.metadata + 1), defaults.metadata)).rejects.toThrow(
      expect.objectContaining({ status: 413 }),
    );
    await expect(upload(chunks(11))).rejects.toThrow(expect.objectContaining({ status: 413 }));
  });
});

describe('admission', () => {
  it('checks the credential before it spends the rate limit', async () => {
    const h = await started({ readLimit: 1, storeLimit: 1 });

    expect((await h.fetch(bytes('A'), bytes('S'), null)).status).toBe(401);
    expect((await h.fetch(bytes('A'), bytes('S'), basic('ci', 'x'.repeat(43)))).status).toBe(401);
    expect((await h.fetch(bytes('A'), bytes('S'))).status).toBe(404);

    const limited = await h.fetch(bytes('A'), bytes('S'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');

    expect((await h.store(bytes('A'), bytes('S'), bytes('V'), undefined, writer)).status).toBe(200);
    expect((await h.store(bytes('A'), bytes('S'), bytes('V'), undefined, writer)).status).toBe(429);
  });

  it("verifies a run's token before it spends the store limit", async () => {
    const h = await started({ storeLimit: 1 });
    const store = async (authorization: string) =>
      (await h.store(bytes('A'), bytes('S'), bytes('V'), undefined, authorization)).status;

    expect(await store('Bearer forged')).toBe(401);
    expect(await store(`Bearer ${await h.token({ repository_id: '999' })}`)).toBe(403);
    expect(await store(`Bearer ${await h.token()}`)).toBe(200);
    expect(await store(`Bearer ${await h.token()}`)).toBe(429);
  });

  it('refuses a buffer past the budget, and a released lease frees its bytes', () => {
    const admission = new Admission(MiB);
    const first = admission.acquire();
    first.hold(MiB - 2 * REQUEST_BYTES);
    const second = admission.acquire();

    expect(() => second.hold(1)).toThrow(
      expect.objectContaining({ status: 503, code: 'memory_limit' }),
    );
    expect(() => admission.acquire()).toThrow(expect.objectContaining({ status: 503 }));

    first.release();
    second.hold(MiB - 2 * REQUEST_BYTES);
    second.release();
    admission.acquire().hold(MiB - REQUEST_BYTES);
  });

  it('refuses a store whose buffers grow past the budget', async () => {
    const lease = new Admission(512 * 1024).acquire();

    await expect(collect(chunks(600 * 1024), defaults.metadata, lease)).rejects.toThrow(
      expect.objectContaining({ status: 503, code: 'memory_limit' }),
    );
  });

  it("keeps a result for its namespace's retention, within its limits", async () => {
    const h = await started();

    expect(
      await h.db
        .prepare(
          "SELECT pull_requests, retention_seconds, byte_limit, entry_limit, association_limit FROM scopes WHERE scope_id = 'test-project'",
        )
        .first(),
    ).toEqual(fixturePolicy);
    expect((await h.store(bytes('A'), bytes('S'), bytes('V'), undefined, writer)).status).toBe(200);
    const generation = await h.db
      .prepare('SELECT expires_at - unixepoch() AS left FROM generations')
      .first();
    expect(Number(generation?.['left'])).toBeGreaterThan(fixturePolicy.retention_seconds - 100);
  });
});

/** An R2 binding whose multipart aborts reject with `message`, as a binding error reads. */
const failingAbort = (bucket: R2Bucket, message: string): R2Bucket =>
  new Proxy(bucket, {
    get(target, prop) {
      if (prop === 'resumeMultipartUpload') {
        return () => ({
          abort: async () => {
            throw new Error(message);
          },
        });
      }

      const value: unknown = Reflect.get(target, prop);

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

describe('upstream fixes', () => {
  it('stream a part whose bytes repeat padded boundary prefixes', async () => {
    // Each prefix is followed by padding up to the header limit and then a byte that isn't CRLF,
    // so it stays body data. The parser must yield as it reads, not buffer the whole body.
    const prefix = '\r\n--b' + ' '.repeat(8186) + 'X';
    const value = prefix.repeat(128);
    const data = Buffer.from(
      'preamble\r\n--b\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/cbor\r\n\r\n' +
        value +
        '\r\n--b--\r\n',
    );
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= data.length) return controller.close();
        controller.enqueue(data.subarray(offset, offset + 65536));
        offset += 65536;
      },
    });
    const deadline = new Deadline(5000);
    const input = new Input(stream, data.length, deadline);
    let largest = 0;
    const fill = input.fill.bind(input);
    input.fill = async () => {
      const more = await fill();
      largest = Math.max(largest, input.buffer.length);

      return more;
    };

    try {
      const read: Array<Uint8Array> = [];
      for await (const part of multipart(input, 'b', 8192)) {
        for await (const chunk of part.body) read.push(chunk);
      }

      expect(Buffer.concat(read).toString()).toBe(value);
      expect(read.length).toBeGreaterThan(1);
      expect(largest).toBeLessThan(128 * 1024);
    } finally {
      deadline.dispose();
      input.close();
    }
  });

  it('delete a generation whose recorded multipart upload R2 can no longer abort', async () => {
    const h = await started();

    // Publication clears the ID of the upload it completed.
    expect(
      (await h.store(bytes('A'), bytes('S'), bytes('v'), new Uint8Array(PART_SIZE + 1), writer))
        .status,
    ).toBe(200);
    expect(
      await h.db.prepare('SELECT count(*) AS n FROM generations WHERE upload_id IS NOT NULL').first(),
    ).toEqual({ n: 0 });

    // A generation published before that still carries the ID, and R2 says the upload is gone.
    await h.db
      .prepare("UPDATE generations SET upload_id = 'completed', expires_at = 0, gc_after = 0")
      .run();
    const original = await h.mf.getBindings<Env>();
    await cleanup({
      ...original,
      ARTIFACTS: failingAbort(
        original.ARTIFACTS,
        'abortMultipartUpload: The specified multipart upload does not exist. (10024)',
      ),
    });

    expect(await h.db.prepare('SELECT count(*) AS n FROM generations').first()).toEqual({ n: 0 });
    expect(await h.db.prepare('SELECT charged_bytes FROM deployment').first()).toEqual({
      charged_bytes: 0,
    });
  });

  it('keep an unfinished upload and its charge when the abort fails for another reason', async () => {
    const h = await started();
    const original = await h.mf.getBindings<Env>();
    // SAFETY: Miniflare's D1 is workerd's, typed by Miniflare's copy of the Workers types.
    const INDEX = h.db as D1Database;
    const scope = await getScope(INDEX, namespace);
    const generation = await reserve(INDEX, scope, Math.floor(Date.now() / 1000) + 300, PART_SIZE);
    const upload = await original.ARTIFACTS.createMultipartUpload(generation.blob_object);
    await upload.uploadPart(1, new Uint8Array(PART_SIZE));
    await h.db
      .prepare('UPDATE generations SET upload_id = ?, gc_after = 0 WHERE generation_id = ?')
      .bind(upload.uploadId, generation.generation_id)
      .run();
    const remaining = () =>
      h.db
        .prepare(
          'SELECT (SELECT count(*) FROM generations WHERE upload_id IS NOT NULL) AS n, charged_bytes FROM deployment',
        )
        .first();

    await cleanup({
      ...original,
      ARTIFACTS: failingAbort(
        original.ARTIFACTS,
        'abortMultipartUpload: We encountered an internal error. Please try again. (10001)',
      ),
    });
    expect(await remaining()).toEqual({ n: 1, charged_bytes: PART_SIZE });

    // The upload still exists, so a retry aborts it, deletes the generation and frees the charge.
    await h.db.prepare('UPDATE generations SET gc_after = 0').run();
    await cleanup(original);
    expect(await remaining()).toEqual({ n: 0, charged_bytes: 0 });
  });
});
