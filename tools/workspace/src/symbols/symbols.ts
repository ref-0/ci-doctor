/**
 * The functions, classes, consts and types declared at the top level of the repo's source files,
 * each with a fingerprint of its body, for `check.ts` and `find.ts`.
 *
 * A fingerprint lists a body's syntax nodes in order: each node's type, each literal as written,
 * and each name. Names the body declares, its parameters and locals, become numbered
 * placeholders, so a copy with its locals renamed has the same fingerprint. Names it reads from
 * outside, such as the functions it calls and the properties it reads, stay as written, so
 * `x => foo(x)` and `x => bar(x)` differ. Types, comments and whitespace aren't in it.
 *
 * A looser fingerprint, for near copies, writes every name but a property's as `$`. Its runs of
 * five tokens make the set `check.ts` compares.
 *
 * `symbolCache` keeps each file's declarations by its path and text, so a run parses only the
 * files that changed since the last. Callers list the files, and compare, fresh each run.
 *
 * Runs: imported by `find.ts` and `check.ts`.
 * Configure: `symbols.skip` in `workspace-tools.json`, for paths beyond those `skipped` leaves out.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pid } from 'node:process';
import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';

import { type Lang, parser, type Program } from './parser.ts';

type Statement = Program['body'][number];

export type SymbolKind = 'function' | 'class' | 'const' | 'type';

/** A declaration at the top level of a file. */
export interface SourceSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly file: string;
  readonly line: number;
  readonly exported: boolean;
  /** In a test file, which `check.ts` leaves out. */
  readonly test: boolean;
  /** Its parameters and return type as written, or a class's or const's first line. */
  readonly signature: string;
  /** The first line of its doc comment, or an empty string. */
  readonly doc: string;
  /** The reason in a `// CLONE:` comment above it, which allows a copy. */
  readonly clone: string | undefined;
  /** The nodes in its body. */
  readonly size: number;
  /** Its fingerprint, hashed. */
  readonly hash: string;
  /** Hashes of the runs of five tokens in its looser fingerprint, a repeat counted apart, sorted. */
  readonly runs: Uint32Array;
}

/** A file's path from the repo's root, and its text. */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

const sourceFile = /\.(?:[cm]?[jt]s|[jt]sx)$/;

// Files that hold no code of the repo's own: declarations, what a tool generates or builds, and
// agents' material. Add your repo's vendored or generated paths with `symbols.skip`.
const skipped = [
  /\.d\.[cm]?ts$/,
  /\.gen\.ts$/,
  /(?:^|\/)(?:dist|node_modules)\//,
  /^\.(?:agents|claude)\//,
];

const extraSkipped: Array<RegExp> = [];

/** Leaves out paths each of `patterns`, regular expressions, matches. */
export const skipAlso = (patterns: ReadonlyArray<string>) => {
  extraSkipped.push(...patterns.map((pattern) => new RegExp(pattern)));
};

/** Whether the index reads the file at `path`. */
export const indexed = (path: string) =>
  sourceFile.test(path) && ![...skipped, ...extraSkipped].some((pattern) => pattern.test(path));

export const git = (root: string, args: ReadonlyArray<string>, input?: string) =>
  execFileSync('git', args, { cwd: root, input, maxBuffer: 1024 * 1024 * 1024 });

/** The root of the git repo `from` is in. */
export const repoRoot = (from: string) =>
  git(from, ['rev-parse', '--show-toplevel']).toString('utf8').trim();

const paths = (output: Buffer) =>
  output
    .toString('utf8')
    .split('\0')
    .filter((path) => path !== '' && indexed(path));

/** Each file the index reads in the working tree: tracked, or new and not ignored. */
export const workingFiles = (root: string): ReadonlyArray<SourceFile> =>
  paths(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
    .filter((path) => existsSync(join(root, path)))
    .map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));

/** Each of `wanted` at `commit`, or each file the index reads there; a missing one is left out. */
export const filesAt = (root: string, commit: string, wanted?: ReadonlyArray<string>) => {
  const listed = wanted ?? paths(git(root, ['ls-tree', '-r', '-z', '--name-only', commit]));
  if (listed.length === 0) return [];

  const output = git(
    root,
    ['cat-file', '--batch'],
    listed.map((path) => `${commit}:${path}\n`).join(''),
  );
  const files: Array<SourceFile> = [];
  let at = 0;

  for (const path of listed) {
    const headerEnd = output.indexOf(10, at);
    const header = output.toString('utf8', at, headerEnd);
    at = headerEnd + 1;

    if (header.endsWith(' missing')) continue;

    const size = Number(header.split(' ')[2]);
    files.push({ path, text: output.toString('utf8', at, at + size) });
    at += size + 1;
  }

  return files;
};

