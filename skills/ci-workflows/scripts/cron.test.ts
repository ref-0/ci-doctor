/**
 * Tests for cron.ts: parsing a cron, its slots, its longest gap over the calendar's cycle, and the
 * newest slot that sweep.yml's fallback starts a missed sweep from.
 *
 * Runs: `node --test cron.test.ts` from this folder (Node 24).
 */
import { deepStrictEqual, equal, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { longestGap, main, newestSlot, parseCron, slotsOf } from './cron.ts';

const hour = 3600;
const day = 24 * hour;
const utc = (text: string) => Date.parse(text) / 1000;
const newest = (cron: string, at: string) => {
  const slot = newestSlot(parseCron(cron), utc(at));
  return slot === undefined ? undefined : new Date(slot * 1000).toISOString();
};

describe('slots', () => {
  const at0 = utc('2026-11-02T00:00:00Z'); // a Monday

  it('places slots at the cron’s own time of day, not from the span’s start', () => {
    // A span that starts at 10:00: the daily 02:41 slot is the next day's, not 10:00 + 24 hours.
    deepStrictEqual(slotsOf(parseCron('41 2 * * *'), at0 + 10 * hour, at0 + 2 * day), [at0 + day + 2 * hour + 41 * 60]);
  });

  it('reads every 2 days as cron does, weekly on its weekday, and either day when both are set', () => {
    deepStrictEqual(slotsOf(parseCron('0 0 */2 * *'), at0, at0 + 6 * day).map((t) => new Date(t * 1000).getUTCDate()), [3, 5, 7]);
    deepStrictEqual(slotsOf(parseCron('0 3 * * 1'), at0, at0 + 14 * day), [at0 + 3 * hour, at0 + 7 * day + 3 * hour]);
    // The 1st of the month or a Monday: 1 December 2026 is a Tuesday.
    deepStrictEqual(slotsOf(parseCron('0 0 1 * 1'), at0 + 25 * day, at0 + 35 * day).map((t) => new Date(t * 1000).getUTCDate()), [30, 1, 7]);
    deepStrictEqual(slotsOf(parseCron('0 0 * * 7'), at0, at0 + 7 * day), [at0 + 6 * day]);
  });

  it('reads a day of the week over 0 to 7, with 7 as Sunday, in ranges and steps too', () => {
    const days = (cron: string) => [...(parseCron(cron).dow ?? [])].toSorted((a, b) => a - b);
    deepStrictEqual(days('0 0 * * 7'), [0]);
    deepStrictEqual(days('0 0 * * 0-7'), [0, 1, 2, 3, 4, 5, 6]);
    deepStrictEqual(days('0 0 * * 1-7'), [0, 1, 2, 3, 4, 5, 6]);
    deepStrictEqual(days('0 0 * * */7'), [0]);
    deepStrictEqual(days('0 0 * * 5-7'), [0, 5, 6]);
  });

  it('refuses what it doesn’t read', () => {
    throws(() => parseCron('0 0 * *'), /five fields/);
    throws(() => parseCron('0 25 * * *'), /out of range/);
    throws(() => parseCron('0 0 * * MON'), /isn't one this reads/);
  });
});

describe('the longest gap, over the calendar’s cycle', () => {
  it('measures hour lists, weeks and every 2 days', () => {
    equal(longestGap(parseCron('5 2,8,14,20 * * *')), 6 * hour);
    equal(longestGap(parseCron('41 8,14,20 * * *')), 12 * hour);
    equal(longestGap(parseCron('0 0 * * 1')), 7 * day);
    // A 30-day month's 29th to the next 1st is two days; a 31-day month's 31st to the 1st is one.
    equal(longestGap(parseCron('0 0 */2 * *')), 2 * day);
  });

  it('counts the wrap from a season’s last slot to its first again', () => {
    // 1 February and 1 March: 28 or 29 days apart, then 337 to the next February.
    equal(longestGap(parseCron('0 0 1 2,3 *')), 337 * day);
    // January's 31 days, then 31 January to 1 January: 336 days across a 29 February.
    equal(longestGap(parseCron('0 0 * 1 *')), 336 * day);
    // 29 February: four years apart, but eight across 2100, which isn't a leap year.
    equal(longestGap(parseCron('0 12 29 2 *')), (8 * 365 + 1) * day);
  });

  it('is Infinity for a cron that never runs', () => {
    equal(longestGap(parseCron('0 0 31 2 *')), Infinity);
  });
});

describe('the newest slot, as the fallback finds it', () => {
  it('finds a weekly sweep’s Monday from any day of its week', () => {
    equal(newest('41 2 * * 1', '2026-11-20T12:00:00Z'), '2026-11-16T02:41:00.000Z');
    equal(newest('41 2 * * 1', '2026-11-16T02:40:00Z'), '2026-11-09T02:41:00.000Z');
    equal(newest('41 2 * * 1', '2026-11-16T02:41:00Z'), '2026-11-16T02:41:00.000Z');
  });

  it('finds every 2 days across a month’s end, by the day of the month', () => {
    // A 31-day month: the 31st, then the 1st, a day apart.
    equal(newest('41 2 */2 * *', '2026-11-01T01:00:00Z'), '2026-10-31T02:41:00.000Z');
    equal(newest('41 2 */2 * *', '2026-11-01T03:00:00Z'), '2026-11-01T02:41:00.000Z');
    // A 30-day month: the 29th, then the 1st.
    equal(newest('41 2 */2 * *', '2026-12-01T01:00:00Z'), '2026-11-29T02:41:00.000Z');
    // February 2026, 28 days: the 27th, then 1 March.
    equal(newest('41 2 */2 * *', '2026-03-01T01:00:00Z'), '2026-02-27T02:41:00.000Z');
  });

  it('finds the newest of an hour list, today or yesterday', () => {
    equal(newest('41 8,14,20 * * *', '2026-11-20T13:00:00Z'), '2026-11-20T08:41:00.000Z');
    equal(newest('41 8,14,20 * * *', '2026-11-20T14:41:00Z'), '2026-11-20T14:41:00.000Z');
    equal(newest('41 8,14,20 * * *', '2026-11-20T07:00:00Z'), '2026-11-19T20:41:00.000Z');
    equal(newest('0,30 9 * * *', '2026-11-20T09:45:00Z'), '2026-11-20T09:30:00.000Z');
  });

  it('reaches back a season, and finds nothing for a cron that never runs', () => {
    equal(newest('0 0 1 2,3 *', '2026-11-20T00:00:00Z'), '2026-03-01T00:00:00.000Z');
    equal(newest('0 0 31 2 *', '2026-11-20T00:00:00Z'), undefined);
  });

  it('prints it as GitHub’s created filter takes it, and fails on a cron that never runs', () => {
    equal(main(['newest', '41 2 * * 1', '--at', '2026-11-20T12:00:00Z']), '2026-11-16T02:41:00Z');
    equal(main(['newest', '41 2 * * 1'], utc('2026-11-20T12:00:00Z')), '2026-11-16T02:41:00Z');
    throws(() => main(['newest', '0 0 31 2 *']), /never runs/);
    throws(() => main(['newest']), /Usage/);
    throws(() => main(['newest', '41 2 * * 1', '--at', 'Friday']), /ISO time/);
  });
});
