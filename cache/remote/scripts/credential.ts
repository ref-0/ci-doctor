#!/usr/bin/env node
/**
 * Makes a credential for the task cache, keeps its token where it's used, and writes only its
 * SHA-256 into `wrangler.jsonc`, which the next deploy carries. It never prints the token, and
 * never passes it as an argument.
 *
 *     node scripts/credential.ts writer <name>   # this machine reads and writes
 *     node scripts/credential.ts reader ci       # CI's read token
 *
 * Runs locally, on a maintainer's machine, from this folder. A writer's token goes to
 * `CREDENTIAL_FILE`, mode 0600, which `scripts/vp-run.ts` reads. A reader's goes to the repository
 * secret `READ_SECRET` through `gh secret set`'s standard input. Making one for a name that has one
 * replaces it: the old token stops working at the deploy. Configure the block below.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

import { applyEdits, modify } from 'jsonc-parser';

import { tokenDigest } from '../src/digest.ts';

// ---- Configure ------------------------------------------------------------------------------
/** The cache's endpoint, as `migrations/0003_project.sql` registers it. */
const ENDPOINT = '<worker-url>/projects/<project>';
/** The repository whose secret holds CI's read token. */
const REPOSITORY = '<org>/<repo>';
/** The repository secret CI's `task-cache` action reads. */
const READ_SECRET = 'TASK_CACHE_READ_TOKEN';
/** Where a writer's token lives on this machine, outside every checkout. */
const CREDENTIAL_FILE = join(homedir(), '.config', '<project>', 'task-cache.json');
// ---------------------------------------------------------------------------------------------

const config = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href);

const [kind, name] = argv.slice(2);

if (
  (kind !== 'writer' && kind !== 'reader') ||
  name === undefined ||
  !/^[a-z0-9-]{1,64}$/u.test(name)
) {
  console.error('usage: credential.ts <writer|reader> <name of lowercase letters, digits and ->');
  exit(2);
}

if ([ENDPOINT, REPOSITORY, CREDENTIAL_FILE].some((value) => value.includes('<'))) {
  console.error('credential: fill in the Configure block at the top of scripts/credential.ts first');
  exit(2);
}

const token = randomBytes(32).toString('base64url');

if (kind === 'writer') {
  mkdirSync(dirname(CREDENTIAL_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(CREDENTIAL_FILE, `${JSON.stringify({ url: ENDPOINT, name, token })}\n`, {
    mode: 0o600,
  });
  console.error(`credential: wrote ${CREDENTIAL_FILE}, mode 0600`);
} else {
  // On standard input, so the token never reaches a command line, a shell history or a log.
  const { status } = spawnSync('gh', ['secret', 'set', READ_SECRET, '--repo', REPOSITORY], {
    input: token,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (status !== 0) exit(status ?? 1);
}

const field = kind === 'writer' ? 'WRITERS' : 'READERS';

const text = readFileSync(config, 'utf8');

const edits = modify(text, ['vars', field, name], await tokenDigest(token), {
  formattingOptions: { insertSpaces: true, tabSize: 2 },
});

writeFileSync(config, applyEdits(text, edits));

console.error(`credential: ${field}.${name} in wrangler.jsonc holds the new token's SHA-256`);
