/**
 * test-slots.ts: each test file's turn on this machine. A file starts only while fewer than the cap
 * run, across every run in every worktree. Each run's `maxWorkers` caps only its own run; with many
 * agents running tests at once, three runs of three workers each held a 14-core machine at a load
 * of 17, where a heavy test file bundles a Worker and starts its runtime.
 *
 * Where it runs: `test-file-slot.ts` takes one for each test file, as a Vitest setup file, on
 * developers' and agents' machines. CI runs one run per machine, so it takes no turn.
 *
 * How: a turn is a slot, `<n>.lock` under `/tmp/<project>-test-slots-<uid>`, held with `flock` by a
 * Perl child that lets go when its stdin ends, as it does when this process ends, even when killed.
 * A child still waiting ends when this process does. The directory is the user's own, so another
 * user can't lock them out, and in `/tmp`, not `os.tmpdir()`, which an agent's sandbox may move.
 * Only processes that share `/tmp` take turns: runs in separate containers or VMs each have their own.
 *
 * Configure: `PROJECT`, and `TEST_SLOTS` in the environment to override the cap.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { createInterface } from 'node:readline';

/** A short name for the slot directory and the log's folder. */
export const PROJECT = '<project>';

/**
 * How many test files may run at once: `TEST_SLOTS`, or a quarter of the cores, at least two. A
 * quarter was the highest cap with no timeouts, measured on a 16-core, 29 GB machine running 54
 * heavy test files uncached while other worktrees ran tests:
 *
 * | Cap | Wall time         | Rounds | Timeouts | Sockets closed | Load, mean and peak | Others' slots |
 * | --- | ----------------- | ------ | -------- | -------------- | ------------------- | ------------- |
 * | 4   | 815 s             | 2      | 0        | 1              | 9.1, 14.6           | 1, up to 5    |
 * | 6   | 378 s             | 3      | 3        | 0              | 10.2, 16.1          | 1, up to 3    |
 * | 8   | stopped, 3,522 s  | 4      | many     | many           | 11 to 24            | 3 worktrees'  |
 *
 * Timeouts are tests failed at their 30 s limit. Cap 4 failed one test, cap 6 five. At 4, the run
 * waited for slots that runs at cap 8 held: a cap-4 run takes only slots 1 to 4, which a cap-8 run
 * takes first, so its time is the least telling. Cap 8 had been the default.
 */
export const testFiles =
  Math.max(1, Math.trunc(Number(process.env['TEST_SLOTS']))) ||
  Math.max(2, Math.floor(availableParallelism() / 4));

export const slotsDir = `/tmp/${PROJECT}-test-slots-${process.getuid?.() ?? 0}`;

/** A file's turn: the slot it held of `cap`, none without Perl, and when it asked, got and let go. */
export interface Turn {
  readonly slot: number | null;
  readonly cap: number;
  readonly asked: Date;
  readonly got: Date;
  readonly released: Date;
}

/** Whether Perl runs here: a slim image may have none. */
const perl = spawnSync('perl', ['-e', '1']).error === undefined;

/**
 * Waits for a slot of `count` under `dir`, and answers its release. The child tries each slot
 * without blocking, four times a second, until one is free or this process has ended. Without
 * Perl, the file takes no turn and says so. The release answers the turn.
 */
export const takeSlot = async (dir: string, count: number): Promise<() => Promise<Turn>> => {
  const asked = new Date();

  if (!perl) {
    console.warn('No perl on PATH: this test file takes no turn (test-slots.ts).');

    return async () => ({ slot: null, cap: count, asked, got: asked, released: new Date() });
  }

  mkdirSync(dir, { recursive: true });

  const holder = spawn(
    'perl',
    [
      '-MFcntl=:flock',
      '-e',
      `my ($dir, $count, $parent) = @ARGV;
       for (;;) {
         for my $slot (1 .. $count) {
           open my $lock, '>>', "$dir/$slot.lock" or die $!;
           if (flock $lock, LOCK_EX | LOCK_NB) { $| = 1; print "held $slot\\n"; <STDIN>; exit 0 }
           close $lock;
         }
         exit 0 if getppid() != $parent;
         select undef, undef, undef, 0.25;
       }`,
      dir,
      String(count),
      String(process.pid),
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const [line] = await Promise.race([
    once(createInterface({ input: holder.stdout }), 'line'),
    once(holder, 'exit').then(() => ['']),
  ]);

  const held = /^held (\d+)$/.exec(String(line));
  if (held === null) throw new Error(`no test file slot was taken: ${String(line)}`);

  const got = new Date();

  return async () => {
    holder.stdin.end();

    if (holder.exitCode === null && holder.signalCode === null) await once(holder, 'exit');

    return { slot: Number(held[1]), cap: count, asked, got, released: new Date() };
  };
};
