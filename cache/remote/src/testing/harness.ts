/**
 * The Worker in Miniflare, with D1 and R2 in memory, every migration applied, and GitHub's JWKS
 * served from a key made for the run. Ported from upstream's `test/helpers.ts` at the pinned
 * commit, for this Worker's credentials and its one namespace. Runs under Vitest, locally or in
 * CI.
 *
 * The tests use their own fixture scope, `test-project`, never your deployment's, with a fixed
 * fixture policy (`fixturePolicy`), so they pass the same before and after you fill in
 * `migrations/0003_project.sql`, whatever policy you choose there. Unfilled, its placeholders
 * become the fixture's values and it registers the fixture. Filled, it registers your namespace,
 * and the harness registers the fixture beside it. Either way the harness then sets the fixture's
 * policy to `fixturePolicy`. What your migration chose is `policy`, the first scope's row before
 * that, which `../policy.test.ts` compares with the policy you wrote down.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decode, encode } from 'cborg';
import { build } from 'esbuild';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

import { ISSUER, JWKS_URL } from '../../vendor/vite-plus-remote-cache-cloudflare/src/auth.ts';
import { tokenDigest } from '../digest.ts';

export const origin = 'https://task-cache.example.com';

/** The namespace the tests register, in place of `<project>`. */
export const namespace = 'test-project';

export const endpoint = `${origin}/projects/${namespace}`;

/** The repository the tests register, in place of the migration's placeholders. */
const repository = { name: 'example-org/example-repo', id: '1000001', ownerId: '2000002' };

export const bytes = (value: string) => new TextEncoder().encode(value);

/** What a store answers, in CBOR. Vite+ reads none of it. */
export type CacheAnswer = { readonly blob_id?: string | null };

export const decodeResponse = async (response: Pick<Response, 'arrayBuffer'>) =>
  // SAFETY: the Worker answers a store with `cborResponse` of this field alone.
  decode(new Uint8Array(await response.arrayBuffer())) as CacheAnswer;

/**
 * A fetch's answer as Vite+ 1.7.0 decodes it: vite-task cb1ea8d's `Fetched` in
 * `crates/vt_remote_cache/src/lib.rs`, tagged by `kind`. An exact match holds at least one `Entry`,
 * whose `value` is bytes and whose `blob_id` is present, a string or null. A fallback holds its
 * `key`, bytes. Like serde, it ignores other fields.
 */
export type Fetched =
  | {
      readonly kind: 'exact';
      readonly entries: ReadonlyArray<{
        readonly value: Uint8Array;
        readonly blob_id: string | null;
      }>;
    }
  | { readonly kind: 'fallback'; readonly key: Uint8Array };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const fetched = (body: unknown): Fetched => {
  if (!isRecord(body)) throw new Error('a fetch answers a map');
  if (body.kind === 'fallback') {
    if (!(body.key instanceof Uint8Array)) throw new Error('a fallback holds its key as bytes');
    return { kind: 'fallback', key: body.key };
  }
  if (body.kind !== 'exact')
    throw new Error(`a fetch's kind is exact or fallback, not ${String(body.kind)}`);
  if (!Array.isArray(body.entries) || body.entries.length === 0)
    throw new Error('an exact match holds at least one of its entries');
  const entries = body.entries.map((entry: unknown) => {
    if (!isRecord(entry) || !(entry.value instanceof Uint8Array))
      throw new Error("an entry's value is bytes");
    if (!('blob_id' in entry) || (entry.blob_id !== null && typeof entry.blob_id !== 'string'))
      throw new Error("an entry's blob_id is present, a string or null");
    return { value: entry.value, blob_id: entry.blob_id };
  });
  return { kind: 'exact', entries };
};

/** A fetch's 200 body as 1.7.0 decodes it, or a throw where 1.7.0 fails the fetch. */
export const decodeFetched = async (response: Pick<Response, 'arrayBuffer'>): Promise<Fetched> =>
  fetched(decode(new Uint8Array(await response.arrayBuffer())));

/** Credentials the harness's Worker knows, each token 43 characters. */
export const credentials = {
  writer: { name: 'shared-machine', token: 'w'.repeat(43) },
  reader: { name: 'ci', token: 'r'.repeat(43) },
} as const;

export const basic = (name: string, token: string) => `Basic ${btoa(`${name}:${token}`)}`;

