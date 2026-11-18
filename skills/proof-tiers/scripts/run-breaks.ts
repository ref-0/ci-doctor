#!/usr/bin/env node
/**
 * Each registered break: one credible change to the code a property or model covers, which its test
 * must catch. Applies it, runs the covering test, reports, and puts the code back.
 *
 *   node skills/proof-tiers/scripts/run-breaks.ts [--config <breaks.json>] [words...]
 *
 * With no words it runs every break; with words, the breaks whose names hold one. Results, one line each:
 *
 *   CAUGHT    the test failed, and its output matched the break's `expect`, when it names one
 *   UNCLEAR   the test failed, but not with `expect`: a startup or harness failure isn't a catch
 *   HUNG      the test ran past its timeout. Not a catch by itself: count it only with evidence the
 *             property ran the broken code and caught its liveness failure (a bounded deadline, say)
 *   MISSED    the test passed on broken code: the property needs work, or the break isn't credible
 *   SKIP      the code to break isn't in the file exactly once: the break list needs updating
 *
 * Runs: by hand after a change to covered code, or in a CI job of its own (the cheap tier), on a
 * clean checkout. It refuses a dirty working tree: run it in a disposable checkout or worktree, and
 * commit first, since it puts each file back with `git checkout`. Keep remote cache writes off and the test command
 * uncached with retries off (`command` below), so a replayed pass or a retry can't hide a catch.
 * Needs: Node 24, `git`.
 * Tests: `node --test run-breaks.test.ts`, from this folder.
 * Configure: a breaks file, `breaks.json` beside this script by default (see breaks.example.json):
 *
 *   {
 *     "command": ["pnpm", "exec", "vitest", "run", "--no-cache", "--retry=0", "{test}"],
 *     "timeout": 120,
 *     "breaks": [
 *       {"name": "...", "path": "src/x.ts", "old": "exact text", "new": "broken text",
 *        "test": "src/x.fuzz.test.ts", "expect": "optional regex the failing output must match"}
 *     ]
 *   }
 *
 * `{test}` in the command is replaced by each break's `test`. A break may give its own `command` and
 * `timeout`, for a test another runner runs (`cargo test`, say). An empty `breaks` list does nothing.
 * `expect` is a JavaScript regular expression. For a Python test, run it with `python -B`: a break the
 * same length as the code it replaces, written within the same second, can otherwise load the previous
 * run's stale bytecode and pass or fail wrongly.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process, { argv, cwd as processCwd, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const ANSI = /\x1b\[[0-9;]*m/g;

export type Break = {
  name: string;
  path: string;
  old: string;
  new: string;
  test: string;
  expect?: string;
  command?: string[];
  timeout?: number;
};
export type Config = { command?: string[]; timeout?: number; breaks: Break[] };
export type Result = 'CAUGHT' | 'UNCLEAR' | 'HUNG' | 'MISSED' | 'SKIP';

/** A refusal: the message goes to stderr and the run exits 1. */
export class Stop extends Error {}

const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export function load(path: string): Config {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(config?.breaks)) throw new Stop(`run-breaks: ${path} needs a \`breaks\` list`);
  for (const b of config.breaks) {
    const missing = ['name', 'path', 'old', 'new', 'test'].filter((k) => typeof b?.[k] !== 'string');
    if (missing.length) throw new Stop(`run-breaks: break ${JSON.stringify(b?.name ?? '?')} lacks ${missing.join(', ')}`);
    if (!(b.command?.length || config.command?.length)) {
      throw new Stop(`run-breaks: break ${JSON.stringify(b.name)} has no command, and the file gives none`);
    }
  }
  return config as Config;
}

/** The result for one break, from how its test ended. */
export function verdict(code: number | null, output: string, expect: string | undefined, hung: boolean): Exclude<Result, 'SKIP'> {
  if (hung) return 'HUNG';
  if (code === 0) return 'MISSED';
  if (expect && !new RegExp(expect).test(output)) return 'UNCLEAR';
  return 'CAUGHT';
}

