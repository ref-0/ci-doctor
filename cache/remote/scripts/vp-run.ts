#!/usr/bin/env node
/**
 * Runs `vp run` with the remote task cache, for a machine that holds a writer's token in
 * `CREDENTIAL_FILE` (mode 0600, written by `scripts/credential.ts writer <name>`):
 *
 *     { "url": "<worker-url>/projects/<project>", "name": "…", "token": "…" }
 *
 *     node scripts/vp-run.ts <vp run's arguments>     # e.g. node scripts/vp-run.ts build
 *
 * Runs locally. Copy it into your repo's root `scripts/` and point your root `build` and `check`
 * scripts at it. It puts the token in the URL's userinfo, which Vite+ sends by HTTP Basic, and sets
 * `VP_REMOTE_CACHE=read-write`. Vite+ reads its mode from `VP_REMOTE_CACHE` as it starts, before
 * its config loads, so a config file can't set it. Without the file, runs use the local cache alone.
 * CI sets `VP_REMOTE_CACHE_URL` and `VP_REMOTE_CACHE` itself (the `task-cache` action), and either
 * one already set wins over the file. `VP_REMOTE_CACHE=off` turns the remote tier off for one run.
 *
 * Invoke the tool the same way everywhere: a task's key includes the program that ran it, so `vp`
 * here and `pnpm exec vp` elsewhere miss each other's results on identical source.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

// ---- Configure ------------------------------------------------------------------------------
/** The same path `scripts/credential.ts` writes. */
const CREDENTIAL_FILE = join(homedir(), '.config', '<project>', 'task-cache.json');
/** The folder holding your workspace's `vp`, relative to this file. */
const BIN = new URL('../node_modules/.bin', import.meta.url).href;
// ---------------------------------------------------------------------------------------------

type Credential = { readonly url: string; readonly name: string; readonly token: string };

const credential = (path: string): Credential | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;

    const { url, name, token } = parsed as Record<string, unknown>;
    if (typeof url !== 'string' || !URL.canParse(url)) return undefined;
    if (typeof name !== 'string' || !/^[a-z0-9-]{1,64}$/u.test(name)) return undefined;
    if (typeof token !== 'string' || token.length < 32) return undefined;

    return { url, name, token };
  } catch {
    return undefined;
  }
};

/** The remote cache's URL with the machine's credential in it, or nothing without one. */
export const remoteCacheUrl = (path = CREDENTIAL_FILE) => {
  const found = credential(path);
  if (found === undefined) return undefined;

  const url = new URL(found.url);
  url.username = found.name;
  url.password = found.token;

  return url.href.replace(/\/$/u, '');
};

/** `base` with the remote cache's URL and `read-write`, unless something set them already. */
export const remoteCacheEnv = (base: NodeJS.ProcessEnv, path = CREDENTIAL_FILE) => {
  const url = base['VP_REMOTE_CACHE_URL'] ?? remoteCacheUrl(path);
  if (url === undefined) return base;

  return {
    ...base,
    VP_REMOTE_CACHE_URL: url,
    VP_REMOTE_CACHE: base['VP_REMOTE_CACHE'] ?? 'read-write',
  };
};

if (argv[1] === fileURLToPath(import.meta.url)) {
  const bin = fileURLToPath(BIN);
  const { status, error } = spawnSync('vp', ['run', ...argv.slice(2)], {
    stdio: 'inherit',
    env: { ...remoteCacheEnv(env), PATH: `${bin}${delimiter}${env['PATH'] ?? ''}` },
  });
  if (error !== undefined) console.error(`vp-run: ${error.message}`);

  exit(status ?? 1);
}
