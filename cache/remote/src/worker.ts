/**
 * The task cache Worker: Vite+'s (Vite Task's) remote cache for one namespace, `NAMESPACE` in
 * `wrangler.jsonc`, on voidzero-dev/vite-plus-remote-cache-cloudflare's protocol, vendored in
 * `vendor/`.
 *
 * Runs on Cloudflare Workers. Configure it in `wrangler.jsonc` (copy `wrangler.jsonc.example`) and
 * `migrations/0003_project.sql`. Reference implementation from a production monorepo; adapt to
 * your repo.
 *
 * Every request names a credential before it spends a rate limit or memory. A read takes a
 * reader's or a writer's token, by HTTP Basic. A store takes a writer's, or a GitHub Actions
 * run's OIDC token, which the vendored `authorize` checks: the repository's IDs, and a push to the
 * branch, a same-repository pull request into it or a run by hand on one of its branches. D1 holds
 * the policy and the index, and R2 the values and outputs, each kept one result a key for 7 days.
 */
import { authorizeRun, namedCredential, type Named } from './credentials.ts';
import {
  Admission,
  type Lease,
} from '../vendor/vite-plus-remote-cache-cloudflare/src/admission.ts';
import {
  githubKeys,
  type WriteIdentity,
} from '../vendor/vite-plus-remote-cache-cloudflare/src/auth.ts';
import { cborResponse } from '../vendor/vite-plus-remote-cache-cloudflare/src/cbor.ts';
import {
  cleanup,
  getScope,
  selectBlob,
} from '../vendor/vite-plus-remote-cache-cloudflare/src/database.ts';
import {
  errorResponse,
  HttpError,
  unavailable,
} from '../vendor/vite-plus-remote-cache-cloudflare/src/errors.ts';
import { fetchMetadata } from '../vendor/vite-plus-remote-cache-cloudflare/src/fetch.ts';
import { defaults } from '../vendor/vite-plus-remote-cache-cloudflare/src/limits.ts';
import { Observations } from '../vendor/vite-plus-remote-cache-cloudflare/src/observations.ts';
import { store } from '../vendor/vite-plus-remote-cache-cloudflare/src/store.ts';
import { Deadline } from '../vendor/vite-plus-remote-cache-cloudflare/src/streams.ts';

/** The one namespace's routes, as `migrations/0003_project.sql` registers it. */
const routeFor = (namespace: string) => {
  if (!/^[a-z0-9-]{1,64}$/u.test(namespace)) throw new HttpError(503, 'bad_namespace');

  return new RegExp(`^/projects/${namespace}/(fetch|store|blob/([0-9a-f-]{36}))$`, 'u');
};

const keys = githubKeys();

const admission = new Admission();

/** Who made a request, for its log line: a credential's name or a run's workflow and ID. */
type Caller = { readonly name: string } | WriteIdentity;

/** A request's answer, and who made it, once known. */
type Outcome = { readonly response: Response; readonly caller: Caller | undefined };

const blobResponse = async (env: Env, id: string, deadline: Deadline, stats: Observations) => {
  const selected = await deadline.run(selectBlob(env.INDEX, env.NAMESPACE, id, stats));
  if (!selected) throw new HttpError(404, 'blob_missing');

  stats.r2_operations++;
  const object = await deadline.run(env.ARTIFACTS.get(selected.blob_object)).catch(unavailable);
  if (!object) throw new HttpError(404, 'blob_missing');

  if (object.size !== selected.blob_size) unavailable();

  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(object.size),
      'Cache-Control': 'no-store',
    },
  });
};

