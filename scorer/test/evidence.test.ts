import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evidenceOf, outsideCiOf, outsideConfigs, type EvidenceInputs } from '../src/evidence.ts';
import { scoreOf } from '../src/score.ts';

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 20, 10, minutes)).toISOString();
const check = (slug: string, from: number, to: number | null) => ({ status: to === null ? 'in_progress' : 'completed', started_at: at(from), completed_at: to === null ? null : at(to), app: { slug } });

describe('outsideConfigs', () => {
  it("finds another CI's config, and names the file", () => {
    assert.deepEqual(outsideConfigs(['.github/workflows/ci.yml', 'eng/pipelines/ci.yml', '.circleci/config.yml', 'src/index.ts']), [
      { ci: 'Azure Pipelines', path: 'eng/pipelines/ci.yml' },
      { ci: 'CircleCI', path: '.circleci/config.yml' },
    ]);
  });

  it("takes no file that only names a CI, and no deploy's config", () => {
    assert.deepEqual(outsideConfigs(['docs/azure-pipelines.md', 'tools/Jenkinsfile.md', 'cloudbuild.yaml', 'buildspec.yml', 'src/.travis.yml']), []);
  });
});

describe('outsideCiOf', () => {
  it("times another CI's check runs from the first start to the last end", () => {
    const seen = outsideCiOf([check('azure-pipelines', 0, 40), check('azure-pipelines', 1, 72), check('github-actions', 0, 3)], []);

    assert.deepEqual(seen, [{ name: 'Azure Pipelines', minutes: 72 }]);
  });

  it('takes a run still going as having run until now', () => {
    const seen = outsideCiOf([check('circleci-checks', 0, null)], [], Date.parse(at(25)));

    assert.deepEqual(seen, [{ name: 'CircleCI', minutes: 25 }]);
  });

  it('times commit statuses from the pending one to the one that ended it', () => {
    const statuses = [
      { context: 'continuous-integration/jenkins/pr-merge', state: 'success', created_at: at(31) },
      { context: 'continuous-integration/jenkins/pr-merge', state: 'pending', created_at: at(1) },
    ];

    assert.deepEqual(outsideCiOf([], statuses), [{ name: 'Jenkins', minutes: 30 }]);
    assert.deepEqual(outsideCiOf([], statuses.slice(0, 1)), [{ name: 'Jenkins', minutes: null }]);
  });

  it('takes review bots, scanners, previews and licence checks as no CI', () => {
    const checks = ['github-actions', 'coderabbitai', 'vercel', 'socket-security', 'dco', 'blacksmith-sh', 'codecov'].map((slug) => check(slug, 0, 9));
    const statuses = [{ context: 'license/cla', state: 'success', created_at: at(0) }, { context: 'deploy/preview', state: 'success', created_at: at(4) }];

    assert.deepEqual(outsideCiOf(checks, statuses), []);
  });
});