const readerAuth = basic(credentials.reader.name, credentials.reader.token);

/** Claims over a token's, malformed ones among them: the Worker must refuse what it can't read. */
export type Claims = Readonly<
  Record<string, string | number | null | undefined | ReadonlyArray<string>>
>;

/** Upstream's claims for a push to main, with the test repository's IDs and a private visibility. */
const pushClaims = {
  iss: ISSUER,
  aud: endpoint,
  repository_id: repository.id,
  repository_owner_id: repository.ownerId,
  repository_visibility: 'private',
  ref: 'refs/heads/main',
  ref_type: 'branch',
  event_name: 'push',
};

const bundle = async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../worker.ts', import.meta.url).href)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    external: ['node:*', 'cloudflare:*'],
  });

  return result.outputFiles[0]?.text ?? '';
};

/**
 * The policy the invariant tests assume for the fixture scope, independent of the one your
 * migration sets: same-repository pull requests write, results kept 7 days, 100 GB and 100,000
 * entries and associations.
 */
export const fixturePolicy = {
  pull_requests: 1,
  retention_seconds: 604_800,
  byte_limit: 100_000_000_000,
  entry_limit: 100_000,
  association_limit: 100_000,
} as const;

/**
 * The fixture scope, when no migration registered it (a filled-in `0003_project.sql` registered
 * the deployment's namespace instead), then the fixture's own policy over whatever it got.
 */
const fixtureScope = [
  `INSERT INTO scopes (
  scope_id, endpoint, repository, repository_id, repository_owner_id, branch
) SELECT '${namespace}', '${endpoint}', '${repository.name}', '${repository.id}', '${repository.ownerId}',
  'refs/heads/main'
WHERE NOT EXISTS (SELECT 1 FROM scopes WHERE scope_id = '${namespace}');`,
  `UPDATE scopes SET pull_requests = ${fixturePolicy.pull_requests},
  retention_seconds = ${fixturePolicy.retention_seconds}, byte_limit = ${fixturePolicy.byte_limit},
  entry_limit = ${fixturePolicy.entry_limit}, association_limit = ${fixturePolicy.association_limit}
WHERE scope_id = '${namespace}';`,
];

/** The policy columns of a scope's row. */
const policyColumns =
  'pull_requests, retention_seconds, byte_limit, entry_limit, association_limit';

/** Every migration's statements, in order, as `wrangler d1 migrations apply` runs them. */
const readMigrations = async () => {
  const folder = fileURLToPath(new URL('../../migrations/', import.meta.url).href);
  const names = (await readdir(folder)).filter((file) => file.endsWith('.sql')).sort();
  const statements: Array<string> = [];

  for (const name of names) {
    const sql = (await readFile(join(folder, name), 'utf8'))
      .replace(/^--.*$/gmu, '')
      .replaceAll('<worker-url>', origin)
      .replaceAll('<project>', namespace)
      .replaceAll('<org>/<repo>', repository.name)
      .replaceAll('<github-repository-id>', repository.id)
      .replaceAll('<github-owner-id>', repository.ownerId)
      .replaceAll('<branch>', 'main');
    statements.push(
      ...(sql.match(
        /CREATE TRIGGER[\s\S]*?\nEND;|(?:CREATE TABLE|CREATE (?:UNIQUE )?INDEX|INSERT INTO|UPDATE|ALTER TABLE|DROP TRIGGER)[\s\S]*?;/gu,
      ) ?? []),
    );
  }

  return statements;
};

/** The run's signing key and GitHub's JWKS entry for it, which no harness changes. */
const signingKey = async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  return { privateKey: pair.privateKey, jwk };
};

/**
 * What every harness starts from and none changes, made once a test file: the Worker's bundle, the
 * migrations, the credentials' digests and the signing key. Each harness still gets its own
 * Miniflare, D1 and R2.
 */
let inputs:
  | Promise<{
      readonly script: string;
      readonly migrations: ReadonlyArray<string>;
      readonly writers: Readonly<Record<string, string>>;
      readonly readers: Readonly<Record<string, string>>;
      readonly key: Awaited<ReturnType<typeof signingKey>>;
    }>
  | undefined;

