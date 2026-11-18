/**
 * outside-reads.test.ts: tests for finding a Rust component's reads outside its folder. Run with
 * `node --test outside-reads.test.ts`.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { deepStrictEqual } from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isInput, type KeyConfig, config } from './pass-key.ts';
import { outsideReads } from './outside-reads.ts';

const tree = (texts: Record<string, string>) => ({
  files: Object.keys(texts),
  read: (path: string) => texts[path] ?? '',
});

describe('outsideReads', () => {
  test('finds an include from the file and a path after CARGO_MANIFEST_DIR', () => {
    const { files, read } = tree({
      'crates/svc/src/lib.rs': 'const A: &str = include_str!("../../shared/a.json");\n',
      'crates/svc/tests/io.rs': 'let p = Path::new(env!("CARGO_MANIFEST_DIR"))\n  .join("../../fixtures/b.bin");\n',
    });

    deepStrictEqual(outsideReads(files, read, 'crates/svc/', []), [
      'crates/svc/src/lib.rs:1: crates/shared/a.json',
      'crates/svc/tests/io.rs:2: fixtures/b.bin',
    ]);
  });

  test('holds reads inside the component and the allowed folders', () => {
    const { files, read } = tree({
      'crates/svc/src/lib.rs': 'const A: &str = include_str!("../fixtures/a.json");\n',
      'crates/svc/tests/io.rs': 'let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../vectors/b.json");\n',
    });

    deepStrictEqual(outsideReads(files, read, 'crates/svc', ['crates/vectors/']), []);
  });

  test('ignores quoted paths outside an include or a manifest-relative read, and other files', () => {
    const { files, read } = tree({
      'crates/svc/src/lib.rs': 'const URL: &str = "../not/a/read";\n',
      'crates/svc/build/gen.rs': 'include_str!("../../elsewhere.txt");\n',
      'crates/svc/src/notes.md': 'include_str!("../../elsewhere.txt")\n',
    });

    deepStrictEqual(outsideReads(files, read, 'crates/svc/', []), []);
  });

  test("an allowed folder is one the key holds, so a read there moves the key", () => {
    const shape: KeyConfig = { ...config, component: 'crates/svc/', outsidePrefixes: ['crates/vectors/'] };

    deepStrictEqual(isInput('crates/vectors/b.json', shape), true);
    deepStrictEqual(isInput('fixtures/b.bin', shape), false);
  });
});
