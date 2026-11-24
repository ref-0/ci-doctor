/**
 * Tests for check.ts: the old-name scan, the skills-only link check, the site check and the test runner each
 * catch what they're for, including the cases a review found they missed.
 *
 * Runs: `node --test check.test.ts` from this folder (Node 24).
 */
import { deepStrictEqual, equal, match } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { descriptionProblems, descriptions, FALLBACK, GITHUB_REF, GITHUB_URL, GUIDE_URL, HUB, OLD_NAMES, site, skillsOnly, standalone, tests } from './check.ts';
import { build } from './site/build.ts';

const flagged = (line: string) => OLD_NAMES.some(([pattern]) => pattern.test(line));

const write = (root: string, file: string, text: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};

describe('the old-name scan', () => {
  it('finds the hub\'s old topics and PROMPT.md, after any relative prefix and in commands', () => {
    for (const line of ['[ci](../agent-knowledge/repo-facts/ci.md)', 'the hub\'s references/agent-knowledge/', 'see ../agent-knowledge/progress.md', 'see ../verify-evidence/TOPIC.md', 'the hub\'s `verify-evidence` topic', 'skills/verify-evidence/', 'see ../graphs/TOPIC.md', 'skills/ci-doctor/references/graphs/', 'skills/ci-doctor/references/ci-workflows/TOPIC.md', 'see ../ci-workflows/TOPIC.md', 'the hub\'s `ci-workflows` topic', 'skills/ci-workflows/references/selection.md', '../../../../ci-workflows/references/caches.md', 'skills/ci-doctor/references/blacksmith/scripts/blacksmith-bill.ts', '[it](../blacksmith/TOPIC.md)', 'the hub\'s `blacksmith` topic', 'cat PROMPT.md', '[it](../PROMPT.md#x)', 'the `code-review` skill', 'skills/ci-doctor/references/speed-up-tests/', '[it](../speed-up-tests/TOPIC.md)', '../speed-up-tests/references/flakes.md', 'skills/ci-doctor/references/triage/flakes.md', 'the hub\'s speed-up-tests topic', 'the `speed-up-tests` topic', 'skills/ci-doctor/references/ci-runners/references/billing.md', '[it](../ci-runners/TOPIC.md)', 'the hub\'s ci-runners topic', 'the `ci-runners` topic', '[section 8](08-a-cheaper-test-harness.md)', 'https://ci-doctor.ref0.dev/guide/docs/pages/08-a-cheaper-test-harness.md', '8. A cheaper test harness', 'scripts/shards/README.md', '[a split](../../scripts/shards/README.md#start-simple-a-fixed-split)', '[it](../shards/ci-cache.ts)', 'node --test scripts/shards/test-groups.test.ts']) {
      equal(flagged(line), true, line);
    }
  });

  it('leaves the new paths alone', () => {
    for (const line of ['skills/ci-workflows/SKILL.md', '../../../ci-workflows/references/tiers.md', 'the `ci-workflows` skill', 'skills/optimize-graphs/references/selection.md', 'skills/cache-ci/references/caches.md', '../cache-ci/SKILL.md', 'skills/review-gate/SKILL.md', '[ci](../agent-knowledge/templates/repo-facts/ci.md)', 'the [`agent-knowledge`](../agent-knowledge/SKILL.md) skill', 'skills/agent-knowledge/references/where-it-lives.md', 'skills/speed-up-tests/SKILL.md', '../speed-up-tests/references/fixes.md', 'the `speed-up-tests` skill', 'skills/fix-flaky-test/SKILL.md', '../fix-flaky-test/references/symptoms.md', 'skills/ci-runners/SKILL.md', '../ci-runners/references/queues.md', 'the `ci-runners` skill', 'skills/blacksmith/SKILL.md', '<skills-dir>/blacksmith/scripts', 'the `blacksmith` skill', '[section 8](08-a-faster-test-harness.md)', '8. A faster test harness', 'a cheap test harness', 'node scripts/shards/test-shards.ts --merge', '[`ci-cache.ts`](../../skills/ci-runners/scripts/ci-cache.ts)', 'skills/ci-runners/references/shards.md']) {
      equal(flagged(line), false, line);
    }
  });
});

