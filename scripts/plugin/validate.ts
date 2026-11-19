#!/usr/bin/env node
/**
 * Fails when the plugin's manifests disagree, or when a skill wouldn't load as one skill in every
 * harness the plugin ships for.
 *
 *     node scripts/plugin/validate.ts [--harnesses]
 *
 * - `plugin.json` at the root is the source of truth: the Claude Code, Codex and Cursor manifests
 *   repeat its name, version, description and keywords, and each marketplace lists the plugin.
 * - Every folder in `skills/` is a skill: a `SKILL.md` whose frontmatter `name` is the folder's
 *   name, a description of at most 320 characters, and at most 10 KB in all.
 * - No other file under `skills/` is named `SKILL.md`. Codex registers one at any depth as a
 *   skill of its own, so a hub's topic named that would load beside the hub.
 * - The README installs the plugin in each harness and names every skill.
 * - `--harnesses` also runs each harness's own check, where one exists and its CLI is on `PATH`:
 *   `claude plugin validate` on the root and on `.claude-plugin/plugin.json`. Codex and Cursor
 *   have no validate command.
 *
 * Runs: from the repo's root, in the build checks (`scripts/check.ts`) and after changing a
 * manifest or a skill's folder. Node 24 only.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { argv, cwd } from 'node:process';
import { fileURLToPath } from 'node:url';

import { installText } from '../../scorer/src/install-steps.ts';

/** The marketplace the plugin is listed in, as `ci-doctor@ref0`. */
export const MARKETPLACE = 'ref0';
export const REPOSITORY = 'https://github.com/ref-0/ci-doctor';

/** The README lines each install route needs. */
export const INSTALL_LINES = [
  `claude plugin marketplace add ref-0/ci-doctor`,
  `claude plugin install ci-doctor@${MARKETPLACE}`,
  'Start a new session',
  'reload-plugins',
  `codex plugin marketplace add ref-0/ci-doctor`,
  `codex plugin add ci-doctor@${MARKETPLACE}`,
  'Start a new Codex session after installing',
  'chat.plugins.enabled',
  'Chat: Install Plugin From Source',
  'From GitHub Repository',
  `npx skills add ${REPOSITORY}`,
  'Select your agent when it asks',
  'newest release tag',
];

type Json = Record<string, unknown>;

