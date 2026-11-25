/**
 * docs-budget.test.ts: each budget at and one past its limit, the skill warning line and its move
 * message, history lines, upstream copies, and the command on a throwaway git repository.
 *
 *     node --test scripts/docs/docs-budget.test.ts
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { budgets, description, docsBudget, layout, problems, referenceName, sections, warnings } from './docs-budget.ts';

/** A `SKILL.md` with `about` as its description and a body that makes it `size` bytes long. */
const skill = (about: string, size = 0) => {
  const head = `---\nname: deploy\ndescription: "${about}"\n---\n`;

  return head + 'x'.repeat(Math.max(0, size - head.length));
};

describe('description', () => {
  it('reads plain, quoted and folded descriptions as one line', () => {
    assert.equal(description('---\nname: a\ndescription: Plain words.\n---\n'), 'Plain words.');
    assert.equal(description("---\ndescription: 'Single quoted.'\nname: a\n---\n"), 'Single quoted.');
    assert.equal(description('---\nname: a\ndescription: >-\n  Folded over\n  two lines.\n---\n'), 'Folded over two lines.');
    assert.equal(description('---\nname: a\n---\n'), undefined);
  });
});

describe('sections', () => {
  it('sizes each section with its subsections, largest first, and skips fenced headings', () => {
    const text = '# Title\n\n## Small\n\na\n\n## Large\n\n### Sub\n\n```md\n## Not a heading\n```\n\nbbbbbbbb\n';

    assert.deepEqual(
      sections(text).map(({ heading }) => heading),
      ['Large', 'Small'],
    );
    assert.equal(sections(text)[0]?.size, Buffer.byteLength('## Large\n\n### Sub\n\n```md\n## Not a heading\n```\n\nbbbbbbbb\n'));
    assert.equal(sections(text)[1]?.size, Buffer.byteLength('## Small\n\na\n\n'));
    assert.deepEqual(sections('No sections.\n'), []);
    assert.deepEqual(sections('## A\nx\n## B\nyz').map(({ heading, size }) => [heading, size]), [['A', 7], ['B', 7]]);
  });

  it('closes a fence only with a bare run of its own marker, at least as long', () => {
    const text = '## Real\n\n````md\n```sh\n## Inside four\n```\n````\n\n~~~\n## Inside tildes\n```\n~~~\n\n```\n```sh\n## Inside, after an info-string line\n```\n\n```js``` is inline\n\n## Also real\r\n';

    assert.deepEqual(sections(text).map(({ heading }) => heading).sort(), ['Also real', 'Real']);
  });
});

describe('referenceName', () => {
  it("names a reference for a heading's first four words, without its step number", () => {
    assert.equal(referenceName('3. Run a session'), 'run-a-session.md');
    assert.equal(referenceName('Retries, reruns and infrastructure failures'), 'retries-reruns-and-infrastructure.md');
    assert.equal(referenceName('`—`'), 'detail.md');
  });
});

