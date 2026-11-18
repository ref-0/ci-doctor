/**
 * Who a request is: a named reader or writer by HTTP Basic, whose token the Worker knows only by
 * its SHA-256, or a GitHub Actions run by its signed OIDC token, which may only write.
 *
 * Part of the task cache Worker. Reference implementation from a production monorepo; adapt to
 * your repo.
 */
import { decodeJwt, type JWTVerifyGetKey } from 'jose';

import { authorize } from '../vendor/vite-plus-remote-cache-cloudflare/src/auth.ts';
import type { Scope } from '../vendor/vite-plus-remote-cache-cloudflare/src/database.ts';
import { HttpError } from '../vendor/vite-plus-remote-cache-cloudflare/src/errors.ts';
import { tokenDigest } from './digest.ts';

/** A credential the Worker knows: a writer reads too. */
export type Named = { readonly kind: 'writer' | 'reader'; readonly name: string };

/** Whether two digests match, in time that doesn't depend on where they differ. */
const same = (actual: string, expected: string) => {
  let difference = actual.length ^ expected.length;

  for (let index = 0; index < actual.length; index++) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }

  return difference === 0;
};

const decodeBasic = (header: string) => {
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(':');

    return { name: decoded.slice(0, separator), token: decoded.slice(separator + 1), separator };
  } catch {
    return undefined;
  }
};

/**
 * The named credential an HTTP Basic header carries, `undefined` when it carries none, or a 401
 * when it names no known credential or the token isn't that credential's.
 */
export const namedCredential = async (
  request: Request,
  writers: Readonly<Record<string, string>>,
  readers: Readonly<Record<string, string>>,
): Promise<Named | undefined> => {
  const header = request.headers.get('authorization');
  if (header === null || !header.toLowerCase().startsWith('basic ')) return undefined;

  const basic = header.length > 1024 ? undefined : decodeBasic(header);
  if (basic === undefined || basic.separator < 1) throw new HttpError(401, 'invalid_identity');

  if (!/^[a-z0-9-]{1,64}$/u.test(basic.name) || basic.token.length < 32) {
    throw new HttpError(401, 'invalid_identity');
  }

  const kind = Object.hasOwn(writers, basic.name)
    ? 'writer'
    : Object.hasOwn(readers, basic.name)
      ? 'reader'
      : undefined;
  const expected = kind === 'writer' ? writers[basic.name] : readers[basic.name];

  if (kind === undefined || expected === undefined || !/^[a-f0-9]{64}$/u.test(expected)) {
    throw new HttpError(401, 'invalid_identity');
  }

  if (!same(await tokenDigest(basic.token), expected)) throw new HttpError(401, 'invalid_identity');

  return { kind, name: basic.name };
};

/**
 * The scope a GitHub OIDC token is checked against. Vite+ asks for a token whose audience is its
 * configured URL, which in CI holds the read token as its userinfo, so a token whose audience is
 * the endpoint once its userinfo is dropped is checked against that audience. `authorize` checks
 * the signature and every claim, the audience among them.
 */
const audienceScope = (request: Request, scope: Scope): Scope => {
  let audience: string | Array<string> | undefined;

  try {
    audience = decodeJwt(request.headers.get('authorization')?.slice(7) ?? '').aud;
  } catch {
    throw new HttpError(401, 'invalid_token');
  }

  if (audience === undefined || Array.isArray(audience) || !URL.canParse(audience)) return scope;

  const bare = new URL(audience);
  bare.username = '';
  bare.password = '';

  return bare.href.replace(/\/$/u, '') === scope.endpoint.replace(/\/$/u, '')
    ? { ...scope, endpoint: audience }
    : scope;
};

/** The write identity a GitHub Actions run's OIDC token proves, or a 401 or 403. */
export const authorizeRun = (request: Request, scope: Scope, keys: JWTVerifyGetKey) =>
  authorize(request, audienceScope(request, scope), keys);
