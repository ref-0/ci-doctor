/**
 * test-slots.test.ts: tests for machine-wide test slots, each in a directory of its own. Needs Perl.
 * Run with `node --test test-slots.test.ts`.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { ok, notStrictEqual, strictEqual } from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { takeSlot } from './test-slots.ts';

const freshDir = () => mkdtempSync(`${tmpdir()}/test-slots-`);

describe('takeSlot', () => {
  test('waits while every slot is held, and starts once one is let go', async () => {
    const dir = freshDir();
    const first = await takeSlot(dir, 1);
    let started = false;
    const second = takeSlot(dir, 1).then((release) => {
      started = true;

      return release;
    });

    await sleep(1000);
    strictEqual(started, false);

    await first();
    const release = await second;
    strictEqual(started, true);

    await release();
  });

  test('says when each file asked, got its slot and let go, a wait for it included', async () => {
    const dir = freshDir();
    const first = await takeSlot(dir, 1);
    const second = takeSlot(dir, 1);

    await sleep(500);

    // The slot is free once the first holder exits, which may be seen after the second has taken
    // it, so the second's turn is told against the release's start.
    const releasing = Date.now();
    const held = await first();
    const waited = await (await second)();

    for (const turn of [held, waited]) {
      strictEqual(turn.slot, 1);
      strictEqual(turn.cap, 1);
      ok(turn.asked.getTime() <= turn.got.getTime());
      ok(turn.got.getTime() <= turn.released.getTime());
    }

    ok(held.released.getTime() >= releasing);
    ok(waited.asked.getTime() < releasing);
    ok(waited.got.getTime() >= releasing);
  });

  test('takes a free slot beside a held one', async () => {
    const dir = freshDir();
    const first = await takeSlot(dir, 2);
    const second = await takeSlot(dir, 2);

    notStrictEqual(second, first);

    const turns = await Promise.all([first(), second()]);
    notStrictEqual(turns[0].slot, turns[1].slot);
  });
});
