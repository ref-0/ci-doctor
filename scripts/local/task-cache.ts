#!/usr/bin/env node
/**
 * task-cache.ts: the remote tier of Vite Task's cache, for a machine that holds a writer's token.
 * The token lives in `~/.config/<project>/task-cache.json`, with mode 0600:
 *
 *     { "url": "https://<worker-url>/projects/<project>", "name": "<machine-name>", "token": "<writer-token>" }
 *
 * `remoteCacheUrl` gives your root config the URL with the token as its userinfo, which Vite+
 * sends by HTTP Basic:
 *
 *     const remote = remoteCacheUrl();
 *     export default defineConfig({ run: { cache: { tasks: true, remote: remote && { url: remote } } } });
 *
 * `remoteCacheEnv` also asks Vite+ to write as well as read. Vite+ reads its mode from
 * `VP_REMOTE_CACHE` as it starts, before the config loads, so a config can't set it. Without the
 * file, both return nothing and runs use the local cache alone. CI sets `VP_REMOTE_CACHE_URL` and
 * `VP_REMOTE_CACHE` itself, and either one set wins over the file. `VP_REMOTE_CACHE=off` turns
 * the remote tier off for one run.
 *
 *     node scripts/local/task-cache.ts <vp run's arguments>
 *
 * runs `vp run` that way. Point your root `build` and test scripts at it.
 *
 * Where it runs: developers' and agents' machines. Setting up the Worker and minting tokens: the guide
 * section 6.
 *
 * Configure: `PROJECT`, and where your `node_modules/.bin` is relative to this file.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

/** The folder under `~/.config` that holds the credential. */
export const PROJECT = '<project>';

/** The machine's writer credential: the endpoint, and the name and token the Worker knows. */
export interface Credential {
  readonly url: string;
  readonly name: string;
  readonly token: string;
}

/** The credential file's path. */
export const credentialPath = () => join(homedir(), '.config', PROJECT, 'task-cache.json');

const isCredential = (value: unknown): value is Credential => {
  if (typeof value !== 'object' || value === null) return false;

  const found = value as Record<string, unknown>;

  return (
    typeof found['url'] === 'string' &&
    typeof found['name'] === 'string' &&
    /^[a-z0-9-]{1,64}$/u.test(found['name']) &&
    typeof found['token'] === 'string' &&
    found['token'].length >= 32
  );
};

const credential = (path: string) => {
  try {
    const found: unknown = JSON.parse(readFileSync(path, 'utf8'));

    return isCredential(found) ? found : undefined;
  } catch {
    return undefined;
  }
};

/** The remote cache's URL with the machine's credential in it, or nothing without one. */
export const remoteCacheUrl = (path = credentialPath()) => {
  const found = credential(path);
  if (found === undefined || !URL.canParse(found.url)) return undefined;

  const url = new URL(found.url);
  url.username = found.name;
  url.password = found.token;

  return url.href.replace(/\/$/u, '');
};

/** `base` with `VP_REMOTE_CACHE=read-write` when the machine holds a writer and nothing set it. */
export const remoteCacheEnv = (base: NodeJS.ProcessEnv, path = credentialPath()) =>
  base['VP_REMOTE_CACHE'] === undefined && remoteCacheUrl(path) !== undefined
    ? { ...base, VP_REMOTE_CACHE: 'read-write' }
    : base;

if (argv[1] === fileURLToPath(import.meta.url)) {
  // The root's `vp`, as pnpm's scripts find it, when this runs outside one.
  const bin = fileURLToPath(new URL('../../node_modules/.bin', import.meta.url));
  const { status, error } = spawnSync('vp', ['run', ...argv.slice(2)], {
    stdio: 'inherit',
    env: { ...remoteCacheEnv(env), PATH: `${bin}${delimiter}${env['PATH'] ?? ''}` },
  });
  if (error !== undefined) console.error(`task-cache: ${error.message}`);

  exit(status ?? 1);
}
