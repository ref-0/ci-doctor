/**
 * Finds the functions, classes, consts and types the repo already has, by words in their name,
 * signature, doc comment or path, so you can reuse one instead of writing it again.
 *
 *     workspace-tools symbols find <words...>
 *
 * Prints the ten best matches in the working tree, tests included. A word in the name counts
 * most, then a word in the doc comment, then one in the signature or path, and a symbol that
 * matches every word ranks above one that doesn't.
 *
 * Runs: locally, before writing a function, from the repo's `symbols:find` script.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { repoRoot, type SourceSymbol, symbolCache, workingFiles } from './symbols.ts';

/** `storedCheckCode` or `stored_check_code` as `['stored', 'check', 'code']`. */
const wordsOf = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');

/** `bytes` as `byte`, so it matches `byte` and `bytes` alike. */
const stem = (word: string) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word);

/** How well `symbol` matches one query word, or 0. */
const wordScore = (symbol: SourceSymbol, word: string) => {
  const name = symbol.name.toLowerCase();
  const nameWords = wordsOf(symbol.name);
  if (name === word) return 12;

  if (nameWords.includes(word)) return 6;

  if (nameWords.some((nameWord) => nameWord.startsWith(word))) return 4;

  if (name.includes(word)) return 3;

  if (wordsOf(symbol.doc).some((docWord) => docWord.startsWith(word))) return 2;

  if (symbol.signature.toLowerCase().includes(word)) return 1;

  return symbol.file.toLowerCase().includes(word) ? 0.5 : 0;
};

/** The ten symbols that best match the words in `query`, best first. */
export const best = (symbols: ReadonlyArray<SourceSymbol>, query: ReadonlyArray<string>) => {
  const words = query.flatMap(wordsOf).map(stem);

  return symbols
    .flatMap((symbol) => {
      const scores = words.map((word) => wordScore(symbol, word));
      if (scores.every((score) => score === 0)) return [];

      // An exported symbol is the one to reuse, and a test's helper the last.
      const score =
        scores.reduce<number>((sum, each) => sum + each, 0) +
        (scores.includes(0) ? 0 : 5) +
        (symbol.exported ? 1 : 0) -
        (symbol.test ? 2 : 0);

      return [{ symbol, score }];
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.symbol.name.length - b.symbol.name.length ||
        a.symbol.file.localeCompare(b.symbol.file),
    )
    .slice(0, 10)
    .map(({ symbol }) => symbol);
};

export const findUsage = 'usage: workspace-tools symbols find <words...>';

/** Prints what in the repo `from` is in best matches `query`, and answers the exit code. */
export const symbolsFind = (query: ReadonlyArray<string>, from: string) => {
  if (query.length === 0) {
    console.error(findUsage);

    return 2;
  }

  const root = repoRoot(from);
  const cache = symbolCache(root);
  const found = best(workingFiles(root).flatMap(cache.symbolsOf), query);
  cache.save();

  if (found.length === 0) {
    console.log(`Nothing matches ${query.join(' ')}.`);

    return 0;
  }

  for (const symbol of found) {
    console.log(
      `${symbol.name}  ${symbol.kind}${symbol.exported ? ', exported' : ''}  ${symbol.file}:${symbol.line}`,
    );
    console.log(`  ${symbol.signature}`);

    if (symbol.doc !== '') console.log(`  ${symbol.doc}`);
  }

  return 0;
};
