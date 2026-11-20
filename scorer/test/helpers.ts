// Runs the built CLI as a child process, with the gh stub first on PATH and a fresh, empty home, so a test sees
// exactly what a person's terminal would and touches neither GitHub nor the real home folder.
// The stub is a Node script with a shebang, so these tests rely on POSIX `PATH` lookup; they don't run on Windows.
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Routes } from './fixtures.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// The built CLI, or the source when CI_DOCTOR_TEST_CLI=src: the repo's build checks run the source, with Node only.
export const CLI = process.env.CI_DOCTOR_TEST_CLI === 'src' ? join(HERE, '..', 'src', 'cli.ts') : join(HERE, '..', 'dist', 'cli.js');
const STUB = join(HERE, 'stub', 'gh.cjs');
const which = (name: string) => execFileSync('which', [name], { encoding: 'utf8' }).trim();

const made: string[] = [];
process.on('exit', () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A fresh folder, removed when the test file's process exits. */
export const scratch = () => {
  const dir = mkdtempSync(join(process.env.CI_DOCTOR_TEST_TMP ?? tmpdir(), 'ci-doctor-test-'));
  made.push(dir);
  return dir;
};

/** A bin folder holding git, node (for the stub's shebang) and, unless left out, the gh stub: nothing else from the real PATH. */
export const binDir = (root: string, { gh = true } = {}) => {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  symlinkSync(which('git'), join(bin, 'git'));
  symlinkSync(process.execPath, join(bin, 'node'));
  if (gh) {
    copyFileSync(STUB, join(bin, 'gh'));
    chmodSync(join(bin, 'gh'), 0o755);
  }
  return bin;
};

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Each `gh` call's arguments, in order. */
  calls: string[][];
  home: string;
}

export interface RunOptions {
  routes?: Routes;
  cwd?: string;
  gh?: boolean;
  env?: Record<string, string>;
  /** Make any fetch() in the CLI throw, to prove a run never reaches the network itself. */
  noNetwork?: boolean;
}

export const runCli = (args: string[], o: RunOptions = {}): Promise<Run> => {
  const root = scratch();
  const home = join(root, 'home');
  mkdirSync(home);
  const fixtures = join(root, 'routes.json');
  writeFileSync(fixtures, JSON.stringify(o.routes ?? {}));
  const log = join(root, 'gh.log');
  writeFileSync(log, '');
  const nodeArgs = o.noNetwork ? ['--import', 'data:text/javascript,globalThis.fetch=()=>{throw new Error("no network in this test")}'] : [];

  const env: Record<string, string> = {
    PATH: binDir(root, { gh: o.gh ?? true }),
    HOME: home,
    XDG_CACHE_HOME: join(home, '.cache'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    GH_STUB_FIXTURES: fixtures,
    GH_STUB_LOG: log,
    GIT_CONFIG_NOSYSTEM: '1',
    ...o.env,
  };

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, CLI, ...args], { cwd: o.cwd ?? home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
      resolve({ code, stdout, stderr, calls, home });
    });
  });
};

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Pip', '-c', 'user.email=pip@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(cwd, '..', 'no-gitconfig') },
  });

/** A Git checkout with one commit, a workflow and a package.json, and the given remotes. */
export const checkout = (remotes: Record<string, string> = {}) => {
  const dir = join(scratch(), 'app');
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'on: pull_request\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n');
  writeFileSync(join(dir, 'package.json'), '{"devDependencies":{"vitest":"4.0.0"}}\n');
  writeFileSync(join(dir, 'package-lock.json'), '{}\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;\n'.repeat(500));
  gitIn(dir, 'init', '-q');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  for (const [name, url] of Object.entries(remotes)) gitIn(dir, 'remote', 'add', name, url);
  return dir;
};

/** Every file under a folder, with its size, to see whether a run wrote anything. */
export const listing = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();

/** Points this process's gh at the stub and these answers for the length of `f`, for tests that call the scorer in-process. */
export const withStub = <T>(routes: Routes, env: Record<string, string>, f: (log: () => string[][]) => T): T => {
  const root = scratch();
  const fixtures = join(root, 'routes.json');
  const logFile = join(root, 'gh.log');
  writeFileSync(fixtures, JSON.stringify(routes));
  writeFileSync(logFile, '');
  const set = { PATH: binDir(root), GH_STUB_FIXTURES: fixtures, GH_STUB_LOG: logFile, GH_TOKEN: '', ...env };
  const before = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
  Object.assign(process.env, set);
  const log = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
  try {
    return f(log);
  } finally {
    for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
};
