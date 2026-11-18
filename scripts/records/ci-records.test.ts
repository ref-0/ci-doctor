/**
 * ci-records.test.ts: tests for the collector's log parsing. Run with `node --test ci-records.test.ts`.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { deepStrictEqual, notStrictEqual, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import { heldIn, recordsIn, unzipEntries, zipKey } from './ci-records.ts';
import { recordLine, type TestsRecord } from './test-record.ts';

describe('recordsIn', () => {
  test("reads the reporter's line back from a job's log, and skips the step that names the prefix", () => {
    const record: TestsRecord = {
      kind: 'tests',
      files: [['src/a.test.ts', 'failed', 12]],
      failed: [['src/a.test.ts', 'a > fails']],
      flaky: [['src/a.test.ts', 'a > flakes', 1]],
      errors: 0,
      imports: [['src/a.test.ts', 40, [['some-lib/dist/index.js', 2, 31]]]],
    };
    const log = [
      "2026-11-02T16:01:50.1000000Z ##[group]Run jq -nc '{kind: \"plan\"}' | sed 's/^/ci-record /'",
      '2026-11-02T16:01:51.2000000Z  ✓ src/b.test.ts (1 test) 3ms',
      `2026-11-02T16:01:52.3000000Z ${recordLine(record).trimEnd()}`,
    ].join('\n');

    deepStrictEqual(recordsIn(log), [record]);
  });
});

test('archives the plan and timestamps for jobs with and without test logs', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-records-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const created_at = '2026-01-01T00:00:00Z';
  const run = { id: 1, run_attempt: 1, event: 'pull_request', head_branch: 'topic', head_sha: 'abc', created_at, conclusion: 'success' };
  const plan = { kind: 'plan', changed: ['src/code.ts'], test_selection: { 'src/code.test.ts': 'imports-changed-module' } };
  const timings = [
    { id: 10, name: 'Plan', conclusion: 'success', labels: ['runner-a'], created_at, started_at: created_at, completed_at: created_at },
    { id: 11, name: 'Build', conclusion: 'success', labels: ['runner-b'], created_at, started_at: created_at, completed_at: created_at },
    { id: 12, name: 'Tests 1/1', conclusion: 'skipped', labels: [], created_at: null, started_at: null, completed_at: null },
  ];
  writeFileSync(join(directory, 'logs.zip'), zipOf([['0_Plan.txt', `ci-record ${JSON.stringify(plan)}\n`]]));
  writeFileSync(join(directory, 'gh'), `#!/bin/sh
case "$*" in
  *attempts/1/jobs*created_at*started_at*completed_at*) printf '%s\\n' ${timings.map((job) => `'${JSON.stringify(job)}'`).join(' ')} ;;
  *attempts/1/logs*) cat "$(dirname "$0")/logs.zip" ;;
  'api repos/o/r/actions/runs/1 '*) printf '%s\\n' '${JSON.stringify(run)}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });

  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./ci-records.ts', import.meta.url)), '--repo', 'o/r', '--run', '1'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: [directory, process.env['PATH']].join(delimiter) },
  });
  const entry = JSON.parse(output) as Record<string, unknown>;
  deepStrictEqual(entry['plan'], plan);
  deepStrictEqual(entry['job_timings'], timings);
  deepStrictEqual(entry['jobs'], []);
});

describe('heldIn', () => {
  const line = (run: number, created: string, complete: boolean) =>
    JSON.stringify({ run, attempt: 1, created, complete, unreadable: complete ? [] : ['Tests 1/2'] });
  const now = Date.parse('2026-11-10T00:00:00Z');

  test("drops an incomplete record of the days it collects, so it's read again, and keeps the rest", () => {
    const text = [line(1, '2026-11-08T10:00:00Z', true), line(2, '2026-11-08T11:00:00Z', false), line(3, '2026-11-07T11:00:00Z', false)].join('\n');
    const { kept, held, dropped } = heldIn(`${text}\n`, '2026-11-08', '2026-11-08', now);

    strictEqual(dropped, 1);
    deepStrictEqual([...held], ['1/1', '3/1']);
    deepStrictEqual(kept.length, 2);
  });

  test('keeps an incomplete record once its logs are past keeping, as it can be read no more', () => {
    const { held, dropped } = heldIn(line(4, '2026-08-01T00:00:00Z', false), '2026-08-01', '2026-08-01', now);

    strictEqual(dropped, 0);
    deepStrictEqual([...held], ['4/1']);
  });
});

describe('zipKey', () => {
  test("matches a job to its file in a run's log zip, which writes `/` as `_`", () => {
    strictEqual(zipKey('Tests 1/3'), zipKey('Tests 1_3'));
    strictEqual(zipKey('Build / Linux on x64'), zipKey('Build _ Linux on x64'));
    notStrictEqual(zipKey('Tests 1/3'), zipKey('Tests 1/31'));
  });
});

/** A one-disk zip of `files`, deflated, as GitHub sends a run's logs. */
const zipOf = (files: ReadonlyArray<readonly [string, string]>) => {
  const locals: Array<Buffer> = [];
  const directory: Array<Buffer> = [];
  let offset = 0;

  for (const [name, text] of files) {
    const nameBytes = Buffer.from(name);
    const data = deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    directory.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, ...directory, end]);
};

describe('unzipEntries', () => {
  test("reads each job's log from a deflated zip", () => {
    const entries = unzipEntries(zipOf([['0_Plan.txt', 'plan log'], ['1_Tests 1_3.txt', 'tests log']]));

    deepStrictEqual(
      entries.map(({ name, data }) => [name, data.toString('utf8')]),
      [['0_Plan.txt', 'plan log'], ['1_Tests 1_3.txt', 'tests log']],
    );
  });
});
