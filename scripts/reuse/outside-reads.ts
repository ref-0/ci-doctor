#!/usr/bin/env node
/**
 * outside-reads.ts: the files a Rust component names outside its own folder, read from its source
 * text, so a test can hold every such read inside the pass key (`pass-key.ts`'s `isInput`). A key
 * that misses a read lets a change to that file keep an old pass.
 *
 *     node scripts/reuse/outside-reads.ts [<component folder>] [<allowed folder>...]
 *
 * Prints each read outside the component and the allowed folders as `file:line: path`, and fails
 * when there is one. With no arguments it reads `config` in `pass-key.ts`: the component, and its
 * `outsidePrefixes` as the allowed folders.
 *
 * Runs: as a test in your repo (see README.md), beside the test that keys your real `HEAD`. Node 24
 * and `git` only.
 * Configure: nothing here; the component and the allowed folders come from `pass-key.ts`.
 * Reference implementation from a production monorepo; adapt to your repo.
 *
 * What it finds, in each tracked `.rs` file under the component's `src/` and `tests/`: a quoted
 * relative path (`"../…"`) in an `include_str!`, an `include_bytes!` or a `#[path]`, read from
 * that file's own folder, and one within two lines after `CARGO_MANIFEST_DIR`, read from the
 * component's folder. Those are the reads a compiler or a test resolves from fixed text.
 *
 * What it can't find: a path built at run time (joined from variables, read from the
 * environment, listed from a folder). Declare those in `outsidePrefixes` or `outsideFiles` by
 * hand, and audit the component's other disk reads the same way. For another language, swap the
 * patterns for its compile-time includes and its manifest-relative paths.
 */
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

/** A file's text, by its path from the repo's root. */
export type Read = (path: string) => string;

/**
 * Each read outside `component` and `allowed` that `files`' Rust names, as `file:line: path`.
 * `component` and each of `allowed` are folders from the repo's root, with or without a trailing
 * slash.
 */
export const outsideReads = (
  files: ReadonlyArray<string>,
  read: Read,
  component: string,
  allowed: ReadonlyArray<string>,
) => {
  const root = component.replace(/\/$/, '');
  const inside = [root, ...allowed.map((folder) => folder.replace(/\/$/, ''))];
  const sources = files.filter((path) => path.startsWith(`${root}/src/`) || path.startsWith(`${root}/tests/`));

  return sources
    .filter((path) => path.endsWith('.rs'))
    .flatMap((file) => {
      const lines = read(file).split('\n');

      return lines.flatMap((line, at) => {
        const fromComponent = lines
          .slice(Math.max(0, at - 2), at + 1)
          .join('\n')
          .includes('CARGO_MANIFEST_DIR');
        const fromFile = /include_(str|bytes)!|#\[path/.test(line);
        if (!fromComponent && !fromFile) return [];

        return [...line.matchAll(/"(\/?\.\.\/[^"]*)"/g)].flatMap(([, quoted = '']) => {
          const base = fromFile ? posix.dirname(file) : root;
          const path = posix.normalize(posix.join(base, quoted.replace(/^\//, '')));
          const held = inside.some((folder) => path === folder || path.startsWith(`${folder}/`));

          return held ? [] : [`${file}:${String(at + 1)}: ${path}`];
        });
      });
    });
};

if (argv[1] === fileURLToPath(import.meta.url)) {
  const [named, ...allowedNamed] = argv.slice(2);
  const { config } = named === undefined ? await import('./pass-key.ts') : { config: undefined };
  const component = named ?? config?.component ?? '';
  const allowed = named === undefined ? (config?.outsidePrefixes ?? []) : allowedNamed;
  const files = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .stdout.split('\0')
    .filter((path) => path !== '');
  const found = outsideReads(files, (path) => readFileSync(path, 'utf8'), component, allowed);

  for (const line of found) console.log(line);
  if (found.length > 0) {
    console.error(`outside-reads: ${String(found.length)} reads outside ${component} that the key doesn't hold`);
    exit(1);
  }
}
