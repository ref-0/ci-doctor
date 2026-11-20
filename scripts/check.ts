#!/usr/bin/env node
/**
 * The build checks, as one command: what must hold before a change to this repo merges.
 *
 *     node scripts/check.ts
 *
 * 1. **Plugin:** the manifests agree and each skill loads as one skill (`scripts/plugin/validate.ts`).
 * 2. **Excerpts:** the hub's phase excerpts match their sources (`scripts/skills/excerpts.ts --check`).
 * 3. **Links, in the repo:** every relative link and anchor in the tracked Markdown resolves
 *    (`scripts/docs/check-links.ts`).
 * 4. **Links, skills only:** `skills/` copied alone, as `npx skills add` or a copy by hand installs
 *    it. A link that stays in the copy must resolve there. A link that leaves it must land on a file
 *    in the repo under one of FALLBACK's paths, the ones the hub's "Outside the skills" names, and
 *    the hub must name each.
 * 5. **Old names:** no Markdown, script or workflow, in prose or in a fenced command, names what this
 *    release replaced: `code-review`, the hub's five topics as skills, `<root>`, `install.ts`, or
 *    `PROMPT.md`, `docs/prompts/`, `checks/` and `templates/agent-knowledge/` as paths.
 * 6. **Docs budget:** `scripts/docs/docs-budget.ts`'s budgets, with the skills at `skills/`.
 * 7. **Site:** the guide for ci-doctor.ref0.dev, built into a temporary folder (`scripts/site/build.ts`). Every
 *    relative link in a served Markdown file must land on a served file or folder, and `llms.txt` must
 *    name every guide page, skill and reference README, and only what's served.
 * 8. **Tests:** every test file under `skills/` and `scorer/test/` (the scorer's CLI run from source), and those under `scripts/` that the skills' scripts and these
 *    checks use, each from its own folder. A skipped test fails: each needs its fixtures.
 *
 * Runs: from the repo's root, before pushing. Node 24, `git` and `jq` only. Temporary folders go in
 * the OS temp folder: set TMPDIR to move them.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { argv, cwd } from 'node:process';
import { fileURLToPath } from 'node:url';

import { anchorsOf, checkFile, filesUnder, linkTargets, proseLines } from './docs/check-links.ts';
import { docsBudget, layout } from './docs/docs-budget.ts';
import { validate } from './plugin/validate.ts';
import { build, siteProblems } from './site/build.ts';
import { stale } from './skills/excerpts.ts';

/** Where a link out of `skills/` may land: the paths the hub's "Outside the skills" names. */
export const FALLBACK = ['docs/', 'scripts/', 'templates/', 'tools/', 'cache/', 'README.md', 'CHANGELOG.md'];

/** Test files the build runs besides every one under `skills/`. */
export const REPO_TESTS = ['scripts/skills/excerpts.test.ts', 'scripts/check.test.ts', 'scripts/docs/check-links.test.ts', 'scripts/graph/test/graph.test.ts'];

/** Files the old-name scan leaves alone: history, provenance, and this file's own patterns and their tests. */
export const SCAN_SKIPS = ['CHANGELOG.md', 'scripts/check.ts', 'scripts/check.test.ts', 'skills/test-audit/UPSTREAM.md'];

const TOPICS = 'ci-workflows|ci-runners|blacksmith|speed-up-tests|verify-evidence';

