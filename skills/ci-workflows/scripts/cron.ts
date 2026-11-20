#!/usr/bin/env node
/**
 * What: reads a five-field cron, UTC, as GitHub's `on.schedule` takes it: its slots in a span, the
 *   longest gap between them over the calendar's whole cycle, and its newest slot at or before a time.
 * Where: `sweep-cadence.ts` imports it to price schedules. A repo's `sweep.yml` runs its copy, at
 *   `scripts/sweeps/cron.ts`, to find the newest sweep slot before it starts a missed sweep, so the
 *   fallback and the pricing read a cron the same way.
 * Configure: nothing. Needs Node 24.
 * Tests: `node --test cron.test.ts`, from this folder.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 *   node cron.ts newest '41 2 * * 1'                       the newest Monday 02:41 at or before now,
 *                                                          as 2026-11-16T02:41:00Z
 *   node cron.ts newest '41 2 * * 1' --at 2026-11-20T12:00:00Z
 *
 * It reads numbers, ranges, lists, `*` and steps (`*` + `/n`, `a/n`, `a-b/n`), and a day of the week
 * of 7 as Sunday. With both the day of the month and of the week restricted, a day matching either
 * runs, as cron and GitHub do. Names (`MON`, `JAN`) and GitHub's other extensions aren't read: it
 * throws on them rather than guess.
 */
import { argv, stderr } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** A parsed cron, UTC: each field's values, null where it's `*`. */
export type Cron = { minute: Set<number>; hour: Set<number>; dom: Set<number> | null; month: Set<number> | null; dow: Set<number> | null };

const DAY = 86_400;

/** The Gregorian calendar's cycle, in days: 400 years, a whole number of weeks, so every cron repeats over it. */
export const cycleDays = 146_097;

/** One cron field's values, from `*`, `*` + `/n`, `a`, `a-b` and lists of them; null for a bare `*`. */
function field(text: string, low: number, high: number): Set<number> | null {
  if (text === '*') return null;
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`a cron field of ${JSON.stringify(text)} isn't one this reads: use numbers, ranges, lists, * and */n`);
    const from = match[1] === '*' ? low : Number(match[2]);
    const to = match[1] === '*' ? high : match[3] === undefined ? (match[4] === undefined ? from : high) : Number(match[3]);
    const step = match[4] === undefined ? 1 : Number(match[4]);
    if (from < low || to > high || from > to || step < 1) throw new Error(`a cron field of ${JSON.stringify(text)} is out of range`);
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

/** Parses a five-field cron, as GitHub's `on.schedule` takes it. */
export function parseCron(text: string): Cron {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`a cron has five fields, not ${JSON.stringify(text)}`);
  const [minute = '', hour = '', dom = '', month = '', dow = ''] = parts;
  const all = (set: Set<number> | null, low: number, high: number) => set ?? new Set(Array.from({ length: high - low + 1 }, (_, i) => low + i));
  return {
    minute: all(field(minute, 0, 59), 0, 59),
    hour: all(field(hour, 0, 23), 0, 23),
    dom: field(dom, 1, 31),
    month: field(month, 1, 12),
    dow: field(dow.replace(/\b7\b/g, '0'), 0, 6),
  };
}

/** Whether the cron runs on the UTC day starting at `day`, in seconds since the epoch. */
function runsOn(cron: Cron, day: number): boolean {
  const date = new Date(day * 1000);
  if (cron.month && !cron.month.has(date.getUTCMonth() + 1)) return false;
  // Cron's rule: with both days restricted, either matches.
  const dom = cron.dom?.has(date.getUTCDate());
  const dow = cron.dow?.has(date.getUTCDay());
  return dom === undefined ? dow !== false : dow === undefined ? dom : dom || dow;
}

/** The cron's times within a day it runs on, in seconds after midnight, in order. */
function timesOf(cron: Cron): number[] {
  const times: number[] = [];
  for (const h of [...cron.hour].toSorted((a, b) => a - b)) for (const m of [...cron.minute].toSorted((a, b) => a - b)) times.push(h * 3600 + m * 60);
  return times;
}

/** Each slot of `cron` after `start` and at most `end`, in seconds since the epoch, in order. */
export function slotsOf(cron: Cron, start: number, end: number): number[] {
  const slots: number[] = [];
  const times = timesOf(cron);
  for (let day = Math.floor(start / DAY) * DAY; day <= end; day += DAY) {
    if (!runsOn(cron, day)) continue;
    for (const time of times) if (day + time > start && day + time <= end) slots.push(day + time);
  }
  return slots;
}

/**
 * The longest gap between a cron's slots, in seconds, over the calendar's whole 400-year cycle,
 * counting the wrap from its last slot to the first again: Infinity for a cron that never runs.
 */
export function longestGap(cron: Cron): number {
  const from = Date.UTC(2000, 0, 1) / 1000;
  const days: number[] = [];
  for (let d = 0; d < cycleDays; d++) if (runsOn(cron, from + d * DAY)) days.push(d);
  const first = days[0];
  if (first === undefined) return Infinity;

  // Every day it runs on has the same times, so the longest gap is within a day or across the
  // fewest days it runs on, from a day's last time to the next one's first.
  const times = timesOf(cron);
  let within = 0;
  for (let i = 1; i < times.length; i++) within = Math.max(within, (times[i] ?? 0) - (times[i - 1] ?? 0));
  let apart = first + cycleDays - (days.at(-1) ?? first);
  for (let i = 1; i < days.length; i++) apart = Math.max(apart, (days[i] ?? 0) - (days[i - 1] ?? 0));

  return Math.max(within, apart * DAY - ((times.at(-1) ?? 0) - (times[0] ?? 0)));
}

/** The cron's newest slot at or before `at`, in seconds since the epoch, or undefined for a cron that never runs. */
export function newestSlot(cron: Cron, at: number): number | undefined {
  const times = timesOf(cron).toReversed();
  for (let day = Math.floor(at / DAY) * DAY, d = 0; d <= cycleDays; day -= DAY, d++) {
    if (!runsOn(cron, day)) continue;
    const time = times.find((t) => day + t <= at);
    if (time !== undefined) return day + time;
  }
  return undefined;
}

/** A time as GitHub's `created` filter takes it, to the second: `2026-11-16T02:41:00Z`. */
export const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const HELP = `Usage: node cron.ts newest '<cron>' [--at <ISO time>]
Prints the cron's newest slot at or before --at (default: now), UTC, as 2026-11-16T02:41:00Z.`;

export function main(args: readonly string[], now = Math.floor(Date.now() / 1000)): string {
  const { values, positionals } = parseArgs({ args: [...args], allowPositionals: true, options: { help: { type: 'boolean', short: 'h' }, at: { type: 'string' } } });
  if (values.help) return HELP;
  const [command, cron, ...rest] = positionals;
  if (command !== 'newest' || cron === undefined || rest.length) throw new Error(HELP);

  const at = values.at === undefined ? now : Date.parse(values.at) / 1000;
  if (!Number.isFinite(at)) throw new Error(`--at takes an ISO time, such as 2026-11-20T12:00:00Z, not ${JSON.stringify(values.at)}`);
  const slot = newestSlot(parseCron(cron), Math.floor(at));
  if (slot === undefined) throw new Error(`${JSON.stringify(cron)} never runs`);

  return iso(slot);
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(main(argv.slice(2)));
  } catch (error) {
    stderr.write(`cron.ts: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