/** A store's identity: a writer's, standing for 15 minutes as an OIDC token does, or a run's. */
const writeIdentity = async (
  request: Request,
  named: Named | undefined,
  scope: Awaited<ReturnType<typeof getScope>>,
): Promise<WriteIdentity> => {
  if (named?.kind === 'reader') throw new HttpError(403, 'read_only');

  if (named === undefined) return authorizeRun(request, scope, keys);

  if (!scope.writes_enabled) throw new HttpError(403, 'writes_disabled');

  return {
    exp: Math.floor(Date.now() / 1000) + 900,
    repository_id: scope.repository_id,
    workflow_ref: `writer/${named.name}`,
  };
};

/** Answers one request, and returns who made it, once known. */
const answer = async (
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  stats: Observations,
): Promise<Outcome> => {
  const namespace = env.NAMESPACE;
  const url = new URL(request.url);
  const matched = routeFor(namespace).exec(url.pathname);
  const operation = matched?.[1]?.startsWith('blob/') ? 'blob' : matched?.[1];

  if (matched === null || operation === undefined || url.search !== '') {
    throw new HttpError(404, 'unknown_route');
  }

  if (request.method !== (operation === 'blob' ? 'GET' : 'POST')) {
    throw new HttpError(404, 'unknown_route');
  }

  const header = request.headers.get('authorization');
  if (header === null) throw new HttpError(401, 'missing_identity');

  const named = await namedCredential(request, env.WRITERS, env.READERS);
  if (named === undefined && operation !== 'store') throw new HttpError(401, 'invalid_identity');

  const deadline = new Deadline(
    operation === 'store' ? defaults.deadlineMs : 15_000,
    request.signal,
  );

  try {
    // A store's identity, a run's signed token included, is settled before it spends the store
    // limit or memory, so tokens that fail can't use up the writers' quota.
    const scope = await deadline.run(getScope(env.INDEX, namespace, stats));
    const identity =
      operation === 'store' ? await deadline.run(writeIdentity(request, named, scope)) : undefined;

    const limiter = operation === 'store' ? env.STORE_LIMITER : env.READ_LIMITER;
    const limited = await limiter.limit({ key: `${namespace}:${operation}` });
    if (!limited.success) throw new HttpError(429, 'rate_limit');

    return await admitted(async (lease) => {
      if (identity !== undefined) {
        const response = await store(
          request,
          env,
          ctx,
          scope,
          identity,
          defaults,
          deadline,
          stats,
          lease,
        );

        return { response, caller: identity };
      }

      const response =
        operation === 'fetch'
          ? cborResponse(
              await fetchMetadata(request, env, namespace, defaults, deadline, stats, lease),
            )
          : await blobResponse(env, matched[2] ?? '', deadline, stats);

      return { response, caller: named };
    });
  } finally {
    deadline.dispose();
  }
};

/** Runs `work` with a share of the isolate's buffer budget, which its buffers hold as they grow. */
const admitted = async <T>(work: (lease: Lease) => Promise<T>) => {
  const lease = admission.acquire();

  try {
    return await work(lease);
  } finally {
    lease.release();
  }
};

export default {
  async fetch(request, env, ctx) {
    const started = Date.now();
    const stats = new Observations();
    let outcome: Outcome;

    try {
      outcome = await answer(request, env, ctx, stats);
    } catch (error) {
      outcome = { response: errorResponse(error), caller: undefined };

      if (error instanceof HttpError && error.status >= 500) {
        console.warn(JSON.stringify({ error: error.code, path: new URL(request.url).pathname }));
      }
    }

    // Each store logs who made it, with no credential and no key in the line.
    const { response, caller } = outcome;

    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/store')) {
      console.log(
        JSON.stringify({
          operation: 'store',
          status: response.status,
          caller:
            caller === undefined ? null : 'name' in caller ? caller.name : caller.workflow_ref,
          run: caller !== undefined && 'run_id' in caller ? caller.run_id : undefined,
          duration_ms: Date.now() - started,
          ...stats.toJSON(),
        }),
      );
    }

    return response;
  },

  async scheduled(_event, env) {
    await cleanup(env);
  },
} satisfies ExportedHandler<Env>;