/** What this release replaced, each with what to use instead. */
export const OLD_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/code-review/, 'review-gate'],
  [/<root>/, 'a path from the skill, or the skill by name'],
  [/(?<![\w-])install\.ts/, 'the plugin install, and scripts/docs/check-links.ts for links'],
  [new RegExp(`(?<![\\w-])skills/(${TOPICS})\\b`), 'skills/ci-doctor/references/<topic>/'],
  [new RegExp(`<skills-dir>/(${TOPICS})\\b`), '<skills-dir>/ci-doctor/references/<topic>/'],
  [new RegExp(`\\b(${TOPICS})/SKILL\\.md`), '<topic>/TOPIC.md'],
  [new RegExp(`(?<![\\w-])\`?(${TOPICS})\`?('s)? skills?\\b`), 'the hub\'s <topic> topic'],
  [new RegExp(`\\bskills? \`(${TOPICS})\``), 'the hub\'s <topic> topic'],
  [/(?<![\w./-])docs\/prompts\b/, 'skills/ci-doctor/references/phases/'],
  [/(?<![\w./-])templates\/agent-knowledge\b/, 'skills/ci-doctor/references/agent-knowledge/'],
  [/`checks\/|<skills-dir>\/checks\//, 'skills/ci-doctor/references/checks/'],
  [/(?<![\w-])PROMPT\.md\b/, 'skills/ci-doctor/SKILL.md'],
];

/** Files that may still name PROMPT.md as a path: the pointer itself, and the README's clone prompt. */
const PROMPT_OK = new Set(['PROMPT.md', 'README.md']);

type Result = { readonly name: string; readonly problems: ReadonlyArray<string>; readonly summary: string };

const tracked = (root: string) =>
  spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .stdout.split('\0')
    .filter((f) => f !== '' && existsSync(join(root, f)));

/** Every file under a folder. */
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });

/** The links in a skills-only copy that leave it for somewhere the hub's fallback doesn't cover. */
export const skillsOnly = (root: string): string[] => {
  const problems: string[] = [];
  const hub = readFileSync(join(root, 'skills', 'ci-doctor', 'SKILL.md'), 'utf8');
  const fallback = /## Outside the skills\n([\s\S]*?)(?:\n## |$)/.exec(hub)?.[1] ?? '';
  if (fallback === '') problems.push('skills/ci-doctor/SKILL.md: no "Outside the skills" section to cover links out of skills/');
  for (const path of FALLBACK) if (!fallback.includes(`\`${path}\``)) problems.push(`skills/ci-doctor/SKILL.md: "Outside the skills" doesn't name \`${path}\``);

  const top = mkdtempSync(join(tmpdir(), 'ci-doctor-skills-'));
  try {
    const copy = join(top, 'skills');
    cpSync(join(root, 'skills'), copy, { recursive: true, dereference: true });
    for (const file of walk(copy).filter((f) => f.endsWith('.md'))) {
      const shown = relative(top, file);
      problems.push(...checkFile(file).filter((p) => resolve(dirname(file), p.target.split('#')[0] ?? '').startsWith(copy + sep) || p.target.startsWith('#')).map((p) => `${shown}:${p.line}: ${p.target}: ${p.why}, in a skills-only copy`));
      proseLines(readFileSync(file, 'utf8')).forEach((line, index) => {
        for (const target of linkTargets(line)) {
          if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|<)/i.test(target)) continue;
          const [path = '', anchor = ''] = target.split('#');
          const resolved = resolve(dirname(file), decodeURIComponent(path));
          if (resolved === copy || resolved.startsWith(copy + sep)) continue;
          const inRepo = relative(top, resolved).split(sep).join('/');
          const at = `${shown}:${index + 1}: ${target}`;
          if (inRepo.startsWith('..') || !FALLBACK.some((f) => (f.endsWith('/') ? inRepo.startsWith(f) : inRepo === f))) {
            problems.push(`${at}: leaves skills/ for ${inRepo}, which the hub's fallback doesn't cover`);
            continue;
          }
          const there = join(root, inRepo);
          if (!existsSync(there)) problems.push(`${at}: no ${inRepo} in the repo`);
          else if (anchor && there.endsWith('.md') && statSync(there).isFile() && !anchorsOf(there).has(anchor.toLowerCase())) problems.push(`${at}: no heading makes #${anchor} in ${inRepo}`);
        }
      });
    }
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
  return problems;
};

/** The site, built into a temporary folder: links that leave what it serves, and `llms.txt`'s gaps. */
export const site = (root: string): { problems: string[]; files: number } => {
  const top = mkdtempSync(join(tmpdir(), 'ci-doctor-site-'));
  try {
    const { files } = build(root, join(top, 'site'));
    return { problems: siteProblems(root, join(top, 'site')), files };
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
};

/** Each line that names what this release replaced, in prose or in code. */
export const oldNames = (root: string, files = tracked(root)): string[] => {
  const problems: string[] = [];
  for (const file of files.filter((f) => /\.(md|ts|ya?ml|sh)$/.test(f) && !SCAN_SKIPS.includes(f))) {
    readFileSync(join(root, file), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const [pattern, use] of OLD_NAMES) {
          const found = pattern.exec(line)?.[0];
          if (found === undefined) continue;
          if (/PROMPT\.md/.test(found) && PROMPT_OK.has(file)) continue;
          problems.push(`${file}:${index + 1}: "${found}": use ${use}`);
        }
      });
  }
  return problems;
};

