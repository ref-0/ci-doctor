/**
 * docs-budget.test.ts: each budget at and one past its limit, history lines, upstream copies, and
 * the command on a throwaway git repository.
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

import { budgets, description, docsBudget, layout, problems } from './docs-budget.ts';

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
    assert.match(found[0] ?? '', /^\.agents\/skills\/vendor-ui\/SKILL\.md: 10\.0 KB/);
  });

  it("leaves the lock's skills as their source wrote them", () => {
    const root = repo({ '.agents/skills/vendor-ui/SKILL.md': big, 'skills-lock.json': JSON.stringify({ version: 1, skills: { 'vendor-ui': { source: 'vendor/ui' } } }) });

    assert.deepEqual(docsBudget(root).problems, []);
  });

  it('exits 1 from the command, naming each problem, and 0 within budget', () => {
    const script = fileURLToPath(new URL('docs-budget.ts', import.meta.url));
    const over = repo({ 'AGENTS.md': 'a'.repeat(budgets.rootAgents + 1) });
    const within = repo({ 'AGENTS.md': 'Short.\n' });

    const failed = spawnSync(process.execPath, [script], { cwd: over, encoding: 'utf8' });
    const passed = spawnSync(process.execPath, [script], { cwd: within, encoding: 'utf8' });

    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /^AGENTS\.md: 12\.0 KB, over 12\.0 KB/);
    assert.equal(passed.status, 0);
    assert.equal(passed.stderr, 'docs-budget: 1 Markdown files within budget\n');
  });
});
