/**
 * test-file-slot.ts: a Vitest setup file that makes each test file wait its turn on this machine
 * before it starts (`test-slots.ts`). CI runs one run per machine, so takes no turn.
 *
 * Where it runs: every local Vitest run. List it first in `setupFiles`, before the file's own
 * hooks, so it lets go last, after the file's harness has closed:
 *
 *     test: { setupFiles: [fileURLToPath(new URL('./scripts/local/test-file-slot.ts', import.meta.url))] }
 *
 * Once it lets go, it appends the turn to `<project>/test-slots.jsonl` under `XDG_STATE_HOME`, or
 * `~/.local/state`, as one JSON line with this process and the worktree and file it ran, so a file's
 * wait can be told apart from its run. A write that fails is skipped: a test never fails over the log.
 *
 * Configure: `WORKTREE_DEPTH` (how many folders up the checkout's root is) and `PROJECT` in
 * `test-slots.ts`.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, expect } from 'vitest';

import { PROJECT, slotsDir, takeSlot, testFiles } from './test-slots.ts';

/** This file's folder, relative to the checkout's root: `scripts/local`. */
const WORKTREE_DEPTH = '../..';

if (process.env['CI'] === undefined) {
  const release = await takeSlot(slotsDir, testFiles);

  afterAll(async () => {
    const turn = await release();
    // From the module's path, not `new URL`: a happy-dom test's global `URL` isn't Node's.
    const worktree = resolve(dirname(fileURLToPath(import.meta.url)), WORKTREE_DEPTH);
    const testPath = expect.getState().testPath;
    const dir = join(process.env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state'), PROJECT);
    const line = {
      ...turn,
      pid: process.pid,
      worktree,
      file: testPath === undefined ? undefined : relative(worktree, testPath),
    };

    // One level at a time: Node 24's recursive mkdirSync spun forever where mkdir answers ENOENT
    // under a parent that exists, as under /proc.
    const parts = dir.split('/');

    for (let end = 2; end <= parts.length; end += 1) {
      try {
        mkdirSync(parts.slice(0, end).join('/'));
      } catch {}
    }

    try {
      appendFileSync(join(dir, 'test-slots.jsonl'), `${JSON.stringify(line)}\n`);
    } catch {}
  });
}
