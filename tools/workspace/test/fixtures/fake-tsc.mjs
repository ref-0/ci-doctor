#!/usr/bin/env node
/**
 * fake-tsc.mjs: a stand-in type checker that keeps the driver's contract, for the type driver's
 * tests, so they run with no TypeScript installed and prove the checker is injectable.
 *
 * - `--project <config> --showConfig` prints `{ files, references }`: every `*.ts` beside the
 *   config, and the config's own references.
 * - `--project <config> ... --listFiles` "checks" the program: the project's files and every file
 *   they import by a relative path. A line holding `needs DOM` is an error unless the project's
 *   `compilerOptions.lib` has `DOM`; a line holding `error:` is always one. It prints each error as
 *   `path(line,col): error TS1: <text>`, from the working folder, then every program file by
 *   absolute path, and exits 2 with errors, 0 without.
 * - Each check appends the project's config path to `$FAKE_TSC_LOG`, when set, and exits 3 with
 *   nothing printed when `$FAKE_TSC_CRASH` is set.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { argv, cwd, env, exit } from 'node:process';

const args = argv.slice(2);
const config = resolve(args[args.indexOf('--project') + 1]);
const folder = dirname(config);
const settings = JSON.parse(readFileSync(config, 'utf8'));
const files =
  settings.files ??
  readdirSync(folder)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => `./${name}`);

if (args.includes('--showConfig')) {
  console.log(JSON.stringify({ files, references: settings.references ?? [] }));
  exit(0);
}

if (env.FAKE_TSC_LOG) appendFileSync(env.FAKE_TSC_LOG, `${relative(cwd(), config)}\n`);

// A checker that crashes: no output, an exit no checker gives for type errors.
if (env.FAKE_TSC_CRASH) exit(3);

const dom = (settings.compilerOptions?.lib ?? []).includes('DOM');
const program = [];
const queue = files.map((file) => resolve(folder, file));

while (queue.length > 0) {
  const file = queue.shift();
  if (program.includes(file)) continue;

  program.push(file);
  const text = readFileSync(file, 'utf8');

  for (const [, specifier] of text.matchAll(/from '(\.[^']*)'/g)) {
    queue.push(resolve(dirname(file), specifier.endsWith('.ts') ? specifier : `${specifier}.ts`));
  }
}

const errors = program.flatMap((file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, at) => {
      const message = /error: (.*)$/.exec(line)?.[1] ?? (line.includes('needs DOM') && !dom ? "Cannot find name 'document'." : undefined);

      return message === undefined ? [] : [`${relative(cwd(), file)}(${at + 1},1): error TS1: ${message}`];
    }),
);

for (const error of errors) console.log(error);

for (const file of program) console.log(join(file));

exit(errors.length > 0 ? 2 : 0);
