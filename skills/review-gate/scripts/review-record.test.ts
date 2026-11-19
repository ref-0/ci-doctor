/**
 * Tests for review-record.ts: each rule of the record at and one past its threshold, on synthetic
 * pull requests.
 *
 * Runs: anywhere, with `node --test review-record.test.ts` (Node 24). No network, no `gh`.
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  type Change,
  changesOf,
  coveredBy,
  DEFAULTS,
  isProductionSource,
  isTestCode,
  largeChange,
  lowRiskLines,
  memberComments,
  netProductionLines,
  readSession,
  readSettings,
  reviewerAssociations,
  verdict,
} from './review-record.ts';

const list = ['src/auth/*', 'migrations/*', '!src/auth/README.md'].join('\n');

const change = (filename: string, additions: number, deletions = 0): Change => ({ filename, additions, deletions });

const session = (lines: ReadonlyArray<string>) => lines.join('\n');

const covered = session([
  '## Review: Some Model, high, 2 reviewers, 1 round, clean at abc1234',
  '',
  'Reviewers: red team: token checks; system design: session leases',
  'Not run: stress test: no input parsing; storage: no tables; program design: no contract; bounded verification: no model covers it; fuzzing: no parser',
  '',
  'No findings.',
]);

describe('counting', () => {
  it('counts production source, not tests, fixtures, generated files or models', () => {
    ok(isProductionSource('src/auth/token.ts'));
    ok(!isProductionSource('src/auth/token.test.ts'));
    ok(!isProductionSource('src/testing/fake.ts'));
    ok(!isProductionSource('src/schema.gen.ts'));
    ok(!isProductionSource('pkg/verification/model.ts'));
    ok(!isProductionSource('README.md'));
    strictEqual(netProductionLines([change('src/a.ts', 310, 20), change('src/a.test.ts', 500)]), 290);
  });

  it('treats a move as net zero', () => {
    strictEqual(netProductionLines([change('src/old.ts', 0, 400), change('src/new.ts', 400)]), 0);
  });

  it('matches globs across folders, with ! lines taking a path off', () => {
    const matches = coveredBy(list);
    ok(matches('src/auth/deep/token.ts'));
    ok(!matches('src/auth/README.md'));
    ok(!matches('src/web/page.ts'));
    ok(isTestCode('src/a.test.ts'));
    ok(!isTestCode('src/types.gen.test.ts'));
  });

  it('reads numstat, binary files as zero', () => {
    deepStrictEqual(changesOf('3\t1\tsrc/a.ts\n-\t-\tlogo.png\n'), [change('src/a.ts', 3, 1), change('logo.png', 0, 0)]);
  });
});

describe('a session comment', () => {
  it('passes with every considered type run or not run, on a covered change', () => {
    deepStrictEqual(readSession(covered, true).problems, []);
  });

  it('fails when a considered type is neither run nor not run', () => {
    const missing = covered.replace('; fuzzing: no parser', '');
    ok(readSession(missing, true).problems.some((problem) => problem.includes('fuzzing')));
    deepStrictEqual(readSession(missing, false).problems, []);
  });

  it('fails when the Reviewers line disagrees with the count', () => {
    const wrong = covered.replace('2 reviewers', '3 reviewers');
    ok(readSession(wrong, false).problems.some((problem) => problem.includes('first line counts 3')));
  });

  it('refuses two types in one reviewer, and an unknown type by name', () => {
    const two = covered.replace('red team: token checks', 'red team and stress test: token checks');
    ok(readSession(two, false).problems.some((problem) => problem.includes('names the type "red team and stress test"')));
  });

  it('refuses a first line at another effort', () => {
    ok(readSession(covered.replace(', high,', ', medium,'), false).problems.some((problem) => problem.includes('first line')));
  });
});

describe('the verdict', () => {
  it('passes a body that says why there is no review, on an uncovered change', () => {
    const result = verdict({ comments: [], body: 'No review: docs only.', changes: [change('docs/a.md', 10)], list });
    ok(result.ok);
  });

  it('fails with nothing on record', () => {
    const result = verdict({ comments: [], body: '', changes: [change('docs/a.md', 10)], list });
    ok(!result.ok);
  });

  it('lets low risk cover covered files only up to the line limit', () => {
    const at = verdict({ comments: [], body: 'No review: low risk, a typo.', changes: [change('src/auth/token.ts', lowRiskLines, 0)], list });
    const past = verdict({ comments: [], body: 'No review: low risk, a typo.', changes: [change('src/auth/token.ts', lowRiskLines + 1, 0)], list });
    ok(at.ok);
    ok(!past.ok);
  });

  it('needs a code quality reviewer from the large-change count, even off the list', () => {
    const big = [change('src/web/page.ts', largeChange)];
    const under = [change('src/web/page.ts', largeChange - 1)];
    ok(!verdict({ comments: [], body: 'No review: not an important system.', changes: big, list }).ok);
    ok(verdict({ comments: [], body: 'No review: not an important system.', changes: under, list }).ok);

    const quality = session(['## Review: Some Model, high, 1 reviewer, 1 round, clean at abc1234', 'Reviewers: code quality: the page', 'No findings.']);
    ok(verdict({ comments: [quality], body: '', changes: big, list }).ok);
  });

  it('needs a tests reviewer for test code past the low-risk limit', () => {
    const tests = [change('src/a.test.ts', lowRiskLines + 1)];
    const none = session(['## Review: Some Model, high, 1 reviewer, 1 round, clean at abc1234', 'Reviewers: code quality: the page']);
    const withTests = session(['## Review: Some Model, high, 1 reviewer, 1 round, clean at abc1234', 'Reviewers: tests: the new cases']);
    ok(!verdict({ comments: [none], body: '', changes: tests, list }).ok);
    ok(verdict({ comments: [withTests], body: '', changes: tests, list }).ok);
    ok(!verdict({ comments: [], body: 'No review: low risk.', changes: tests, list }).ok);
    ok(verdict({ comments: [], body: 'No review: low risk.', changes: [change('src/a.test.ts', lowRiskLines)], list }).ok);
  });

  it('counts a file renamed away from a covered path', () => {
    const moved: Change = { filename: 'src/web/token.ts', previous_filename: 'src/auth/token.ts', additions: 40, deletions: 0 };
    ok(!verdict({ comments: [], body: 'No review: a move.', changes: [moved], list }).ok);
  });

  it('flags a comment that looks like a session but is not one', () => {
    const result = verdict({ comments: ['## Review: done, looks good'], body: 'No review: docs only.', changes: [change('docs/a.md', 1)], list });
    ok(!result.ok);
  });
});

describe('whose comments count', () => {
  const comment = (type: string, author_association: string, body: string) => ({ user: { type }, author_association, body });
  const page = [
    comment('User', 'OWNER', 'owner'),
    comment('User', 'MEMBER', 'member'),
    comment('User', 'COLLABORATOR', 'collaborator'),
    comment('User', 'CONTRIBUTOR', 'contributor'),
    comment('User', 'FIRST_TIME_CONTRIBUTOR', 'first time'),
    comment('User', 'NONE', 'anyone'),
    comment('Bot', 'MEMBER', 'a bot'),
  ];

  // This playbook's template, or the installed workflow at .agents/skills/review-gate/scripts/.
  const recheckPath = ['../../../templates/github/workflows/review-recheck.yml', '../../../../.github/workflows/review-recheck.yml']
    .map((path) => fileURLToPath(new URL(path, import.meta.url)))
    .find((path) => existsSync(path));

  it('matches the associations review-recheck.yml reruns for', () => {
    ok(recheckPath, 'review-recheck.yml is at neither path: run this from the ci-doctor repo, or from a repo that installed the workflow');
    const recheck = readFileSync(recheckPath, 'utf8');
    const listed = /contains\(fromJSON\('(\[[^\]]*\])'\), github\.event\.comment\.author_association\)/.exec(recheck);
    ok(listed, 'review-recheck.yml lists the associations it reruns for');
    deepStrictEqual([...(JSON.parse(listed[1] ?? '[]') as ReadonlyArray<string>)].sort(), [...reviewerAssociations].sort());
  });

  // gh's --jq runs this filter. jq runs the same language; without it on PATH, this case skips, and
  // the build checks count a skip as a failure.
  const jq = spawnSync('jq', ['--version'], { encoding: 'utf8' });
  it('keeps only members\' comments, and no bot\'s', { skip: jq.status === 0 ? false : 'jq is not on PATH' }, () => {
    const done = spawnSync('jq', ['-r', memberComments], { input: JSON.stringify(page), encoding: 'utf8' });
    strictEqual(done.status, 0, done.stderr);
    const bodies = done.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as string);
    deepStrictEqual(bodies, ['owner', 'member', 'collaborator']);
  });
});

describe('the settings', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const template = join(here, '..', '..', 'ci-doctor', 'references', 'agent-knowledge', 'repo-facts', 'review-record.json');

  it('has a template that holds every default', () => {
    deepStrictEqual(readSettings(template), DEFAULTS);
  });

  it('keeps the defaults without a settings file, applies a key it knows and refuses one it does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-record-'));
    try {
      deepStrictEqual(readSettings(join(dir, 'none.json')), DEFAULTS);
      writeFileSync(join(dir, 'ok.json'), JSON.stringify({ largeChange: 500 }));
      deepStrictEqual(readSettings(join(dir, 'ok.json')), { ...DEFAULTS, largeChange: 500 });
      writeFileSync(join(dir, 'bad.json'), JSON.stringify({ largechange: 500 }));
      let refused = '';
      try {
        readSettings(join(dir, 'bad.json'));
      } catch (error) {
        refused = String(error);
      }
      ok(/unknown settings largechange/.test(refused));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