describe('evidenceOf', () => {
  const whole: EvidenceInputs = { timed: 60, p50: 6, rerunsUnread: 0, expectedWait: 8, linesOfCode: 40_000, measured: 1, missing: [], sizedShare: 1, configs: [], outside: { read: 3, pushes: [] } };
  const push = (sha: string, actionsMin: number, minutes: number | null) => ({ sha, actionsMin, ci: [{ name: 'Azure Pipelines', minutes }] });

  it('is sure of a score with every measure made and no other CI seen', () => {
    const { thin, evidence } = evidenceOf(whole);

    assert.equal(thin, undefined);
    assert.equal(evidence.confidence, 'high');
    assert.deepEqual(evidence.reasons, []);
  });

  it('withholds the score when another CI ran longer than the Actions checks on two sampled pushes', () => {
    const { thin, evidence } = evidenceOf({ ...whole, p50: 0.3, outside: { read: 3, pushes: [push('a', 0.3, 72), push('b', 0.4, 70), push('c', 0.3, null)] } });

    assert.match(thin!, /^Pull requests here wait on Azure Pipelines, outside GitHub Actions: on 2 of 3 sampled pushes it ran longer than the Actions checks, 70 minutes against 0\.3 minutes at the median\. The score reads only GitHub Actions\.$/);
    assert.equal(evidence.confidence, null);
    assert.deepEqual(evidence.reasons, []);
    assert.equal(evidence.outsideCi.pushes.length, 3);
  });

  it('keeps the score, less sure, when another CI ran no longer than the Actions checks', () => {
    const { thin, evidence } = evidenceOf({ ...whole, outside: { read: 3, pushes: [push('a', 6, 4), push('b', 7, 5), push('c', 6, 9)] } });

    assert.equal(thin, undefined);
    assert.equal(evidence.confidence, 'medium');
    assert.deepEqual(evidence.reasons, ["Azure Pipelines also ran on 3 of 3 sampled pushes, which the score doesn't read"]);
  });

  it("withholds the score when the repo keeps another CI's config and its Actions checks are small for its size", () => {
    const configs = [{ ci: 'Azure Pipelines', path: 'azure-pipelines.yml' }];
    const small = evidenceOf({ ...whole, p50: 1.3, expectedWait: 26, linesOfCode: 4_368_071, configs });
    const fair = evidenceOf({ ...whole, p50: 3, expectedWait: 26, linesOfCode: 4_368_071, configs });

    assert.match(small.thin!, /keeps a config for Azure Pipelines \(`azure-pipelines\.yml`\).*a wait of 1\.3 minutes, where about 26 minutes is typical for 4,368,000 lines\./);
    assert.equal(fair.thin, undefined);
    assert.equal(fair.evidence.confidence, 'high');
  });

  it('withholds the score when a whole part went unmeasured', () => {
    const { measured, missing } = scoreOf({ p50: 4, p90: 9, linesOfCode: 40_000, passedOnRerunRate: 0.02, mainRedRate: 0.1, vcpuMinutesPerMergedPr: NaN, runsPerMergedPr: NaN, setupMinPerJob: NaN, queueP90Sec: NaN, shardIdleTail: NaN });
    const { thin } = evidenceOf({ ...whole, measured, missing });

    assert.equal(measured, 0.8);
    assert.match(thin!, /^None of the score's efficiency measures could be made \(minutes per merged PR, runs per merged PR, setup time and queue time\), so there's too little to score\.$/);
  });

  it('is less sure with few pushes, a measure missing or reruns unread, and says each', () => {
    const { measured, missing } = scoreOf({ p50: 4, p90: 9, linesOfCode: 40_000, passedOnRerunRate: 0.02, mainRedRate: NaN, vcpuMinutesPerMergedPr: 120, runsPerMergedPr: 8, setupMinPerJob: 0.4, queueP90Sec: 12, shardIdleTail: NaN });
    const { evidence } = evidenceOf({ ...whole, timed: 14, rerunsUnread: 2, measured, missing });

    assert.deepEqual(missing, ['reliability.mainRed']);
    assert.equal(evidence.confidence, 'medium');
    assert.deepEqual(evidence.reasons, ['14 pushes were timed, under 20', "the default branch's red rate couldn't be measured", "2 reruns' first attempts weren't read"]);
    assert.equal(evidenceOf({ ...whole, timed: 7 }).evidence.confidence, 'low');
  });

  it("says it couldn't read the other checks, which is unknown, not absent", () => {
    const { thin, evidence } = evidenceOf({ ...whole, configs: [{ ci: 'CircleCI', path: '.circleci/config.yml' }], outside: { read: 0, pushes: [] } });

    assert.equal(thin, undefined);
    assert.deepEqual(evidence.reasons, ["checks from outside GitHub Actions couldn't be read, and the repo keeps a config for CircleCI"]);
  });
});

describe("scoreOf's measured share", () => {
  const all = { p50: 4, p90: 9, linesOfCode: 40_000, passedOnRerunRate: 0.02, mainRedRate: 0.1, vcpuMinutesPerMergedPr: 120, runsPerMergedPr: 8, setupMinPerJob: 0.4, queueP90Sec: 12, shardIdleTail: NaN };

  it('is whole without shards, which only a repo that has them is measured on', () => {
    assert.deepEqual([scoreOf(all).measured, scoreOf(all).missing], [1, []]);
    assert.deepEqual([scoreOf({ ...all, shardIdleTail: 0.2 }).measured, scoreOf({ ...all, shardIdleTail: 0.2 }).missing], [1, []]);
  });

  it('gives setup full marks at 30 seconds a job and none at 4 minutes', () => {
    const setup = (setupMinPerJob: number) => scoreOf({ ...all, setupMinPerJob }).detail.efficiency!.setup;

    assert.deepEqual([setup(0.2), setup(0.5), setup(4), setup(9)], [100, 100, 0, 0]);
    assert.ok(setup(1)! > setup(2)! && setup(2)! > 0);
  });

  it("drops by a missing measure's share of its part", () => {
    const { measured, missing } = scoreOf({ ...all, mainRedRate: NaN });

    assert.equal(measured, 0.92);
    assert.deepEqual(missing, ['reliability.mainRed']);
  });
});
