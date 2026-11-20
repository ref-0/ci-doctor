#!/usr/bin/env node
/**
 * bin.ts: the workspace checks, each a subcommand, run from anywhere in the repo's checkout.
 *
 *     node tools/workspace/src/bin.ts types [--compiler <command>]
 *     node tools/workspace/src/bin.ts symbols find <words...>
 *     node tools/workspace/src/bin.ts symbols check <base> [<head>] | --all
 *     node tools/workspace/src/bin.ts package-exports [--packages <glob>]... [--condition <name>]
 *     node tools/workspace/src/bin.ts package-graph [--unused | --generate]
 *     node tools/workspace/src/bin.ts check [--fix]
 *
 * Runs: from the repo's root scripts, locally and in CI. Node 24 or later, which runs TypeScript
 * without a build.
 * Configure: `workspace-tools.json` at the repo's root (`config.ts`); flags win over it.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { execFileSync } from 'node:child_process';
import { argv, cwd, exit } from 'node:process';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

import { loadConfig } from './config.ts';

/** The root of the Git checkout the command runs in, or where it runs outside one. */
const root = () => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return cwd();
  }
};

const usage = [
  'usage: workspace-tools <command>',
  '  types [--compiler <command>]       every project the root tsconfig reaches, replayed when unchanged',
  '  symbols find <words...>            what the repo has, before you write it again',
  '  symbols check <base> [<head>]      no change copies what the repo has',
  '  symbols check --all                every copy the repo holds',
  '  package-exports [--packages <glob>]... [--condition <name>]',
  "                                     each package's exports name files it has or builds",
  '  package-graph [--unused]          every import keeps to package-graph.json',
  '  package-graph --generate           the graph the imports draw today',
  '  check [--fix]                      types, untyped lint everywhere, typed lint on changed files',
].join('\n');

/** The options in `args`, or undefined when they don't parse. */
const parsed = <const Options extends ParseArgsOptionsConfig>(args: ReadonlyArray<string>, options: Options) => {
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals: false }).values;
  } catch {
    return undefined;
  }
};

const run = async ([name, ...rest]: ReadonlyArray<string>): Promise<number> => {
  const at = root();
  const config = loadConfig(at);

  switch (name) {
    case 'types': {
      const values = parsed(rest, { compiler: { type: 'string' } });
      if (values === undefined) break;

      const { types } = await import('./types/types.ts');
      const compiler = typeof values.compiler === 'string' ? values.compiler : config.types.compiler;

      return types(at, { ...config.types, ...(compiler === undefined ? {} : { compiler }) });
    }
    case 'symbols': {
      const [command, ...words] = rest;
      const { skipAlso } = await import('./symbols/symbols.ts');
      skipAlso(config.symbols.skip);

      if (command === 'find') return (await import('./symbols/find.ts')).symbolsFind(words, cwd());

      if (command === 'check') return (await import('./symbols/check.ts')).symbolsCheck(words, cwd());

      break;
    }
    case 'package-exports': {
      const values = parsed(rest, { packages: { type: 'string', multiple: true }, condition: { type: 'string' } });
      if (values === undefined) break;

      const { packageExports } = await import('./package-exports.ts');
      const packages = Array.isArray(values.packages) ? values.packages.map(String) : config.packageExports.packages;
      const condition = typeof values.condition === 'string' ? values.condition : config.packageExports.condition;

      return packageExports(at, { ...config.packageExports, packages, condition });
    }
    case 'package-graph': {
      const values = parsed(rest, { generate: { type: 'boolean' }, unused: { type: 'boolean' } });
      if (values === undefined) break;

      const { packageGraph } = await import('./graph/command.ts');

      return packageGraph(at, config.packageGraph, { generate: values.generate === true, unused: values.unused === true });
    }
    case 'check': {
      const values = parsed(rest, { fix: { type: 'boolean' } });
      if (values === undefined) break;

      const { runCheck } = await import('./lint/check.ts');
      const { lintConfigured } = await import('./config.ts');
      if (!lintConfigured(at)) {
        console.error(
          'check: workspace-tools.json has no "lint" section. Give it your four lint commands, or wire Vite+ and copy config.lint-vite-plus.example.json\'s.',
        );

        return 2;
      }

      return runCheck(at, config.lint, { fix: values.fix === true });
    }
  }

  console.error(usage);

  return 2;
};

exit(await run(argv.slice(2)));
