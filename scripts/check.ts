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
 * 5. **Links, each skill alone:** each skill's folder copied alone, as `npx skills add` with one skill
 *    chosen, or a copy of that folder, installs it. A link that stays in the folder must resolve in the
 *    copy. A skill leaves its folder only by a full link, to ci-doctor.ref0.dev/guide/<path> or to
 *    GitHub at `next`, naming a file in the repo, with its anchor: a relative link out of the folder
 *    fails, since it dangles in the copy. The hub alone may also link out relatively, to a file the
 *    guide site serves (`served` in `scripts/site/build.ts`), as its "Outside the skills" says.
 * 6. **Old names:** no Markdown, script or workflow, in prose or in a fenced command, names what this
 *    release replaced: `code-review`, the hub's five topics as skills, the hub's `graphs`,
 *    `speed-up-tests`, `verify-evidence` and `ci-runners` topics, its `flakes.md`, `references/agent-knowledge/`,
 *    `<root>`, `install.ts`, or `PROMPT.md`, `docs/prompts/`, `checks/` and
 *    `templates/agent-knowledge/` as paths.
 * 7. **Docs budget:** `scripts/docs/docs-budget.ts`'s budgets, with the skills at `skills/`.
 * 8. **Site:** the guide for ci-doctor.ref0.dev, built into a temporary folder (`scripts/site/build.ts`). Every
 *    relative link in a served Markdown file must land on a served file or folder, and `llms.txt` must
 *    name every guide page, skill and reference README, and only what's served.
 * 9. **Tests:** every test file under `skills/` and `scorer/test/` (the scorer's CLI run from source), and those under `scripts/` that the skills' scripts and these
 *    checks use, each from its own folder. A skipped test fails: each needs its fixtures.
 *
 * Runs: from the repo's root, before pushing. Node 24, `git` and `jq` only. Temporary folders go in
 * the OS temp folder: set TMPDIR to move them.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { argv, cwd } from 'node:process';
import { fileURLToPath } from 'node:url';

import { anchorsOf, checkFile, filesUnder, linkTargets, proseLines } from './docs/check-links.ts';
import { docsBudget, layout } from './docs/docs-budget.ts';
import { validate } from './plugin/validate.ts';
import { BASE, build, ORIGIN, served, siteProblems } from './site/build.ts';
import { stale } from './skills/excerpts.ts';

/** Where a link out of `skills/` may land: the paths the hub's "Outside the skills" names. */
export const FALLBACK = ['docs/', 'scripts/', 'templates/', 'tools/', 'cache/', 'README.md', 'CHANGELOG.md'];

/** Test files the build runs besides every one under `skills/`. */
export const REPO_TESTS = ['scripts/skills/excerpts.test.ts', 'scripts/check.test.ts', 'scripts/docs/check-links.test.ts', 'scripts/graph/test/graph.test.ts'];

/** Files the old-name scan leaves alone: history, provenance, and this file's own patterns and their tests. */
export const SCAN_SKIPS = ['CHANGELOG.md', 'scripts/check.ts', 'scripts/check.test.ts', 'skills/test-audit/UPSTREAM.md'];

const TOPICS = 'ci-workflows|blacksmith';

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
  [/ci-doctor\/references\/graphs\b|\.\.\/graphs\/TOPIC\.md|<skills-dir>\/ci-doctor\/references\/graphs\b/, 'skills/optimize-graphs/'],
  [/verify-evidence/, 'skills/prove-it/'],
  [/references\/agent-knowledge\b|(?<![\w-])agent-knowledge\/(?!SKILL\.md|templates\b|references\b)[\w-]+(?:\.md|\/)/, 'skills/agent-knowledge/templates/'],
  [/ci-doctor\/references\/speed-up-tests\b|(?<![\w-])speed-up-tests\/TOPIC\.md/, 'skills/speed-up-tests/'],
  [/(?<![\w-])(speed-up-tests\/references|triage)\/flakes\.md/, 'skills/fix-flaky-test/'],
  [/(?<![\w-])`?speed-up-tests`?('s)? topic\b/, 'the `speed-up-tests` skill'],
  [/ci-doctor\/references\/ci-runners\b|(?<![\w-])ci-runners\/TOPIC\.md/, 'skills/ci-runners/'],
  [/(?<![\w-])`?ci-runners`?('s)? topic\b/, 'the `ci-runners` skill'],
  [/(?<![\w./-])docs\/prompts\b/, 'skills/ci-doctor/references/phases/'],
  [/(?<![\w./-])templates\/agent-knowledge\b/, 'skills/agent-knowledge/templates/'],
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

/** The skill that installs with the rest of the repo beside it: its links out are held by the skills-only check, against FALLBACK. */
export const HUB = 'ci-doctor';

/** Where a skill's full links to the rest of ci-doctor point: the guide site, and the repo on GitHub at the branch the skills track. */
export const GUIDE_URL = `${ORIGIN}/${BASE}/`;
export const GITHUB_URL = 'https://github.com/ref-0/ci-doctor/';
export const GITHUB_REF = 'next';

/** The repo path a full link to the guide site or to GitHub at GITHUB_REF names, or undefined for any other URL. */
export const ownPath = (url: string): string | undefined => {
  const [base = ''] = url.split('#');
  if (base.startsWith(GUIDE_URL)) return decodeURIComponent(base.slice(GUIDE_URL.length));
  const github = new RegExp(`^${GITHUB_URL.replace(/[.\/]/g, '\\$&')}(?:blob|tree)/${GITHUB_REF}/(.*)$`).exec(base);
  return github ? decodeURIComponent(github[1] ?? '') : undefined;
};

/**
 * One skill's folder copied alone. A link that stays in the folder must resolve in the copy. Any other skill may
 * leave its folder only by a full link, to the guide site or to GitHub at GITHUB_REF, which must name a file or
 * folder in the repo, with its anchor; the guide site's must be served. The hub may also leave it by a relative
 * link to a file the site serves.
 */
export const standaloneSkill = (root: string, name: string, site: ReadonlySet<string> = new Set(served(root))): string[] => {
  const problems: string[] = [];
  const folders = new Set([...site].flatMap((f) => f.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
  const top = mkdtempSync(join(tmpdir(), `ci-doctor-skill-${name}-`));
  const anchorIn = (inRepo: string, anchor: string, at: string) => {
    const there = join(root, inRepo);
    if (anchor && there.endsWith('.md') && existsSync(there) && statSync(there).isFile() && !anchorsOf(there).has(anchor.toLowerCase())) problems.push(`${at}: no heading makes #${anchor} in ${inRepo}`);
  };
  try {
    const copy = join(top, name);
    cpSync(join(root, 'skills', name), copy, { recursive: true, dereference: true });
    for (const file of walk(copy).filter((f) => f.endsWith('.md'))) {
      const shown = `skills/${relative(top, file).split(sep).join('/')}`;
      const inside = (target: string) => target.startsWith('#') || resolve(dirname(file), decodeURIComponent(target.split('#')[0] ?? '')).startsWith(copy + sep);
      problems.push(...checkFile(file).filter((p) => inside(p.target)).map((p) => `${shown}:${p.line}: ${p.target}: ${p.why}, with ${name} installed alone`));
      proseLines(readFileSync(file, 'utf8')).forEach((line, index) => {
        for (const target of linkTargets(line)) {
          const at = `${shown}:${index + 1}: ${target}`;
          const [path = '', anchor = ''] = target.split('#');
          const own = ownPath(target);
          if (own !== undefined) {
            if (own === '' && target.startsWith(GUIDE_URL)) continue;
            const exists = existsSync(join(root, own.replace(/\/$/, '')));
            if (!exists) problems.push(`${at}: no ${own} in the repo`);
            else if (target.startsWith(GUIDE_URL) && !site.has(own) && !folders.has(own.replace(/\/$/, ''))) problems.push(`${at}: ${GUIDE_URL} doesn't serve ${own}`);
            else anchorIn(own, anchor, at);
            continue;
          }
          if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|<)/i.test(target)) continue;
          const resolved = resolve(dirname(file), decodeURIComponent(path));
          if (resolved === copy || resolved.startsWith(copy + sep)) continue;
          const inRepo = repoPath(relative(top, resolved));
          if (name !== HUB) {
            problems.push(`${at}: leaves ${name}/ by a relative path, which dangles with ${name} installed alone: copy what the skill needs into it, or link ${GUIDE_URL}<path> or ${GITHUB_URL}blob/${GITHUB_REF}/<path>`);
            continue;
          }
          if (inRepo === undefined || (!site.has(inRepo) && !folders.has(inRepo.replace(/\/$/, '')))) {
            problems.push(`${at}: leaves ${name}/ for ${inRepo ?? 'outside the repo'}, which ${GUIDE_URL} doesn't serve`);
            continue;
          }
          anchorIn(inRepo, anchor, at);
        }
      });
    }
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
  return problems;
};

/** A path from the copy's parent folder, as the repo path it has beside `skills/<name>/`, or undefined if it leaves the repo. */
const repoPath = (fromTop: string): string | undefined => {
  const path = posix.normalize(posix.join('skills', fromTop.split(sep).join('/')));
  return path.startsWith('..') ? undefined : path;
};

/** Every skill, each copied alone: its name and what's wrong. */
export const standalone = (root: string): { name: string; problems: string[] }[] => {
  const site = new Set(served(root));
  return readdirSync(join(root, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, problems: standaloneSkill(root, name, site) }));
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
  const alone = standalone(root);
  return [
    { name: 'plugin', problems: validate(root), summary: 'manifests agree; each skill loads as one' },
    { name: 'excerpts', problems: stale(root).map((p) => `${p}: stale; run node scripts/skills/excerpts.ts`), summary: 'match their sources' },
    { name: 'links, repo', problems: links.flatMap(checkFile).map((p) => `${relative(root, p.file)}:${p.line}: ${p.target}: ${p.why}`), summary: `${links.length} Markdown files resolve` },
    { name: 'links, skills only', problems: skillsOnly(root), summary: 'resolve in the copy, or leave it only for the fallback' },
    { name: 'links, each skill alone', problems: alone.flatMap((s) => s.problems), summary: alone.map((s) => `${s.name} ok`).join(', ') },
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
