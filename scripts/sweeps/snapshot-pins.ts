#!/usr/bin/env node
/**
 * snapshot-pins.ts: refuses a CI run whose dependencies name a pkg.pr.new snapshot, such as
 * `https://pkg.pr.new/<org>/<repo>/<package>@<commit>`, unless it's a run by hand of one named file.
 * Every other run, a pull request's among them, needs the released version in the manifests and
 * the lockfile, since they're the record of what ships together. A snapshot is for trying a
 * dependency's unreleased change on a draft, in a file only CI runs. This checks the run: a dispatch
 * naming exactly one file, in heavy_file or test_paths but not both. It can't see whether the branch
 * is a draft: that part is workflow policy, which the person dispatching keeps.
 *
 *     EVENT=pull_request HEAVY_FILE= TEST_PATHS= node scripts/sweeps/snapshot-pins.ts
 *
 * Runs: first in CI's plan job, right after checkout and before it plans anything, so a refused
 * run starts no test job. Only Node's own modules and `git`: the plan installs nothing.
 * Configure: the CONFIG block: the snapshot host and which tracked files hold dependencies.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------------------------

// pkg.pr.new's host, in any case, under any scheme. pnpm writes a specifier as it's given, so a pin
// is the URL as written; an escaped one would only dodge this on purpose.
const snapshotHost = /pkg\.pr\.new\//i;

/** Git pathspecs of the files dependencies are read from. Only tracked files count. */
const manifestPaths = ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'package.json', '**/package.json'];

// ---------------------------------------------------------------------------------------------

/** A file the dependencies are read from: its path from the root, and its text. */
export interface Manifest {
  readonly path: string;
  readonly text: string;
}

/** How the run started: its event, and a run by hand's named files. */
export interface Run {
  readonly event: string;
  readonly heavyFile: string;
  readonly testPaths: string;
}

/** Each line of the manifests that names a snapshot, as `path:line: text`. */
export const snapshotPins = (manifests: ReadonlyArray<Manifest>) =>
  manifests.flatMap(({ path, text }) => text.split('\n').flatMap((line, index) => (snapshotHost.test(line) ? [`${path}:${String(index + 1)}: ${line.trim()}`] : [])));

/** Why the run can't go on with these pins, or `undefined` when it can. */
export const refusal = (pins: ReadonlyArray<string>, run: Run) => {
  if (pins.length === 0) return undefined;

  const named = [...run.heavyFile.split(/\s+/), ...run.testPaths.split(/\s+/)].filter((path) => path !== '');
  const byHand = run.event === 'workflow_dispatch' && named.length === 1;
  if (byHand) return undefined;

  return [
    'The dependencies name a pkg.pr.new snapshot, which only a run by hand of one named file takes (heavy_file or test_paths), on a draft. Name the released version in the manifests and the lockfile:',
    ...pins.map((pin) => `  ${pin}`),
  ].join('\n');
};

if (argv[1] === fileURLToPath(import.meta.url)) {
  const paths = execFileSync('git', ['ls-files', '-z', '--', ...manifestPaths], { encoding: 'utf8' })
    .split('\0')
    .filter((path) => path !== '');
  const pins = snapshotPins(paths.map((path) => ({ path, text: readFileSync(path, 'utf8') })));
  const refused = refusal(pins, { event: env['EVENT'] ?? '', heavyFile: env['HEAVY_FILE'] ?? '', testPaths: env['TEST_PATHS'] ?? '' });

  if (refused !== undefined) {
    console.error(`::error::${refused.split('\n')[0] ?? ''}`);
    console.error(refused);
    exit(1);
  }

  console.error(
    pins.length === 0
      ? `snapshot-pins: ${String(paths.length)} manifests name no snapshot`
      : `snapshot-pins: a run by hand of one named file, so the snapshot is allowed:\n${pins.join('\n')}`,
  );
}