describe('problems', () => {
  const upstream = new Set(['vendor-ui']);
  const shape = { ...layout, upstreamPrefixes: ['acme-'] };

  it('passes docs at their budgets', () => {
    const docs = [
      { path: '.agents/skills/deploy/SKILL.md', text: skill('a'.repeat(budgets.description), budgets.skill) },
      { path: 'AGENTS.md', text: 'a'.repeat(budgets.rootAgents) },
      { path: 'apps/web/AGENTS.md', text: 'a'.repeat(budgets.agents) },
      { path: 'RULES.md', text: 'a'.repeat(budgets.rules) },
      { path: 'GLOSSARY.md', text: `# Glossary\n\n**Run**: ${'a'.repeat(budgets.glossaryEntry - 9)}\n` },
    ];

    assert.deepEqual(problems(docs, upstream, shape), []);
  });

  it('names each doc one past its budget', () => {
    const over = [
      { path: '.agents/skills/deploy/SKILL.md', text: skill('a'.repeat(budgets.description + 1)) },
      { path: '.agents/skills/review/SKILL.md', text: skill('Short.', budgets.skill + 1) },
      { path: 'AGENTS.md', text: 'a'.repeat(budgets.rootAgents + 1) },
      { path: 'apps/web/AGENTS.md', text: 'a'.repeat(budgets.agents + 1) },
      { path: 'RULES.md', text: 'a'.repeat(budgets.rules + 1) },
      { path: 'GLOSSARY.md', text: `**Run**: ${'a'.repeat(budgets.glossaryEntry - 8)}\n` },
    ];

    assert.deepEqual(
      problems(over, upstream, shape).map((problem) => problem.split(':')[0]),
      over.map(({ path }) => path),
    );
  });

  it('names the largest sections and says to move one word for word, not trim', () => {
    const text = skill('Short.') + '## 3. Run a session\n\n' + 'a'.repeat(budgets.skill) + '\n## Tail\n\nb\n';
    const found = problems([{ path: '.agents/skills/pip/SKILL.md', text }], upstream, shape);

    assert.equal(found.length, 1);
    assert.match(
      found[0] ?? '',
      /over 6\.0 KB\. Largest sections: "3\. Run a session" 6\.0 KB, "Tail" 0\.0 KB\. Move a section only one step or case needs, word for word, to \.agents\/skills\/pip\/references\/<topic>\.md \(for "3\. Run a session", run-a-session\.md\) or an existing reference on its topic, and leave one line in its place: "When <condition>, read \[<topic>\]\(references\/<file>\.md\)\." Don't reword to fit\. The agent-knowledge skill's references\/keeping-it-fresh\.md, "Thinning a skill", says how\.$/,
    );
    assert.doesNotMatch(found[0] ?? '', /create-skill/);
  });

  it('refuses a glossary table, and history in your own docs', () => {
    const docs = [
      { path: 'GLOSSARY.md', text: '| Term | Meaning |\n| --- | --- |\n' },
      { path: 'apps/web/AGENTS.md', text: 'Changed 15 Oct 2026: pages moved.\n' },
      { path: 'RULES.md', text: 'Decided 2 Nov 2026: one rule.\n' },
    ];
    const found = problems(docs, upstream, shape);

    assert.equal(found.length, 3);
    assert.match(found[0] ?? '', /^GLOSSARY\.md: has a table/);
    assert.match(found[1] ?? '', /^apps\/web\/AGENTS\.md: "Changed 15 Oct 2026" is history/);
    assert.match(found[2] ?? '', /^RULES\.md: "Decided 2 Nov 2026" is history/);
  });

  it('holds upstream copies to the description budget alone', () => {
    const big = budgets.skill + 1;
    const docs = [
      { path: '.agents/skills/vendor-ui/SKILL.md', text: skill('Short. Added 2 Oct 2026.', big) },
      { path: '.agents/skills/acme-queues/SKILL.md', text: skill('a'.repeat(budgets.description + 1), big) },
    ];
    const found = problems(docs, upstream, shape);

    assert.equal(found.length, 1);
    assert.match(found[0] ?? '', /^\.agents\/skills\/acme-queues\/SKILL\.md: its description is 321 characters/);
  });
});

describe('warnings', () => {
  const upstream = new Set(['vendor-ui']);
  const shape = { ...layout, upstreamPrefixes: ['acme-'] };

  it("warns past the warning line and within budget, for the repo's own skills alone", () => {
    const docs = [
      { path: '.agents/skills/pip/SKILL.md', text: skill('Short.', budgets.skillWarning) },
      { path: '.agents/skills/mo/SKILL.md', text: skill('Short.', budgets.skillWarning + 1) },
      { path: '.agents/skills/ada/SKILL.md', text: skill('Short.', budgets.skill + 1) },
      { path: '.agents/skills/vendor-ui/SKILL.md', text: skill('Short.', budgets.skillWarning + 1) },
      { path: '.agents/skills/acme-queues/SKILL.md', text: skill('Short.', budgets.skillWarning + 1) },
      { path: 'AGENTS.md', text: 'a'.repeat(budgets.skillWarning + 1) },
    ];
    const found = warnings(docs, upstream, shape);

    assert.equal(found.length, 1);
    assert.match(
      found[0] ?? '',
      /^\.agents\/skills\/mo\/SKILL\.md: 5\.0 KB, past the 5\.0 KB warning line\. Largest sections: none\. Move a section only one step or case needs, word for word, to \.agents\/skills\/mo\/references\/<topic>\.md or an existing reference/,
    );
  });

  it('follows the layout and limits it is given', () => {
    const docs = [{ path: 'skills/pip/SKILL.md', text: skill('Short.', 3_001) }];

    assert.equal(warnings(docs, new Set(), { ...layout, skillPath: /^skills\/([^/]+)\/SKILL\.md$/ }, { ...budgets, skillWarning: 3_000 }).length, 1);
    assert.deepEqual(warnings(docs, new Set()), []);
  });

  it('has no warning band when a copied CONFIG has no warning line, and still fails past the budget', () => {
    const { skillWarning: _none, ...old } = budgets;
    const docs = [
      { path: '.agents/skills/pip/SKILL.md', text: skill('Short.', 100) },
      { path: '.agents/skills/mo/SKILL.md', text: skill('Short.', budgets.skill) },
    ];

    assert.deepEqual(warnings(docs, new Set(), layout, old as typeof budgets), []);
    assert.equal(problems([{ path: '.agents/skills/ada/SKILL.md', text: skill('Short.', budgets.skill + 1) }], new Set(), layout, old as typeof budgets).length, 1);
  });
});

