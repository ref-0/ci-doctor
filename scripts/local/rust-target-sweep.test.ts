/**
 * rust-target-sweep.test.ts: tests for the three checks a target must pass before it's deleted. Run
 * with `node --test rust-target-sweep.test.ts`. Needs `git`; it never calls `gh`.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lutimesSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { changedRecently, gib, inUse, mappedPath, merged, size, why } from './rust-target-sweep.ts';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'rust-target-sweep-')));
after(() => rmSync(scratch, { recursive: true, force: true }));

const DAY = 24 * 60 * 60;
const now = Date.now() / 1000;

/** Sets every entry under `dir`, but not `dir` itself, to `seconds` ago, without following links. */
const age = (dir: string, seconds: number) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) age(path, seconds);
    if (!entry.isSymbolicLink()) utimesSync(path, now - seconds, now - seconds);
  }
};

/** A worktree with a built target, every entry two days old. */
const worktree = (name: string) => {
  const dir = join(scratch, name);
  mkdirSync(join(dir, 'crates/service/target/debug'), { recursive: true });
  writeFileSync(join(dir, 'crates/service/src.rs'), 'fn main() {}\n');
  writeFileSync(join(dir, 'crates/service/target/debug/build'), Buffer.alloc(1000));
  age(dir, 2 * DAY);
  return dir;
};

describe('mappedPath', () => {
  test("reads a mapping's file, with spaces, and skips anonymous ones", () => {
    strictEqual(mappedPath('7f00-7f01 r-xp 00000000 08:01 1234    /work/a b/lib.so (deleted)'), '/work/a b/lib.so (deleted)');
    strictEqual(mappedPath('7ffd-7ffe rw-p 00000000 00:00 0                          [stack]'), undefined);
    strictEqual(mappedPath('7ffd-7ffe rw-p 00000000 00:00 0'), undefined);
  });
});

describe('inUse', () => {
  test('the worktree or a path under it, not a sibling that shares its prefix', () => {
    const dir = worktree('used');

    strictEqual(inUse(dir, new Set([dir])), true);
    strictEqual(inUse(dir, new Set([join(dir, 'crates/service/src.rs')])), true);
    strictEqual(inUse(dir, new Set([`${dir}-2/src.rs`, '/usr/lib/libc.so'])), false);
  });

  test('through a symlink to the worktree', () => {
    const dir = worktree('linked');
    symlinkSync(dir, join(scratch, 'link-to-linked'));

    strictEqual(inUse(join(scratch, 'link-to-linked'), new Set([join(dir, 'x')])), true);
  });
});

describe('changedRecently', () => {
  test('a fresh build in the target is not a change', () => {
    const dir = worktree('built');
    const target = join(dir, 'crates/service/target');
    writeFileSync(join(target, 'debug/fresh'), '');

    strictEqual(changedRecently(dir, target, now), false);
  });

  test('a fresh file or folder outside the target is', () => {
    const dir = worktree('edited');
    const target = join(dir, 'crates/service/target');
    mkdirSync(join(dir, 'notes'));
    age(dir, 2 * DAY);
    utimesSync(join(dir, 'notes'), now - 60, now - 60);

    strictEqual(changedRecently(dir, target, now), true);
  });

  test('a symlinked folder is checked itself but not entered', () => {
    const dir = worktree('symlinked');
    const elsewhere = join(scratch, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'fresh'), '');
    symlinkSync(elsewhere, join(dir, 'shared'));
    const target = join(dir, 'crates/service/target');

    strictEqual(changedRecently(dir, target, now), true);
    lutimesSync(join(dir, 'shared'), now - 2 * DAY, now - 2 * DAY);
    strictEqual(changedRecently(dir, target, now), false);
  });
});

describe('size', () => {
  test("the files' bytes, not following a symlink to a folder", () => {
    const dir = worktree('sized');
    const target = join(dir, 'crates/service/target');
    symlinkSync(join(dir, 'crates'), join(target, 'loop'));

    strictEqual(size(target), 1000);
  });

  test('in GiB to one decimal', () => {
    deepStrictEqual([0, 1.5, 12].map((x) => gib(x * 2 ** 30)), ['0.0', '1.5', '12.0']);
  });
});

describe('why', () => {
  const target = 'crates/service/target';
  const isMerged = () => 'HEAD is in origin/main';

  test('qualifies an unused, merged worktree with nothing fresh outside its target', () => {
    deepStrictEqual(why(worktree('idle'), new Set(), target, isMerged), [true, 'HEAD is in origin/main']);
  });

  test('keeps one in use, not merged, or changed in the last day, in that order', () => {
    const dir = worktree('busy');

    deepStrictEqual(why(dir, new Set([dir]), target, () => null), [false, 'in use']);
    deepStrictEqual(why(dir, new Set(), target, () => null), [false, 'not merged and no closed PR']);
    writeFileSync(join(dir, 'fresh.rs'), '');
    deepStrictEqual(why(dir, new Set(), target, isMerged), [false, 'changed in the last 24 hours']);
  });
});

describe('merged', () => {
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { stdio: 'pipe' });

  test("HEAD in origin's default branch, and a detached HEAD that isn't, without asking gh", () => {
    const origin = join(scratch, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, 'commit', '-q', '--allow-empty', '-m', 'one');
    const clone = join(scratch, 'clone');
    execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'pipe' });

    strictEqual(merged(clone, '<org>/<repo>', 'main'), 'HEAD is in origin/main');

    git(clone, 'commit', '-q', '--allow-empty', '-m', 'two');
    git(clone, 'checkout', '-q', '--detach');
    strictEqual(merged(clone, '<org>/<repo>', 'main'), null);
  });

  test('a folder that is no repo', () => {
    strictEqual(merged(worktree('plain'), '<org>/<repo>', 'main'), null);
  });
});
