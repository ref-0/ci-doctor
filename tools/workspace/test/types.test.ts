/**
 * The type driver and its cache, on throwaway workspaces outside Git. Most tests inject
 * `fixtures/fake-tsc.mjs` as the checker, so they need nothing installed. The last group runs the
 * real `tsc` when `WORKSPACE_TOOLS_NODE_MODULES` names a `node_modules` holding `typescript`, or
 * this package's own install has it, and skips otherwise.
 *
 *     node --test tools/workspace/test/
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execPath } from 'node:process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/fake-tsc.mjs', import.meta.url));

let root: string;
let cache: string;
let log: string;
let env: NodeJS.ProcessEnv;
const made: Array<string> = [];

const temporary = (prefix: string) => {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  made.push(folder);

  return folder;
};

const write = (files: Record<string, string>, at = root) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(at, path)), { recursive: true });
    writeFileSync(join(at, path), text);
  }
};

/** A project of the `*.ts` beside it, with `lib`. */
const project = (lib: ReadonlyArray<string>) =>
  JSON.stringify({
    compilerOptions: { composite: true, lib, module: 'ESNext', moduleResolution: 'Bundler', noEmit: true, strict: true, types: [] },
    include: ['*.ts'],
  });

/**
 * A root that reaches `dom`, which reads the DOM, and `app`, which has no DOM and imports `dom`'s
 * file, as an app imports a UI package's source. `app`'s program holds that file, where `document`
 * doesn't exist.
 */
const workspace = {
  'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './dom' }, { path: './app' }] }),
  'dom/tsconfig.json': project(['ES2023', 'DOM']),
  'dom/view.ts': 'export const title = (): string => document.title; // needs DOM\n',
  'app/tsconfig.json': project(['ES2023']),
  'app/main.ts': "import { title } from '../dom/view';\n\nexport const shown = title();\n",
};

/** The checker, as `workspace-tools.json` names it. */
const useFake = (at = root) => write({ 'workspace-tools.json': JSON.stringify({ types: { compiler: [fake] } }) }, at);

/** The check's exit code, its errors, how many projects it replayed, and which it ran. */
const check = (at = root, extra: ReadonlyArray<string> = []) => {
  writeFileSync(log, '');
  const { status, stdout, stderr } = spawnSync(execPath, [bin, 'types', ...extra], { cwd: at, encoding: 'utf8', env });

  return {
    status,
    errors: stdout.split('\n').filter((line) => line !== ''),
    replayed: Number(/(\d+) replayed/.exec(stderr)?.[1]),
    ran: readFileSync(log, 'utf8').split('\n').filter(Boolean).sort(),
    stderr,
  };
};

beforeEach(() => {
  root = temporary('workspace-types-test-');
  cache = temporary('workspace-types-cache-');
  log = join(temporary('workspace-types-log-'), 'ran.txt');
  env = { ...process.env, WORKSPACE_TYPES_CACHE: cache, FAKE_TSC_LOG: log };
});

afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('the type check, with an injected checker', () => {
  it("passes when each file's errors exist only under another project's options", () => {
    write(workspace);
    useFake();

    const { status, errors, ran } = check();
    assert.deepEqual({ status, errors }, { status: 0, errors: [] });
    assert.deepEqual(ran, ['app/tsconfig.json', 'dom/tsconfig.json']);
  });

  it('takes the checker from --compiler too', () => {
    write(workspace);

    assert.equal(check(root, ['--compiler', fake]).status, 0);
  });

  it('fails on an error in a file under its own options, once, though two projects check it', () => {
    write({
      ...workspace,
      'dom/view.ts': 'export const title = (): string => document.title; // needs DOM\nexport const count = 1; // error: one\n',
      'app/main.ts': "import { title } from '../dom/view';\n\nexport const shown = title(); // error: two\n",
    });
    useFake();

    const { status, errors } = check();
    assert.equal(status, 1);
    assert.deepEqual(errors.sort(), ['app/main.ts(3,1): error TS1: two', 'dom/view.ts(2,1): error TS1: one']);
  });

  it('replays each project nothing changed, and checks again each one an edit reaches', () => {
    write(workspace);
    useFake();

    assert.equal(check().status, 0);
    const second = check();
    assert.deepEqual({ replayed: second.replayed, ran: second.ran }, { replayed: 2, ran: [] });

    // `app`'s program reads `dom/view.ts` too, so the edit reaches both, and its error shows.
    write({ 'dom/view.ts': 'export const title = (): string => document.title; // needs DOM\nexport const n = 1; // error: one\n' });
    const edited = check();
    assert.deepEqual(edited.errors, ['dom/view.ts(2,1): error TS1: one']);
    assert.deepEqual(edited.ran, ['app/tsconfig.json', 'dom/tsconfig.json']);

    // `dom`'s failure isn't kept, so it's checked again. `app`'s pass, whose only error is in
    // `dom`'s file, is kept.
    const again = check();
    assert.equal(again.replayed, 1);
    assert.deepEqual(again.ran, ['dom/tsconfig.json']);

    // Reverting replays both: the first run's results are still kept.
    write({ 'dom/view.ts': workspace['dom/view.ts'] });
    assert.equal(check().replayed, 2);
  });

  it("checks every project again when a project's files are added or renamed", () => {
    write(workspace);
    useFake();
    check();

    write({ 'app/extra.ts': 'export const extra = 1;\n' });
    assert.deepEqual(check().ran, ['app/tsconfig.json', 'dom/tsconfig.json']);

    rmSync(join(root, 'app/extra.ts'));
    write({ 'app/renamed.ts': 'export const extra = 1;\n' });
    assert.deepEqual(check().ran, ['app/tsconfig.json', 'dom/tsconfig.json']);
  });

  it("replays another worktree's results at the same contents, and keeps each branch's", () => {
    write(workspace);
    useFake();
    const other = root;
    assert.equal(check().status, 0);

    root = temporary('workspace-types-test-');
    write(workspace);
    useFake();
    assert.equal(check().replayed, 2);

    write({ 'app/main.ts': "import { title } from '../dom/view';\n\nexport const seen = title();\n" });
    assert.equal(check().replayed, 1);
    assert.equal(check().replayed, 2);

    // The first worktree still replays its own, which the second's didn't replace.
    assert.equal(check(other).replayed, 2);
  });

  it('reports a checker that fails, and keeps nothing from it', () => {
    write(workspace);
    useFake();
    env = { ...env, FAKE_TSC_CRASH: '1' };

    const crashed = check();
    assert.equal(crashed.status, 1);
    assert.match(crashed.stderr, /the checker failed on .*tsconfig.json, exit 3/);
    assert.deepEqual(readdirSync(cache), []);
  });
});

describe('the results folder', () => {
  it('is WORKSPACE_TYPES_CACHE when set, and workspace-types in the user’s cache when not', () => {
    write(workspace);
    useFake();

    assert.equal(check().status, 0);
    assert.equal(readdirSync(cache).length, 2);

    const home = temporary('workspace-types-xdg-');
    env = { ...env, WORKSPACE_TYPES_CACHE: '', XDG_CACHE_HOME: home };

    assert.equal(check().replayed, 0);
    assert.equal(readdirSync(join(home, 'workspace-types')).length, 2);
    assert.equal(check().replayed, 2);
  });
});

/** A `node_modules` holding `typescript`, from the environment or this package's install. */
const installed = (() => {
  const named = process.env['WORKSPACE_TOOLS_NODE_MODULES'];
  const own = fileURLToPath(new URL('../node_modules', import.meta.url));

  return [named, own].find((folder) => folder !== undefined && existsSync(join(folder, 'typescript/package.json')));
})();

describe('the type check, with the repo’s own tsc', { skip: installed === undefined && 'no typescript installed' }, () => {
  const real = {
    ...workspace,
    'dom/view.ts': 'export const title = (): string => document.title;\n',
  };

  it("passes when each file's errors exist only under another project's options, and replays", () => {
    write(real);
    symlinkSync(installed!, join(root, 'node_modules'));

    const first = check();
    assert.deepEqual({ status: first.status, errors: first.errors }, { status: 0, errors: [] });
    assert.equal(check().replayed, 2);
  });

  it('fails on an error in a file under its own options, once, though two projects check it', () => {
    write({
      ...real,
      'dom/view.ts': "export const title = (): string => document.title;\n\nexport const count: number = 'one';\n",
    });
    symlinkSync(installed!, join(root, 'node_modules'));

    const { status, errors } = check();
    assert.equal(status, 1);
    assert.deepEqual(errors, ["dom/view.ts(3,14): error TS2322: Type 'string' is not assignable to type 'number'."]);
  });
});