/** Run each test file from its folder; a failure or a skip is a problem. */
export const tests = (root: string): { problems: string[]; ran: number; passed: number } => {
  const files = [...tracked(root).filter((f) => (f.startsWith('skills/') || f.startsWith('scorer/test/')) && f.endsWith('.test.ts')), ...REPO_TESTS];
  const problems: string[] = [];
  let passed = 0;
  for (const file of files) {
    if (!existsSync(join(root, file))) {
      problems.push(`${file}: missing`);
      continue;
    }
    // The spec reporter, pinned: its summary lines are what the counts below read, whatever NODE_OPTIONS or a TTY would pick.
    const { NODE_TEST_CONTEXT: _parent, ...inherited } = process.env; // run as a test of its own, even when this runs under node --test
    const env = { ...inherited, CI_DOCTOR_TEST_CLI: 'src' }; // the scorer's CLI tests run its source: no build, no npm install
    const done = spawnSync(process.execPath, ['--test', '--test-reporter=spec', file.split('/').at(-1) ?? file], { cwd: join(root, dirname(file)), encoding: 'utf8', env });
    const count = (key: string) => Number(new RegExp(`^ℹ ${key} (\\d+)$`, 'm').exec(done.stdout)?.[1] ?? 0);
    passed += count('pass');
    if (!/^ℹ tests \d+$/m.test(done.stdout)) problems.push(`${file}: no test summary in its output\n${(done.stdout + done.stderr).split('\n').slice(-12).join('\n')}`);
    else if (count('pass') === 0) problems.push(`${file}: no test passed`);
    if (done.status !== 0 || count('fail') > 0) problems.push(`${file}: failed\n${done.stdout.split('\n').filter((l) => /not ok|Error|expected|actual/.test(l)).slice(0, 12).join('\n')}`);
    if (count('skipped') > 0) problems.push(`${file}: ${count('skipped')} skipped; each test needs its fixtures:\n${done.stdout.split('\n').filter((l) => /# SKIP/.test(l)).join('\n')}`);
  }
  return { problems, ran: files.length, passed };
};

export const checks = (root: string): Result[] => {
  const links = filesUnder(root, []).filter((f) => f.endsWith('.md'));
  const budget = docsBudget(root, { ...layout, skillPath: /^skills\/([^/]+)\/SKILL\.md$/, upstreamLock: undefined, upstreamPrefixes: ['test-audit'], rules: undefined });
  const run = tests(root);
  const built = site(root);
  return [
    { name: 'plugin', problems: validate(root), summary: 'manifests agree; each skill loads as one' },
    { name: 'excerpts', problems: stale(root).map((p) => `${p}: stale; run node scripts/skills/excerpts.ts`), summary: 'match their sources' },
    { name: 'links, repo', problems: links.flatMap(checkFile).map((p) => `${relative(root, p.file)}:${p.line}: ${p.target}: ${p.why}`), summary: `${links.length} Markdown files resolve` },
    { name: 'links, skills only', problems: skillsOnly(root), summary: 'resolve in the copy, or leave it only for the fallback' },
    { name: 'old names', problems: oldNames(root), summary: 'none' },
    { name: 'docs budget', problems: budget.problems, summary: `${budget.docs.length} Markdown files within budget` },
    { name: 'site', problems: built.problems, summary: `${built.files} files; every link lands on one, and llms.txt names every page` },
    { name: 'tests', problems: run.problems, summary: `${run.ran} files, ${run.passed} tests passed, none skipped` },
  ];
};

if (argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(argv[1])) {
  const results = checks(cwd());
  for (const { name, problems, summary } of results) {
    if (problems.length === 0) console.log(`ok   ${name}: ${summary}`);
    else console.log(`FAIL ${name}:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
  const failed = results.filter((r) => r.problems.length > 0).length;
  console.log(failed === 0 ? 'every check passed' : `${failed} of ${results.length} checks failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}
