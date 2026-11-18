/**
 * Drives run-breaks.ts on a throwaway git repo whose "test" is a small Node check.
 *
 * Runs: `node --test run-breaks.test.ts` from this folder (Node 24, `git`).
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { equal, match, notEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { type Break, verdict } from './run-breaks.ts';

const script = join(dirname(fileURLToPath(import.meta.url)), 'run-breaks.ts');
const CODE = 'export const limit = (n) => n <= 10;\n';
// The covering test: fails with a named rule when the limit moves.
const TEST = "import { limit } from './limits.mjs';\n"
  + "if (limit(11) || !limit(10)) { console.log('FAIL the limit rule'); process.exit(1); }\n";

describe('run-breaks', () => {
  let root = '';
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, stdio: 'pipe' });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'run-breaks-'));
    git('init', '-q');
    writeFileSync(join(root, 'limits.mjs'), CODE);
    writeFileSync(join(root, 'check.mjs'), TEST);
    git('add', '-A');
    git('commit', '-qm', 'code');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const config = (breaks: Break[], timeout = 20) => {
    const path = join(root, 'breaks.json');
    writeFileSync(path, JSON.stringify({ command: [process.execPath, '{test}'], timeout, breaks }));
    git('add', 'breaks.json');
    git('commit', '-qm', 'x');
    return path;
  };

  const runBreaks = (breaks: Break[], timeout?: number) => {
    const done = spawnSync(process.execPath, [script, '--config', config(breaks, timeout)], { cwd: root, encoding: 'utf8' });
    return { code: done.status, out: done.stdout, err: done.stderr };
  };

  const brk = (name: string, replacement: string, expect?: string): Break => ({
    name, path: 'limits.mjs', old: 'n <= 10', new: replacement, test: 'check.mjs', ...(expect ? { expect } : {}),
  });

  it('reports caught, missed and skipped, and puts the code back', () => {
    const { code, out } = runBreaks([
      brk('off by one', 'n <= 11', 'the limit rule'),
      brk('no change in behaviour', '10 >= n'),
      { name: 'moved', path: 'limits.mjs', old: 'not there', new: 'x', test: 'check.mjs' },
    ]);
    match(out, /CAUGHT {4}off by one/);
    match(out, /MISSED {4}no change in behaviour/);
    match(out, /SKIP {6}moved/);
    match(out, /1 caught, 1 missed, 1 skip/);
    equal(code, 1);
    equal(readFileSync(join(root, 'limits.mjs'), 'utf8'), CODE);
  });

  it('calls a failure without the expected reason unclear', () => {
    match(runBreaks([brk('breaks the import', 'n <=')]).out, /CAUGHT {4}breaks the import/);
    match(runBreaks([brk('breaks the import', 'n <=', 'the limit rule')]).out, /UNCLEAR {3}breaks the import/);
  });

  it('reports a hang as hung, not caught', () => {
    const sleep = '(Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000), n <= 10)';
    const { out } = runBreaks([brk('loops', sleep)], 1);
    match(out, /HUNG {6}loops {2}\(check\.mjs\): past 1 s/);
    equal(readFileSync(join(root, 'limits.mjs'), 'utf8'), CODE);
  });

  it('refuses a dirty tree', () => {
    const path = config([]);
    writeFileSync(join(root, 'limits.mjs'), `${CODE}// edited\n`);
    const done = spawnSync(process.execPath, [script, '--config', path], { cwd: root, encoding: 'utf8' });
    equal(done.status, 1);
    match(done.stderr, /commit or stash first/);
  });

  it('refuses a break that lacks a field', () => {
    const done = spawnSync(process.execPath, [script, '--config', config([{ name: 'half' } as Break])], { cwd: root, encoding: 'utf8' });
    equal(done.status, 1);
    match(done.stderr, /break "half" lacks path, old, new, test/);
  });

  it('runs only the breaks a word names', () => {
    const { code, out } = runBreaks([brk('off by one', 'n <= 11'), brk('no change in behaviour', '10 >= n')]);
    notEqual(code, 0);
    const only = spawnSync(process.execPath, [script, '--config', join(root, 'breaks.json'), 'off'], { cwd: root, encoding: 'utf8' });
    equal(only.status, 0);
    match(only.stdout, /^CAUGHT {4}off by one/);
    equal(only.stdout.includes('no change'), false);
    match(out, /no change/);
  });
});

describe('verdict', () => {
  it('ranks a hang over everything, then a pass, then a missing expect', () => {
    equal(verdict(0, '', undefined, true), 'HUNG');
    equal(verdict(0, 'FAIL', 'FAIL', false), 'MISSED');
    equal(verdict(1, 'boom', 'the rule', false), 'UNCLEAR');
    equal(verdict(1, 'the rule broke', 'the rule', false), 'CAUGHT');
    equal(verdict(null, '', undefined, false), 'CAUGHT');
  });
});