/** A node of oxc's syntax tree, as far as a fingerprint reads one. */
interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

const isNode = (value: unknown): value is AstNode =>
  value instanceof Object && 'type' in value && 'start' in value && 'end' in value;

/** An identifier's name, or an empty string for a node without one. */
const nameOf = (node: AstNode) => ('name' in node ? String(node.name) : '');

// Type annotations, which a fingerprint leaves out.
const typeFields = new Set([
  'typeAnnotation',
  'returnType',
  'typeParameters',
  'typeArguments',
  'superTypeArguments',
  'implements',
]);

/** Each node directly under `node`, with the field that holds it, types left out. */
const childrenOf = (node: AstNode) =>
  Object.entries(node).flatMap(([field, value]): ReadonlyArray<readonly [string, AstNode]> => {
    if (typeFields.has(field)) return [];

    if (Array.isArray(value)) return value.filter(isNode).map((child) => [field, child] as const);

    return isNode(value) ? [[field, value]] : [];
  });

const functionTypes = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/** The names a binding pattern declares, such as `{ a, b: [c] }`, into `names`. */
const addBindings = (pattern: AstNode, names: Set<string>) => {
  if (pattern.type === 'Identifier') {
    names.add(nameOf(pattern));

    return;
  }

  for (const [field, child] of childrenOf(pattern)) {
    if (pattern.type === 'Property' && field !== 'value') continue;

    if (pattern.type === 'AssignmentPattern' && field !== 'left') continue;

    addBindings(child, names);
  }
};

/** Every name declared anywhere in `node`: parameters, variables, functions, classes, catches. */
const declaredIn = (node: AstNode, names: Set<string>) => {
  for (const [field, child] of childrenOf(node)) {
    const binds =
      (functionTypes.has(node.type) && (field === 'params' || field === 'id')) ||
      (node.type === 'VariableDeclarator' && field === 'id') ||
      (node.type === 'CatchClause' && field === 'param') ||
      ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && field === 'id');
    if (binds) addBindings(child, names);

    declaredIn(child, names);
  }

  return names;
};

const keyedTypes = new Set([
  'Property',
  'MethodDefinition',
  'PropertyDefinition',
  'AccessorProperty',
  'TSPropertySignature',
]);

/** Whether `field` of `parent` names a property, as `b` does in `a.b` and `{ b: 1 }`. */
const namesProperty = (parent: AstNode, field: string) =>
  !('computed' in parent && parent.computed === true) &&
  ((parent.type === 'MemberExpression' && field === 'property') ||
    (keyedTypes.has(parent.type) && field === 'key'));

// TypeScript's wrappers around an expression: `x as T`, `x satisfies T`, `x!`, `<T>x`, `f<T>`.
const wrapperFields = new Set(['expression', 'parameter']);

/** A body's fingerprint and its looser one, token by token, and its count of nodes. */
const fingerprint = (body: AstNode, text: string, own: string | undefined) => {
  const declared = declaredIn(body, new Set(own === undefined ? [] : [own]));
  const placeholders = new Map<string, number>();
  const strict: Array<string> = [];
  const loose: Array<string> = [];
  let size = 0;

  const emit = (strictToken: string, looseToken = strictToken) => {
    strict.push(strictToken);
    loose.push(looseToken);
  };

  const walk = (node: AstNode, parent: AstNode | undefined, field: string) => {
    if (node.type.startsWith('TS')) {
      for (const [childField, child] of childrenOf(node)) {
        if (wrapperFields.has(childField)) walk(child, node, childField);
      }

      return;
    }

    size += 1;
    emit(node.type);

    if (node.type === 'Identifier' || node.type === 'PrivateIdentifier') {
      const name = nameOf(node);
      if (parent !== undefined && namesProperty(parent, field)) emit(`.${name}`);
      else if (declared.has(name)) {
        if (!placeholders.has(name)) placeholders.set(name, placeholders.size);
        emit(`$${placeholders.get(name)}`, '$');
      } else emit(name, '$');

      return;
    }

    if (node.type === 'JSXIdentifier') emit(nameOf(node));
    else if (node.type === 'Literal' || node.type === 'TemplateElement') {
      emit(text.slice(node.start, node.end));
    } else if (node.type === 'JSXText') {
      const words = text.slice(node.start, node.end).replace(/\s+/g, ' ').trim();
      if (words !== '') emit(words);
    }

    for (const [childField, child] of childrenOf(node)) walk(child, node, childField);
  };

  walk(body, undefined, '');

  return { strict, loose, size };
};

