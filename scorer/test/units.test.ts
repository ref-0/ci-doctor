import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { baseDir } from '../src/paths.ts';
import { parseGitHubUrl } from '../src/repo.ts';
import { practices } from '../src/score.ts';
import { standingBody } from '../src/standing.ts';

describe('parseGitHubUrl', () => {
  for (const url of [
    'git@github.com:pip/app.git',
    'git@github.com:pip/app',
    'https://github.com/pip/app.git',
    'https://github.com/pip/app',
    'https://github.com/pip/app/',
    'https://token@github.com/pip/app.git',
    'ssh://git@github.com/pip/app.git',
    'ssh://git@github.com:22/pip/app.git',
    'git+https://github.com/pip/app.git',
    'git@GitHub.com:pip/app.git',
  ])
    it(`reads ${url}`, () => assert.equal(parseGitHubUrl(url), 'pip/app'));

  for (const url of ['git@gitlab.com:pip/app.git', 'https://github.example.com/pip/app', 'https://github.com/pip', '/srv/git/app.git', 'https://github.com/pip/../x'])
    it(`ignores ${url}`, () => assert.equal(parseGitHubUrl(url), undefined));
});

describe('baseDir', () => {
  it('is outside npm and per platform', () => {
    assert.equal(baseDir({}, 'linux', '/home/pip'), join('/home/pip', '.cache', 'ci-doctor'));
    assert.equal(baseDir({ XDG_CACHE_HOME: '/c' }, 'linux', '/home/pip'), join('/c', 'ci-doctor'));
    assert.equal(baseDir({}, 'darwin', '/Users/pip'), join('/Users/pip', 'Library', 'Caches', 'ci-doctor'));
    assert.equal(baseDir({ LOCALAPPDATA: 'C:\\Users\\pip\\AppData\\Local' }, 'win32', 'C:\\Users\\pip'), join('C:\\Users\\pip\\AppData\\Local', 'ci-doctor'));
    assert.equal(baseDir({ CI_DOCTOR_CACHE_DIR: '/x' }, 'linux', '/home/pip'), '/x');
  });
});

describe('standingBody', () => {
  it('holds only the score and size, whatever it is handed', () => {
    const report = { score: 81, size: 'medium', repo: 'pip/app', profile: { linesOfCode: 1 } };
    assert.equal(standingBody(report), '{"score":81,"size":"medium"}');
  });
});

describe('practices', () => {
  const of = (files: Record<string, string>) =>
    practices({ tree: { truncated: false, blobs: Object.keys(files).map((path) => ({ path, size: 1 })) }, read: (path) => files[path] } as Parameters<typeof practices>[0]);

  it('takes Vite+ for Oxlint and Vitest, which it bundles', () => {
    const found = of({ 'package.json': JSON.stringify({ devDependencies: { 'vite-plus': '1.7.0', eslint: '9.0.0' } }) });
    assert.equal(found.fastLint, true);
    assert.equal(found.testRunner, 'vitest');
    assert.equal(found.taskRunner, 'vite-plus');
  });

  it('takes Renovate as batching only when its config groups updates or holds them to a schedule', () => {
    assert.equal(of({ 'renovate.json': '{ "extends": ["config:recommended"] }' }).depBotsBatched, true);
    assert.equal(of({ '.github/renovate.json5': '{ packageRules: [{ groupName: "lint" }] }' }).depBotsBatched, true);
    assert.equal(of({ 'renovate.json': '{ "enabled": true }' }).depBotsBatched, false);
    assert.equal(of({ '.github/dependabot.yml': 'updates:\n  - groups:\n      all: {}\n' }).depBotsBatched, true);
    assert.equal(of({ 'package.json': '{}' }).depBotsBatched, false);
  });

  it("takes Oxlint's TypeScript config", () => {
    assert.equal(of({ 'package.json': '{}', 'oxlint.config.ts': '' }).fastLint, true);
    assert.equal(of({ 'package.json': '{}' }).fastLint, false);
  });
});
