/**
 * `symbols check` and `symbols find`, on throwaway Git repos. They need a parser installed (see
 * `src/symbols/parser.ts`), and skip without one.
 *
 *     node --test tools/workspace/test/
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const loaded = await import('../src/symbols/check.ts').then(
  async (check) => ({ check, find: await import('../src/symbols/find.ts'), symbols: await import('../src/symbols/symbols.ts') }),
  (error: Error) => error,
);
const skip = loaded instanceof Error ? `no parser: ${loaded.message}` : false;

const joined = `export const joined = (parts: ReadonlyArray<Uint8Array>) => {
  const all = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let at = 0;

  for (const part of parts) {
    all.set(part, at);
    at += part.byteLength;
  }

  return all;
};
`;

// joined, with every local renamed.
const concat = `const concat = (chunks: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return out;
};
`;

const unrelated = `export const greeting = (name: string) => \`Hello, \${name}.\`;\n`;

const repos: Array<string> = [];

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

const git = (repo: string, args: ReadonlyArray<string>) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
  });

/** Writes each file, or deletes it for `null`. */
const write = (repo: string, files: ReadonlyMap<string, string | null>) => {
  for (const [path, text] of files) {
    if (text === null) rmSync(join(repo, path));
    else {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
  }
};

/** A repo whose `main` holds `base`, with `change` written on top, committed unless asked not to. */
const repoWith = (base: ReadonlyMap<string, string | null>, change: ReadonlyMap<string, string | null>, commit = true) => {
  const repo = mkdtempSync(join(tmpdir(), 'symbols-'));
  repos.push(repo);

  git(repo, ['init', '-q', '-b', 'main']);
  write(repo, base);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);

  git(repo, ['switch', '-q', '-c', 'change']);
  write(repo, change);

  if (commit) {
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'change']);
  }

  return repo;
};

/** The copies a change makes, as `exact` or `near`, then the copy and what it copies. */
const copiesOf = (repo: string, head?: string) => {
  if (loaded instanceof Error) throw loaded;

  const { changedSince, copiesIn } = loaded.check;
  const { symbols, changed } = changedSince(repo, 'main', head);

  return copiesIn(symbols, changed).map(
    (copy) => `${copy.exact ? 'exact' : 'near'}: ${copy.copy.name} ${copy.copy.file}, ${copy.of.map((of) => `${of.name} ${of.file}`).join(', ')}`,
  );
};

const base = new Map([['src/bytes.ts', joined]]);

describe('a change', { skip }, () => {
  const cases = [
    {
      what: 'copies a function with its locals renamed',
      change: new Map([['src/send.ts', concat]]),
      copies: ['exact: concat src/send.ts, joined src/bytes.ts'],
    },
    {
      what: 'copies a function but reads other names from outside it',
      change: new Map([['src/send.ts', concat.replaceAll('Uint8Array', 'Uint16Array')]]),
      copies: ['near: concat src/send.ts, joined src/bytes.ts'],
    },
    {
      what: 'copies a function and says why in a CLONE comment',
      change: new Map([['src/send.ts', `// CLONE: the sender's bundle takes no code from bytes.ts.\n${concat}`]]),
      copies: [],
    },
    {
      what: 'moves a function to another file',
      change: new Map([
        ['src/bytes.ts', unrelated],
        ['src/send.ts', concat],
      ]),
      copies: [],
    },
    {
      what: 'edits a file that already held a copy, but not the copy',
      change: new Map([['src/old.ts', `${concat}\n${unrelated}`]]),
      copies: [],
      before: new Map([...base, ['src/old.ts', concat]]),
    },
  ];

  for (const { what, change, copies, before } of cases) {
    it(`that ${what}`, () => {
      const repo = repoWith(before ?? base, change);

      assert.deepEqual(copiesOf(repo, 'HEAD'), copies);
    });
  }

  it('finds a copy in a new file in the working tree, not yet committed', () => {
    const repo = repoWith(base, new Map([['src/send.ts', concat]]), false);

    assert.deepEqual(copiesOf(repo), ['exact: concat src/send.ts, joined src/bytes.ts']);
  });

  it('leaves out a path symbols.skip names', () => {
    if (loaded instanceof Error) throw loaded;

    const repo = repoWith(base, new Map([['vendor/send.ts', concat]]));
    loaded.symbols.skipAlso(['^vendor/']);

    assert.deepEqual(copiesOf(repo, 'HEAD'), []);
  });
});

describe('the declarations it keeps', { skip }, () => {
  it('keeps them in the checkout, under its own cache folder', () => {
    const repo = repoWith(base, new Map([['src/send.ts', concat]]));

    copiesOf(repo, 'HEAD');

    assert.equal(existsSync(join(repo, 'node_modules/.cache/workspace-symbols/symbols.bin')), true);
  });
});

describe('find', { skip }, () => {
  it('ranks a word in the name above one in the doc comment, and leaves out what matches nothing', () => {
    if (loaded instanceof Error) throw loaded;

    const repo = repoWith(
      new Map([
        ['src/bytes.ts', `/** Joins byte chunks. */\n${joined}`],
        ['src/text.ts', '/** The bytes of a greeting. */\nexport const greet = (name: string) => `Hi ${name}`;\n'],
        ['src/other.ts', 'export const unrelatedThing = 1;\n'],
      ]),
      new Map(),
    );
    const { symbolsOf } = loaded.symbols.symbolCache(repo);
    const found = loaded.find.best(loaded.symbols.workingFiles(repo).flatMap(symbolsOf), ['join', 'bytes']);

    assert.deepEqual(
      found.map(({ name }) => name),
      ['joined', 'greet'],
    );
  });
});