/** FNV-1a, 32 bits, of `text`. */
const fnv = (text: string) => {
  let hash = 0x811c9dc5;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
};

const runLength = 5;

/**
 * The hashes of each run of `runLength` tokens, sorted. A run that repeats is hashed with its
 * count so far, so a list of 40 names isn't as alike as one of 14. A body that's mostly one run
 * repeated, such as a long list of names, has none: it would be like any list as long.
 */
const runsOf = (tokens: ReadonlyArray<string>) => {
  const seen = new Map<string, number>();
  const hashes: Array<number> = [];

  for (let index = 0; index + runLength <= Math.max(tokens.length, runLength); index += 1) {
    const run = tokens.slice(index, index + runLength).join('\u0001');
    const times = seen.get(run) ?? 0;

    seen.set(run, times + 1);
    hashes.push(fnv(`${run}\u0002${times}`));
  }

  return seen.size < hashes.length / 2
    ? new Uint32Array()
    : Uint32Array.from(new Set(hashes)).sort();
};

/** The comment lines straight above `start`, top first, each trimmed. */
const commentAbove = (text: string, start: number) => {
  const lines: Array<string> = [];
  let end = text.lastIndexOf('\n', start - 1);

  while (end > 0) {
    const begin = text.lastIndexOf('\n', end - 1) + 1;
    const line = text.slice(begin, end).trim();
    if (!/^(?:\/\/|\/\*|\*)/.test(line)) break;

    lines.unshift(line);
    end = begin - 1;
  }

  return lines;
};

/** The first line of the doc comment in `comment`, if it has one. */
const docOf = (comment: ReadonlyArray<string>) => {
  const opening = comment.map((line) => line.startsWith('/**')).lastIndexOf(true);
  if (opening === -1) return '';

  const lines = comment.slice(opening).map((line) =>
    line
      .replace(/^\/\*\*|\*\/$/g, '')
      .replace(/^\*\s?/, '')
      .trim(),
  );

  return lines.find((line) => line !== '') ?? '';
};

/** The reason a `// CLONE:` comment in `comment` gives, if it has one. */
const cloneReason = (comment: ReadonlyArray<string>) => {
  for (const line of comment) {
    const reason = /\bCLONE:\s*(\S.*)$/.exec(line)?.[1]?.replace(/\s*\*\/$/, '');
    if (reason !== undefined && reason !== '') return reason;
  }

  return undefined;
};

const oneLine = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();

  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
};

const langOf = (path: string): Lang => {
  if (path.endsWith('.tsx')) return 'tsx';

  return /\.[cm]?ts$/.test(path) ? 'ts' : 'jsx';
};

/** A top-level declaration found in a statement, before it's measured. */
interface Declared {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly body: AstNode;
  /** Where the signature ends: a function's body, or a class's. */
  readonly signatureEnd: number;
}

/** The declarations a top-level statement makes. */
const declarationsOf = (statement: Statement): ReadonlyArray<Declared> => {
  const declaration =
    statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration'
      ? statement.declaration
      : statement;
  if (declaration === null) return [];

  switch (declaration.type) {
    case 'FunctionDeclaration':
      return declaration.body === null
        ? []
        : [
            {
              name: declaration.id?.name ?? 'default',
              kind: 'function',
              body: declaration,
              signatureEnd: declaration.body.start,
            },
          ];
    case 'ClassDeclaration':
      return [
        {
          name: declaration.id?.name ?? 'default',
          kind: 'class',
          body: declaration,
          signatureEnd: declaration.body.start,
        },
      ];
    case 'TSTypeAliasDeclaration':
    case 'TSInterfaceDeclaration':
      return [
        {
          name: declaration.id.name,
          kind: 'type',
          body: declaration,
          signatureEnd: declaration.end,
        },
      ];
    case 'VariableDeclaration':
      return declaration.declarations.flatMap((declarator: any): ReadonlyArray<Declared> => {
        const init = declarator.init;
        if (declarator.id.type !== 'Identifier' || init === null) return [];

        const callable =
          init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression';

        return [
          {
            name: declarator.id.name,
            kind: callable ? 'function' : 'const',
            body: init,
            signatureEnd: callable ? (init.body?.start ?? init.end) : init.end,
          },
        ];
      });
    default:
      return [];
  }
};