describe('docsBudget', () => {
  const repos: Array<string> = [];
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  /** A git repo whose tracked files are `files`, by path from its root. */
  const repo = (files: Readonly<Record<string, string>>) => {
    const root = mkdtempSync(join(tmpdir(), 'docs-budget-'));
    repos.push(root);

    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }

    execFileSync('git', ['init', '-q'], { cwd: root, env });
    execFileSync('git', ['add', '.'], { cwd: root, env });

    return root;
  };

  const big = skill('Short.', budgets.skill + 1);

  it("reads the repo it runs in, from any folder, and counts its own skills when there's no lock", () => {
    const root = repo({ 'AGENTS.md': 'Short.\n', '.agents/skills/vendor-ui/SKILL.md': big, 'docs/notes.md': 'Not a doc agents load.\n', 'docs/untracked.txt': '' });
    writeFileSync(join(root, 'docs', 'loose.md'), 'a'.repeat(budgets.rootAgents + 1));

    const { docs, problems: found } = docsBudget(join(root, 'docs'));

    assert.deepEqual(docs.map(({ path }) => path).sort(), ['.agents/skills/vendor-ui/SKILL.md', 'AGENTS.md', 'docs/notes.md']);
    assert.equal(found.length, 1);
    assert.match(found[0] ?? '', /^\.agents\/skills\/vendor-ui\/SKILL\.md: 6\.0 KB, over 6\.0 KB/);
  });

  it("leaves the lock's skills as their source wrote them", () => {
    const root = repo({ '.agents/skills/vendor-ui/SKILL.md': big, 'skills-lock.json': JSON.stringify({ version: 1, skills: { 'vendor-ui': { source: 'vendor/ui' } } }) });

    assert.deepEqual(docsBudget(root).problems, []);
  });

  it('exits 1 from the command, naming each problem, and 0 within budget or past only the warning line', () => {
    const script = fileURLToPath(new URL('docs-budget.ts', import.meta.url));
    const over = repo({ 'AGENTS.md': 'a'.repeat(budgets.rootAgents + 1) });
    const within = repo({ 'AGENTS.md': 'Short.\n' });
    const near = repo({ '.agents/skills/pip/SKILL.md': skill('Short.', budgets.skillWarning + 1) });

    const failed = spawnSync(process.execPath, [script], { cwd: over, encoding: 'utf8' });
    const passed = spawnSync(process.execPath, [script], { cwd: within, encoding: 'utf8' });
    const warned = spawnSync(process.execPath, [script], { cwd: near, encoding: 'utf8' });

    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /^AGENTS\.md: 12\.0 KB, over 12\.0 KB/);
    assert.equal(passed.status, 0);
    assert.equal(passed.stderr, 'docs-budget: 1 Markdown files within budget\n');
    assert.equal(warned.status, 0);
    assert.match(warned.stderr, /^warning: \.agents\/skills\/pip\/SKILL\.md: 5\.0 KB, past the 5\.0 KB warning line\. .*\ndocs-budget: 1 Markdown files within budget\n$/);
  });
});