const json = (root: string, path: string, problems: string[]): Json => {
  const full = join(root, path);
  if (!existsSync(full)) {
    problems.push(`${path}: missing`);
    return {};
  }
  try {
    return JSON.parse(readFileSync(full, 'utf8')) as Json;
  } catch (error) {
    problems.push(`${path}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A `SKILL.md`'s frontmatter `name` and `description`, as one line each. */
export const frontmatter = (text: string): { name?: string; description?: string } => {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
  if (block === undefined) return {};
  const field = (key: string) => {
    const raw = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(block)?.[1]?.trim();
    if (raw === undefined) return undefined;
    return /^".*"$/.test(raw) ? (JSON.parse(raw) as string) : raw.replace(/^'(.*)'$/, '$1');
  };
  return { name: field('name'), description: field('description') };
};

/** Every file named `SKILL.md` under a folder. */
const skillFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return skillFiles(full);
    return entry.name === 'SKILL.md' ? [full] : [];
  });

/** The skills' folder names, sorted. */
export const skillNames = (root: string) =>
  readdirSync(join(root, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

/** Every problem with the plugin's packaging under `root`, as a message. */
export const validate = (root: string): string[] => {
  const problems: string[] = [];
  const portable = json(root, 'plugin.json', problems);
  const manifests: [string, Json][] = [
    ['.claude-plugin/plugin.json', json(root, '.claude-plugin/plugin.json', problems)],
    ['.codex-plugin/plugin.json', json(root, '.codex-plugin/plugin.json', problems)],
    ['.cursor-plugin/plugin.json', json(root, '.cursor-plugin/plugin.json', problems)],
  ];

  if (portable.name !== 'ci-doctor') problems.push(`plugin.json: name is ${String(portable.name)}, not ci-doctor`);
  if (portable.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') problems.push('plugin.json: must declare the Agent Plugins 1.0 schema');
  if (typeof portable.description !== 'string' || portable.description.length === 0) problems.push('plugin.json: no description');
  for (const [path, manifest] of manifests) {
    for (const key of ['name', 'version', 'description', 'keywords', 'license', 'repository']) {
      if (!same(manifest[key], portable[key])) problems.push(`${path}: ${key} differs from plugin.json's`);
    }
  }

  const codex = manifests[1]?.[1] ?? {};
  if (codex.skills !== './skills/') problems.push('.codex-plugin/plugin.json: skills must be ./skills/');
  const iface = (codex.interface ?? {}) as Json;
  for (const key of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category', 'capabilities', 'defaultPrompt']) {
    if (!iface[key]) problems.push(`.codex-plugin/plugin.json: interface.${key} missing`);
  }
  if (typeof iface.shortDescription === 'string' && iface.shortDescription.length > 30) problems.push('.codex-plugin/plugin.json: interface.shortDescription over 30 characters');
  // OpenAI's manifest reference: up to three starter prompts, at most 128 characters each, unique.
  const prompts = Array.isArray(iface.defaultPrompt) ? iface.defaultPrompt : [iface.defaultPrompt];
  if (prompts.length > 3) problems.push(`.codex-plugin/plugin.json: interface.defaultPrompt has ${prompts.length} prompts, over 3`);
  for (const prompt of prompts) if (typeof prompt !== 'string' || prompt.length > 128) problems.push(`.codex-plugin/plugin.json: interface.defaultPrompt "${String(prompt)}" must be a string of at most 128 characters`);
  if (new Set(prompts).size !== prompts.length) problems.push('.codex-plugin/plugin.json: interface.defaultPrompt repeats a prompt');
  for (const key of ['composerIcon', 'logo']) {
    const path = iface[key];
    if (typeof path !== 'string' || !path.startsWith('./') || !existsSync(join(root, path))) problems.push(`.codex-plugin/plugin.json: interface.${key} must be an existing ./ path`);
  }
  const cursorLogo = manifests[2]?.[1].logo;
  if (typeof cursorLogo !== 'string' || !existsSync(join(root, cursorLogo))) problems.push('.cursor-plugin/plugin.json: logo must be an existing path');

  const listing = (path: string, marketplace: Json) => {
    if (marketplace.name !== MARKETPLACE) problems.push(`${path}: name must be ${MARKETPLACE}`);
    const entry = (Array.isArray(marketplace.plugins) ? marketplace.plugins : []).find((p: Json) => p.name === 'ci-doctor') as Json | undefined;
    if (!entry) problems.push(`${path}: doesn't list ci-doctor`);
    return entry ?? {};
  };
  const claudeEntry = listing('.claude-plugin/marketplace.json', json(root, '.claude-plugin/marketplace.json', problems));
  const cursorEntry = listing('.cursor-plugin/marketplace.json', json(root, '.cursor-plugin/marketplace.json', problems));
  const codexEntry = listing('.agents/plugins/marketplace.json', json(root, '.agents/plugins/marketplace.json', problems));
  for (const [path, entry] of [['.claude-plugin/marketplace.json', claudeEntry], ['.cursor-plugin/marketplace.json', cursorEntry]] as const) {
    if (entry.source !== './') problems.push(`${path}: ci-doctor's source must be ./`);
    if (!same(entry.description, portable.description)) problems.push(`${path}: ci-doctor's description differs from plugin.json's`);
    if (!same(entry.keywords, portable.keywords)) problems.push(`${path}: ci-doctor's keywords differ from plugin.json's`);
  }
  const source = (codexEntry.source ?? {}) as Json;
  // The marketplace's own checkout, so a local folder installs without GitHub, and `--ref` pins the plugin too.
  // A url source clones the default branch again, whatever ref the marketplace was added at.
  if (source.source !== 'local' || source.path !== './') problems.push(`.agents/plugins/marketplace.json: ci-doctor's source must be {"source": "local", "path": "./"}`);

  const readme = existsSync(join(root, 'README.md')) ? readFileSync(join(root, 'README.md'), 'utf8') : '';
  for (const line of INSTALL_LINES) if (!readme.includes(line)) problems.push(`README.md: missing the install line "${line}"`);
  const scorer = installText();
  for (const line of INSTALL_LINES) if (!scorer.includes(line)) problems.push(`scorer/src/install-steps.ts: missing the install line "${line}", which the README has`);
  const license = join(root, 'scorer', 'LICENSE');
  if (!existsSync(license) || readFileSync(license, 'utf8') !== readFileSync(join(root, 'LICENSE'), 'utf8')) problems.push('scorer/LICENSE: must be a copy of LICENSE, since npm packs only scorer/');

  const skills = skillNames(root);
  for (const name of skills) {
    const path = join(root, 'skills', name, 'SKILL.md');
    if (!existsSync(path)) {
      problems.push(`skills/${name}: no SKILL.md`);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    const { name: declared, description } = frontmatter(text);
    if (declared !== name) problems.push(`skills/${name}/SKILL.md: frontmatter name is ${String(declared)}, not ${name}`);
    if (!description) problems.push(`skills/${name}/SKILL.md: no description`);
    else if (description.length > 320) problems.push(`skills/${name}/SKILL.md: description is ${description.length} characters, over 320`);
    if (statSync(path).size > 10_000) problems.push(`skills/${name}/SKILL.md: over 10 KB`);
    if (!readme.includes(`\`${name}\``)) problems.push(`README.md: doesn't name the skill \`${name}\``);
  }
  for (const file of skillFiles(join(root, 'skills'))) {
    const path = relative(root, file);
    if (!/^skills\/[^/]+\/SKILL\.md$/.test(path)) problems.push(`${path}: only a skill's top folder may hold a SKILL.md; Codex would load this as a skill`);
  }

  return problems;
};

/** Each harness's own check, where its CLI is on PATH: [what ran, its exit code, its output]. */
export const harnessChecks = (root: string): [string, number | null, string][] => {
  const runs: [string, number | null, string][] = [];
  for (const target of ['.', '.claude-plugin/plugin.json']) {
    const run = spawnSync('claude', ['plugin', 'validate', target], { cwd: root, encoding: 'utf8' });
    if (run.error) return [['claude plugin validate', null, 'claude is not on PATH: skipped']];
    runs.push([`claude plugin validate ${target}`, run.status, `${run.stdout}${run.stderr}`]);
  }
  return runs;
};

if (argv[1] === fileURLToPath(import.meta.url)) {
  const root = cwd();
  const problems = validate(root);
  for (const problem of problems) console.log(problem);
  if (argv.includes('--harnesses')) {
    for (const [what, status, output] of harnessChecks(root)) {
      if (status === null) console.log(output);
      else if (status !== 0) problems.push(`${what} failed:\n${output}`), console.log(`${what} failed:\n${output}`);
      else console.log(`${what}: passed`);
    }
  }
  console.log(problems.length === 0 ? `plugin: ${skillNames(root).length} skills, manifests agree` : `plugin: ${problems.length} problems`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