/** Where each line of `text` starts. */
const lineStarts = (text: string) => {
  const starts = [0];

  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1);

  return starts;
};

/** The line, from 1, of offset `at`. */
const lineOf = (starts: ReadonlyArray<number>, at: number) => {
  let low = 0;
  let high = starts.length - 1;

  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] ?? 0) <= at) low = middle;
    else high = middle - 1;
  }

  return low + 1;
};

/** The top-level declarations in one file, or undefined when it doesn't parse. */
const parsed = (file: SourceFile): ReadonlyArray<SourceSymbol> | undefined => {
  let program: Program;

  try {
    program = parser.parse(file.text, langOf(file.path), file.path);
  } catch {
    console.error(`symbols: ${file.path} doesn't parse, so it's left out`);

    return undefined;
  }

  const starts = lineStarts(file.text);
  const test = /\.test\.[cm]?[jt]sx?$/.test(file.path);

  return program.body.flatMap((statement) => {
    const exported =
      statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration';
    const comment = commentAbove(file.text, statement.start);

    return declarationsOf(statement).map((declared): SourceSymbol => {
      const { strict, loose, size } = fingerprint(declared.body, file.text, declared.name);
      const written = file.text.slice(declared.body.start, declared.signatureEnd);
      const signature = declared.kind === 'function' ? written : (written.split('\n', 1)[0] ?? '');

      return {
        name: declared.name,
        kind: declared.kind,
        file: file.path,
        line: lineOf(starts, declared.body.start),
        exported,
        test,
        signature: oneLine(signature),
        doc: docOf(comment),
        clone: cloneReason(comment),
        size,
        hash: createHash('sha1').update(strict.join('\u0001')).digest('hex').slice(0, 16),
        runs: runsOf(loose),
      };
    });
  });
};

// What makes a file's declarations beside its path and text: this file, which fingerprints them,
// and the parser's package, by where it's installed, which names its version and so its parser's.
// A kept file another V8 can't read back reads as none.
const version = createHash('sha256')
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .update(`\0${parser.url}`)
  .digest('hex');

type Kept = Map<string, ReadonlyArray<SourceSymbol>>;

const isKept = (value: unknown): value is readonly [string, Kept] =>
  Array.isArray(value) && value[0] === version && value[1] instanceof Map;

/**
 * Each file's declarations, kept per checkout in `node_modules/.cache/workspace-symbols/`, so a
 * file isn't parsed again until its path, its text or what makes declarations from them changes.
 * Only declarations are kept: callers list the files and compare their declarations each run. A
 * file that doesn't parse isn't kept, so it's reported each time. `save` keeps the files this run
 * read.
 */
export const symbolCache = (root: string) => {
  const path = join(root, 'node_modules/.cache/workspace-symbols/symbols.bin');
  const kept: Kept = (() => {
    try {
      const value: unknown = deserialize(readFileSync(path));

      return isKept(value) ? value[1] : new Map();
    } catch {
      return new Map();
    }
  })();
  const read: Kept = new Map();
  let parsedAny = false;

  /** The top-level declarations in one file. A file that doesn't parse has none. */
  const symbolsOf = (file: SourceFile): ReadonlyArray<SourceSymbol> => {
    const key = createHash('sha1').update(`${file.path}\0`).update(file.text).digest('hex');
    const known = read.get(key) ?? kept.get(key);

    if (known !== undefined) {
      read.set(key, known);

      return known;
    }

    const symbols = parsed(file);
    if (symbols === undefined) return [];

    parsedAny = true;
    read.set(key, symbols);

    return symbols;
  };

  /** Keeps the declarations of the files this run read, when they aren't what's kept already. */
  const save = () => {
    if (!parsedAny && read.size === kept.size) return;

    const temporary = `${path}.${pid}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, serialize([version, read]));
    renameSync(temporary, path);
  };

  return { symbolsOf, save };
};

/** How alike two sets of runs are: what they share over what either has, from 0 to 1. */
export const likeness = (a: Uint32Array, b: Uint32Array) => {
  let shared = 0;
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    const x = a[i] ?? 0;
    const y = b[j] ?? 0;

    if (x === y) {
      shared += 1;
      i += 1;
      j += 1;
    } else if (x < y) i += 1;
    else j += 1;
  }

  return shared / (a.length + b.length - shared);
};
