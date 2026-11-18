/**
 * The parser `symbols.ts` reads source with: oxc, through whichever of its packages the repo has.
 * Each gives the same ESTree-shaped tree with TypeScript's nodes and `start`/`end` offsets.
 *
 * - `oxc-parser`: oxc's own package, the smallest to add (`npm i -D oxc-parser`).
 * - `rolldown/parseAst`: there already wherever Vite 8 or Rolldown is.
 * - `vite-plus`: its `parseAst`, for Vite+ workspaces.
 *
 * Runs: imported by `symbols.ts`.
 * Configure: nothing. Install one of the three. `WORKSPACE_SYMBOLS_PARSER` names one to use first.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { env } from 'node:process';

/** A program's top-level statements, as far as `symbols.ts` reads them. Its nodes are untyped. */
export interface Program {
  readonly body: ReadonlyArray<any>;
}

export type Lang = 'ts' | 'tsx' | 'jsx';

type Parse = (text: string, lang: Lang, path: string) => Program;

const candidates = ['oxc-parser', 'rolldown/parseAst', 'vite-plus'];

const load = async (): Promise<{ readonly name: string; readonly url: string; readonly parse: Parse }> => {
  const first = env['WORKSPACE_SYMBOLS_PARSER'];
  const order = first === undefined || first === '' ? candidates : [first, ...candidates.filter((name) => name !== first)];

  for (const name of order) {
    const module: any = await import(name).catch(() => undefined);
    if (module === undefined) continue;

    const url = import.meta.resolve(name);

    if (typeof module.parseSync === 'function') {
      // oxc-parser answers its errors rather than throwing them.
      return {
        name,
        url,
        parse: (text, lang, path) => {
          const { program, errors } = module.parseSync(path, text, { lang });
          if (errors.length > 0) throw new Error(errors[0]?.message ?? 'parse error');

          return program;
        },
      };
    }

    if (typeof module.parseAst === 'function') {
      return { name, url, parse: (text, lang, path) => module.parseAst(text, { lang }, path) };
    }
  }

  throw new Error(`symbols: no parser. Install one of ${candidates.join(', ')}.`);
};

/** The parser, and where it's installed, which names its version, for the cache's key. */
export const parser = await load();