/** Runs a command in its own process group, merging stdout and stderr; kills the group past `limit` seconds. */
function runTest(root: string, command: readonly string[], limit: number): Promise<{ code: number | null; output: string; hung: boolean }> {
  return new Promise((done, fail) => {
    const [program = '', ...args] = command;
    // Its own process group, so a test that hangs is stopped with every worker it started.
    const child = spawn(program, args, { cwd: root, stdio: ['inherit', 'pipe', 'pipe'], detached: true });
    const chunks: Buffer[] = [];
    let hung = false;
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    const timer = setTimeout(() => {
      hung = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // It ended as the timer fired.
      }
    }, limit * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, output: Buffer.concat(chunks).toString('utf8'), hung });
    });
  });
}

export async function runOne(root: string, config: Config, b: Break): Promise<[Result, string]> {
  const full = join(root, b.path);
  // Line endings to \n, as the code to break and its replacement are written in the breaks file.
  const text = readFileSync(full, 'utf8').replace(/\r\n?/g, '\n');
  if (text.split(b.old).length - 1 !== 1) return ['SKIP', 'the code to break is not there once'];

  const command = (b.command?.length ? b.command : config.command ?? []).map((word) => word.replaceAll('{test}', () => b.test));
  const limit = b.timeout || config.timeout || 120;
  writeFileSync(full, text.replace(b.old, () => b.new));
  try {
    const ended = await runTest(root, command, limit);
    const out = ended.output.replace(ANSI, '');
    const result = verdict(ended.code, out, b.expect, ended.hung);
    const failing = out.split(/\r\n|\r|\n/).map((line) => line.trim())
      .filter((line) => ['×', 'FAIL', '✖', 'not ok'].some((start) => line.startsWith(start)) || line.endsWith('FAILED'));
    const detail = failing.slice(0, 2).map((line) => [...line].slice(0, 120).join('')).join('; ');
    return [result, detail || (ended.hung ? `past ${limit} s` : '')];
  } finally {
    git(root, 'checkout', '--', b.path);
  }
}

const USAGE = 'usage: run-breaks.ts [--config <breaks.json>] [<word>...]';

export async function main(args: readonly string[], cwd = processCwd()): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { help: { type: 'boolean', short: 'h' }, config: { type: 'string', default: join(HERE, 'breaks.json') } },
    });
  } catch (error) {
    stderr.write(`run-breaks.ts: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals: words } = parsed;
  if (values.help) {
    stdout.write(`Applies each registered break, runs its covering test, reports, and puts the code back.\n\n${USAGE}\n\n`
      + '  <word>                   run only the breaks whose names hold one of these\n'
      + '  --config <breaks.json>   the breaks file (default: breaks.json beside this script)\n'
      + '  -h, --help               print this help\n');
    return 0;
  }

  const root = git(cwd, 'rev-parse', '--show-toplevel').trim();
  const config = load(resolve(cwd, values.config));
  if (git(root, 'status', '--porcelain', '--untracked-files=no').trim()) {
    throw new Stop('run-breaks: commit or stash first: each break is put back with `git checkout`');
  }

  const counts = new Map<string, number>();
  for (const b of config.breaks) {
    if (words.length && !words.some((word) => b.name.includes(word))) continue;
    const [result, detail] = await runOne(root, config, b);
    counts.set(result, (counts.get(result) ?? 0) + 1);
    stdout.write(`${result.padEnd(8)}  ${b.name}  (${b.test})${detail ? `: ${detail}` : ''}\n`);
  }

  const summary = [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${n} ${k.toLowerCase()}`);
  stdout.write(`${summary.join(', ') || 'no breaks ran'}\n`);
  const left = git(root, 'status', '--porcelain', '--untracked-files=no').trim();
  if (left) {
    stderr.write(`run-breaks: the tree isn't clean after the run:\n${left}\n`);
    return 1;
  }
  return counts.get('MISSED') || counts.get('UNCLEAR') ? 1 : 0;
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(argv.slice(2));
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