const sharedInputs = () => {
  inputs ??= (async () => ({
    script: await bundle(),
    migrations: await readMigrations(),
    writers: { [credentials.writer.name]: await tokenDigest(credentials.writer.token) },
    readers: { [credentials.reader.name]: await tokenDigest(credentials.reader.token) },
    key: await signingKey(),
  }))();

  return inputs;
};

export type HarnessOptions = {
  readonly readLimit?: number;
  readonly storeLimit?: number;
  readonly jwksStatus?: number;
};

export const harness = async (options: HarnessOptions = {}) => {
  const { script, migrations, writers, readers, key } = await sharedInputs();
  let jwksRequests = 0;

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      unsafeDevRegistryPath: '',
      unsafeRegisterWorker: false,
      modules: true,
      script,
      compatibilityDate: '2026-09-11',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['INDEX'],
      r2Buckets: ['ARTIFACTS'],
      bindings: {
        GC_BATCH_SIZE: '16',
        NAMESPACE: namespace,
        WRITERS: writers,
        READERS: readers,
      },
      ratelimits: {
        READ_LIMITER: {
          namespace_id: '4201',
          simple: { limit: options.readLimit ?? 10_000, period: 60 },
        },
        STORE_LIMITER: {
          namespace_id: '4202',
          simple: { limit: options.storeLimit ?? 10_000, period: 60 },
        },
      },
      outboundService: (request) => {
        if (request.url !== JWKS_URL) throw new Error(`Unexpected outbound request ${request.url}`);

        jwksRequests++;

        return new Response(JSON.stringify({ keys: [key.jwk] }), {
          status: options.jwksStatus ?? 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    }),
  );

  const db = await mf.getD1Database('INDEX');
  await db.batch(migrations.map((sql) => db.prepare(sql)));
  // What the migrations registered first: your namespace once 0003 is filled in, else the fixture.
  const policy = await db.prepare(`SELECT ${policyColumns} FROM scopes ORDER BY rowid LIMIT 1`).first();
  await db.batch(fixtureScope.map((sql) => db.prepare(sql)));

  /** A GitHub OIDC token for a push to main, with `claims` over it. */
  const token = async (claims: Claims = {}, kid = 'test-key') => {
    const now = Math.floor(Date.now() / 1000);

    return new SignJWT({ ...pushClaims, exp: now + 300, iat: now, nbf: now - 1, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid })
      .sign(key.privateKey);
  };

  /** A store as Vite+ sends it, with a run's token unless `authorization` names another. */
  const store = async (
    key: Uint8Array,
    secondary: Uint8Array,
    value: Uint8Array,
    blob?: Uint8Array,
    authorization?: string,
  ) => {
    const form = new FormData();
    form.append(
      'metadata',
      new Blob([encode({ key, secondary_key: secondary, value })], { type: 'application/cbor' }),
      'metadata',
    );

    if (blob !== undefined) {
      form.append('blob', new Blob([blob], { type: 'application/octet-stream' }), 'blob');
    }

    const request = new Request(`${endpoint}/store`, { method: 'POST', body: form });

    return mf.dispatchFetch(request.url, {
      method: 'POST',
      headers: {
        ...Object.fromEntries(request.headers),
        Authorization: authorization ?? `Bearer ${await token()}`,
      },
      body: await request.arrayBuffer(),
    });
  };

  /** The headers of a read, with `authorization` when it isn't `null`. */
  const readHeaders = (
    authorization: string | null,
    more: ReadonlyArray<[string, string]> = [],
  ): Array<[string, string]> =>
    authorization === null ? [...more] : [...more, ['Authorization', authorization]];

  /** A fetch as Vite+ sends it, with the reader's credential unless `authorization` names another. */
  const fetch = (
    key: Uint8Array,
    secondary: Uint8Array,
    authorization: string | null = readerAuth,
  ) =>
    mf.dispatchFetch(`${endpoint}/fetch`, {
      method: 'POST',
      headers: readHeaders(authorization, [['Content-Type', 'application/cbor']]),
      body: encode({ key, secondary_key: secondary }),
    });

  const blob = (id: string, authorization: string | null = readerAuth) =>
    mf.dispatchFetch(`${endpoint}/blob/${id}`, { headers: readHeaders(authorization) });

  return {
    mf,
    db,
    policy,
    token,
    store,
    fetch,
    blob,
    jwksRequests: () => jwksRequests,
    close: () => mf.dispose(),
  };
};
