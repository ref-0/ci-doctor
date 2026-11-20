/**
 * The imports of one source file, through the parser `symbols` uses: static imports and exports
 * from a module, dynamic `import('…')` with a string, and `import('…').Type` in a type.
 *
 * An import is types-only when nothing loads at run time: `import type`, `export type`, or an
 * import type in a type position. `import { type X }` still loads its module under
 * `verbatimModuleSyntax`, so it counts as a value import.
 *
 * Runs: imported by `command.ts`. Needs one of the parsers `symbols/parser.ts` names.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { parser, type Lang } from '../symbols/parser.ts';
import type { Import } from './graph.ts';

const langOf = (path: string): Lang => (path.endsWith('.tsx') ? 'tsx' : path.endsWith('.jsx') ? 'jsx' : 'ts');

/** The string a node holds, when it's a string literal (or a type of one). */
const literal = (node: any): string | undefined => {
  if (node === null || typeof node !== 'object') return undefined;
  if (typeof node.value === 'string') return node.value;

  return literal(node.literal);
};

/** Each import `text`, the file at `path`, makes. */
export const importsOf = (text: string, path: string): ReadonlyArray<Import> => {
  const program = parser.parse(text, langOf(path), path);
  const starts = [0];
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1);

  const lineAt = (offset: number) => {
    let low = 0;
    let high = starts.length - 1;

    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((starts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }

    return low + 1;
  };

  const found: Array<Import> = [];
  const add = (node: any, source: string | undefined, typesOnly: boolean) => {
    if (source !== undefined) found.push({ source, typesOnly, line: lineAt(node.start ?? 0) });
  };

  const walk = (node: any) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }

    switch (node.type) {
      case 'ImportDeclaration':
        add(node, literal(node.source), node.importKind === 'type');
        break;
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        if (node.source != null) add(node, literal(node.source), node.exportKind === 'type');
        break;
      case 'ImportExpression':
        add(node, literal(node.source), false);
        break;
      case 'TSImportType':
        add(node, literal(node.argument) ?? literal(node.source), true);
        break;
    }

    for (const key of Object.keys(node)) {
      if (key !== 'parent') walk(node[key]);
    }
  };

  walk(program);

  return found;
};