describe('the skills-only link check', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-skills-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  write(root, 'skills/ci-doctor/SKILL.md', `# Hub\n\n## Outside the skills\n\n${FALLBACK.map((f) => `\`${f}\``).join(', ')}\n`);
  write(root, 'skills/ci-doctor/references/page.md', '# Page\n\nSee [the notes][notes].\n\n[notes]: ../../../elsewhere/notes.md\n');
  write(root, 'elsewhere/notes.md', '# Notes\n');

  it('follows reference-style links out of the copy, as it does inline ones', () => {
    const problems = skillsOnly(root);
    equal(problems.length, 1);
    match(problems[0] ?? '', /page\.md:5: .*leaves skills\/ for elsewhere\/notes\.md/);
  });
});

describe('the each-skill-alone link check', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-alone-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const gh = `${GITHUB_URL}blob/${GITHUB_REF}/`;
  write(root, 'README.md', '# R\n\nSee [the skills](skills/README.md).\n');
  write(root, 'skills/README.md', '# Skills\n');
  write(root, `skills/${HUB}/SKILL.md`, `---\nname: ${HUB}\ndescription: "The hub."\n---\n\n# Hub\n\n## Rules\n\nSee [the guide](../../docs/a.md#one), [the leaf](../leaf/SKILL.md#steps) and [a secret](../../private/notes.md).\n`);
  write(
    root,
    'skills/leaf/SKILL.md',
    [
      '---\nname: leaf\ndescription: "A leaf."\n---\n\n# Leaf\n\n## Steps\n',
      'Read [the detail](references/detail.md#gone), [the guide](../../docs/a.md#one) and [the hub](../hub/SKILL.md#rules).',
      `In full: [the guide](${GUIDE_URL}docs/a.md#one), [no heading](${GUIDE_URL}docs/a.md#two), [the hub](${gh}skills/${HUB}/SKILL.md#rules), [a folder](${GITHUB_URL}tree/${GITHUB_REF}/docs), [gone](${gh}docs/gone.md) and [unserved](${GUIDE_URL}private/notes.md).`,
      `On main: [the guide](${GITHUB_URL}blob/main/docs/a.md#one) and [gone](${GITHUB_URL}blob/main/docs/main-gone.md). An older tag: [the guide](${GITHUB_URL}blob/v0.0.1/docs/a.md#one).`,
      'Elsewhere: [another branch](https://github.com/ref-0/ci-doctor/blob/a-branch/docs/gone.md) and [a site](https://example.com/x).',
      '',
    ].join('\n\n'),
  );
  write(root, 'skills/leaf/references/detail.md', '# Detail\n');
  write(root, 'docs/a.md', '# A\n\n## One\n');
  write(root, 'private/notes.md', '# Notes\n');
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', '.'], { cwd: root });
  write(root, '.gitignore', 'private/\n');
  spawnSync('git', ['rm', '-q', '--cached', 'private/notes.md'], { cwd: root });

  const results = standalone(root);
  const of = (name: string) => (results.find((r) => r.name === name)?.problems ?? []).join('\n');

  it('lets the hub link out relatively, to what the site serves only', () => {
    equal(of(HUB).split('\n').length, 1, of(HUB));
    match(of(HUB), /\.\.\/\.\.\/private\/notes\.md: leaves ci-doctor\/ for private\/notes\.md, which .* doesn't serve/);
  });

  it('fails any other skill\'s relative link out of its folder, even to a file the site serves', () => {
    match(of('leaf'), /SKILL\.md:\d+: \.\.\/\.\.\/docs\/a\.md#one: leaves leaf\/ by a relative path/);
    match(of('leaf'), /SKILL\.md:\d+: \.\.\/hub\/SKILL\.md#rules: leaves leaf\/ by a relative path/);
    match(of('leaf'), /references\/detail\.md#gone: .*with leaf installed alone/);
  });

  it('checks full links to the guide and to GitHub on the branch against the repo, and leaves other URLs alone', () => {
    const leaf = of('leaf');
    match(leaf, /docs\/a\.md#two: no heading makes #two in docs\/a\.md/);
    match(leaf, /docs\/gone\.md: no docs\/gone\.md in the repo/);
    match(leaf, /private\/notes\.md: .* doesn't serve private\/notes\.md/);
    match(leaf, /docs\/main-gone\.md: no docs\/main-gone\.md in the repo/);
    equal(leaf.split('\n').length, 8, leaf);
  });

  it('resolves links to the release tag in the working tree, before the tag exists, and fails a link to another tag', () => {
    const leaf = of('leaf');
    equal(spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${GITHUB_REF}`], { cwd: root }).status, 1);
    equal(leaf.includes(`blob/${GITHUB_REF}/skills/${HUB}/SKILL.md#rules`), false, leaf);
    equal(leaf.includes(`tree/${GITHUB_REF}/docs:`), false, leaf);
    match(leaf, /blob\/v0\.0\.1\/docs\/a\.md#one: links v0\.0\.1, not this release's v\d/);
  });
});

describe('the test runner', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-tests-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  write(root, 'skills/a/scripts/empty.test.ts', "import { describe } from 'node:test';\ndescribe('nothing', () => {});\n");
  write(root, 'skills/a/scripts/one.test.ts', "import { it } from 'node:test';\nit('passes', () => {});\n");
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', '.'], { cwd: root });

  it('counts a file where no test passed as a problem, and a passing one as not', () => {
    const run = tests(root);
    deepStrictEqual(
      run.problems.filter((p) => !p.startsWith('scripts/')).map((p) => p.split(':')[0]),
      ['skills/a/scripts/empty.test.ts'],
    );
    equal(run.passed, 1);
  });
});

describe('the site check', () => {
  /** A repo whose links all resolve in Git, so the repo's own link check passes it. */
  const repo = (extra: Record<string, string> = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'check-site-'));
    const files: Record<string, string> = {
      '.gitignore': 'dist/\n',
      'README.md': '<h1>x</h1>\n\nA guide.\n\nSee [the guide](docs/README.md), [the tools](tools/) and the [license](LICENSE).\n',
      'CHANGELOG.md': '# Changelog\n\nReleases.\n',
      LICENSE: 'MIT\n',
      'docs/README.md': '# Guide\n\nIntro, see [two](pages/02-b.md).\n\n## Contents\n\n1. [One](pages/01-a.md)\n2. [Two](pages/02-b.md)\n',
      'docs/pages/01-a.md': '[Guide](../README.md)\n\n# 1. A\n\n**Applies when:** always. More.\n',
      'docs/pages/02-b.md': '# 2. B\n\nUses [the script](../../scripts/x/run.ts).\n',
      'skills/hub/SKILL.md': '---\nname: hub\ndescription: "The hub."\n---\n\n# Hub\n',
      'scripts/x/README.md': '# X\n\nRuns things.\n',
      'scripts/x/run.ts': 'export {};\n',
      'tools/t/README.md': '# T\n\nA tool.\n',
      'tools/t/src/main.ts': 'export {};\n',
      ...extra,
    };
    for (const [file, text] of Object.entries(files)) write(root, file, text);
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['add', '.'], { cwd: root });
    return root;
  };
  const roots: string[] = [];
  after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
  const problems = (extra?: Record<string, string>, untracked: Record<string, string> = {}) => {
    const root = repo(extra);
    roots.push(root);
    for (const [file, text] of Object.entries(untracked)) write(root, file, text);
    return site(root).problems;
  };

  it('passes a repo whose links land on served files and folders, and serves a linked folder whole', () => {
    deepStrictEqual(problems(), []);
    const root = repo();
    roots.push(root);
    build(root, join(root, 'out'));
    equal(existsSync(join(root, 'out/guide/tools/t/src/main.ts')), true);
    equal(existsSync(join(root, 'out/guide/tools/index.html')), true);
    // A guide page is listed by its title alone; other files keep a description.
    const llms = readFileSync(join(root, 'out/llms.txt'), 'utf8');
    match(llms, /^- \[1\. A\]\(https:\/\/ci-doctor\.ref0\.dev\/guide\/docs\/pages\/01-a\.md\)$/m);
    match(llms, /^- \[X\]\(https:\/\/ci-doctor\.ref0\.dev\/guide\/scripts\/x\/README\.md\): Runs things\.$/m);
  });

  it('builds the same bytes twice', () => {
    const root = repo();
    roots.push(root);
    build(root, join(root, 'a'));
    build(root, join(root, 'b'));
    const diff = spawnSync('diff', ['-r', 'a', 'b'], { cwd: root });
    equal(diff.status, 0, diff.stdout.toString());
  });

  it('fails a link to a file Git ignores, which the repo link check passes because it exists', () => {
    const found = problems({ 'scripts/x/README.md': '# X\n\nBuilt: [the bundle](../../dist/out.js).\n' }, { 'dist/out.js': '' });
    deepStrictEqual(found, ["scripts/x/README.md:3: ../../dist/out.js: dist/out.js isn't served"]);
  });

  it('fails a link to a test fixture, and to a folder holding only fixtures', () => {
    const found = problems({
      'scripts/x/README.md': '# X\n\nSee [a fixture](test/fixtures/a.json) and [them all](test/fixtures/).\n',
      'scripts/x/test/fixtures/a.json': '{}\n',
    });
    equal(found.length, 2);
    match(found.join('\n'), /test\/fixtures\/a\.json isn't served[\s\S]*test\/fixtures isn't served/);
  });

  it('fails a link that leaves the repo', () => {
    const found = problems({ 'docs/pages/02-b.md': '# 2. B\n\nSee [the monorepo](../../../elsewhere/README.md).\n' });
    match(found.join('\n'), /docs\/pages\/02-b\.md:3: .*: leaves \/guide\//);
  });

  it("fails a guide page that docs/README.md's contents don't list, so llms.txt leaves it out", () => {
    const found = problems({ 'docs/pages/03-c.md': '# 3. C\n\nNew.\n', 'docs/pages/02-b.md': '# 2. B\n\nNext: [C](03-c.md).\n' });
    deepStrictEqual(found, ["llms.txt: doesn't name docs/pages/03-c.md"]);
  });
});

describe('the description lint', () => {
  const skills = new Set(['speed-up-tests', 'fix-flaky-test']);
  const good = 'Makes slow tests faster. Use when a test is slow. Not for a flaky test (fix-flaky-test).';
  const one = (description: string) => descriptionProblems(description, skills);

  it('passes a description in the shape', () => {
    deepStrictEqual(one(good), []);
  });

  it('fails each rule, saying why it exists', () => {
    match(one(`${good} ${'x'.repeat(320)}`).join('\n'), /over 320: .*shorten or drop/);
    match(one('Makes slow tests faster.').join('\n'), /no "Use when"/);
    match(one(`${good} See \`x\`.`).join('\n'), /backtick or angle bracket/);
    match(one(`${good} Reads <file>.`).join('\n'), /backtick or angle bracket/);
    match(one('Is it slow? Use when a test is slow.').join('\n'), /a question/);
  });

  it('bans cheap and cheaper', () => {
    match(one('Makes CI cheaper. Use when slow.').join('\n'), /"cheaper": .*costs less/);
    match(one('Keeps runs cheap. Use when slow.').join('\n'), /"cheap": /);
  });

  it('finds first and second person as words only', () => {
    match(one('Fixes our tests. Use when slow.').join('\n'), /"our": .*third person/);
    match(one('Use when you see it.').join('\n'), /"you"/);
    match(one('Use when I see it.').join('\n'), /"I"/);
    deepStrictEqual(one('Fixes CI in Iowa. Use when outward or yourself-named tests run.'), []);
  });

  it('fails a "Not for" sibling that is not a skill folder, and leaves brackets before it alone', () => {
    match(one('Use when slow. Not for a flake (ci-doctor).').join('\n'), /names \(ci-doctor\), which isn't a skill folder/);
    deepStrictEqual(one('Reads files (any kind). Use when slow. Not for a flake (fix-flaky-test); a slow one (speed-up-tests).'), []);
  });

  it('reads every skill folder in a repo', () => {
    const root = mkdtempSync(join(tmpdir(), 'check-descriptions-'));
    after(() => rmSync(root, { recursive: true, force: true }));
    write(root, 'skills/a/SKILL.md', '---\nname: a\ndescription: "Does a. Use when a. Not for b (b)."\n---\n');
    write(root, 'skills/b/SKILL.md', '---\nname: b\ndescription: "Does b. Not for c (c)."\n---\n');
    deepStrictEqual(descriptions(root), ['skills/b/SKILL.md: description: no "Use when": a harness picks a skill by when to use it, in the words people ask with', "skills/b/SKILL.md: description: \"Not for\" names (c), which isn't a skill folder: a sibling named there must exist, or the request goes nowhere"]);
  });
});
