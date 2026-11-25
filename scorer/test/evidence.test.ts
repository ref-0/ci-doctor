import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evidenceOf, outsideCiOf, outsideConfigs, type EvidenceInputs } from '../src/evidence.ts';
import { expectedWait, flagCounts, LANGUAGE_WAIT, scoreOf } from '../src/score.ts';

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 20, 10, minutes)).toISOString();
const PUSHED = Date.parse(at(0));
const SOON = Date.parse(at(90));
const check = (slug: string, from: number | null, to: number | null) => ({ status: to === null ? 'in_progress' : 'completed', started_at: from === null ? null : at(from), completed_at: to === null ? null : at(to), app: { slug } });
const mark = (context: string, state: string, minute: number) => ({ context, state, created_at: at(minute) });
const DAY = 24 * 60;

describe('outsideConfigs', () => {
  it("finds another CI's config where that CI reads it, and names the file", () => {
    assert.deepEqual(outsideConfigs(['.github/workflows/ci.yml', 'eng/pipelines/ci.yml', '.circleci/config.yml', 'ci/Jenkinsfile', 'src/index.ts']), [
      { ci: 'Azure Pipelines', path: 'eng/pipelines/ci.yml' },
      { ci: 'CircleCI', path: '.circleci/config.yml' },
      { ci: 'Jenkins', path: 'ci/Jenkinsfile' },
    ]);
    assert.deepEqual(outsideConfigs(['azure-pipelines.yml', 'Jenkinsfile']).map((c) => c.ci), ['Azure Pipelines', 'Jenkins']);
    assert.deepEqual(outsideConfigs(['.azure-pipelines/build.yaml', 'Jenkinsfile.release']).map((c) => c.ci), ['Azure Pipelines', 'Jenkins']);
  });

  it("takes no file that only names a CI, no fixture, no page about one and no deploy's config", () => {
    const not = ['docs/azure-pipelines.md', 'test/fixtures/azure-pipelines.yml', 'eng/pipelines/README.md', 'Jenkinsfile.md', 'tools/Jenkinsfile.md', 'examples/Jenkinsfile', 'cloudbuild.yaml', 'buildspec.yml', 'src/.travis.yml', 'packages/app/.circleci/config.yml'];

    assert.deepEqual(outsideConfigs(not), []);
  });
});

describe('outsideCiOf', () => {
  it("takes another CI's end as its last check run's end, counted from the push", () => {
    const seen = outsideCiOf([check('azure-pipelines', 0, 40), check('azure-pipelines', 1, 72), check('github-actions', 0, 3)], [], PUSHED, SOON);

    assert.deepEqual(seen, [{ name: 'Azure Pipelines', minutes: 72 }]);
  });

  it('counts from the push, not from when the CI started: a short run that starts late still ends late', () => {
    assert.deepEqual(outsideCiOf([check('circleci-checks', 28, 40)], [], PUSHED, SOON), [{ name: 'CircleCI', minutes: 40 }]);
    assert.deepEqual(outsideCiOf([check('circleci-checks', 0, 10)], [], PUSHED, SOON), [{ name: 'CircleCI', minutes: 10 }]);
  });

  it('follows a later stage that starts as the one before it ends', () => {
    const seen = outsideCiOf([check('azure-pipelines', 0, 40), check('azure-pipelines', 44, 74)], [], PUSHED, SOON);

    assert.deepEqual(seen, [{ name: 'Azure Pipelines', minutes: 74 }]);
  });

  it("leaves out another event's checks on the same commit, such as a second pull request's a day later", () => {
    const again = check('azure-pipelines', DAY, DAY + 2);

    assert.deepEqual(outsideCiOf([check('azure-pipelines', 0, 2), again], [], PUSHED), [{ name: 'Azure Pipelines', minutes: 2 }]);
    assert.deepEqual(outsideCiOf([again], [], PUSHED), [{ name: 'Azure Pipelines', minutes: null }]);
  });

  it('takes work with no end as going until now on a fresh push, and as unknown on an old one', () => {
    for (const running of [check('circleci-checks', 0, null), check('circleci-checks', null, null)]) {
      assert.deepEqual(outsideCiOf([running], [], PUSHED, Date.parse(at(25))), [{ name: 'CircleCI', minutes: 25 }]);
      assert.deepEqual(outsideCiOf([running], [], PUSHED, Date.parse(at(3 * DAY))), [{ name: 'CircleCI', minutes: null }]);
    }
    const pending = [mark('continuous-integration/jenkins/pr-merge', 'pending', 1)];
    assert.deepEqual(outsideCiOf([], pending, PUSHED, Date.parse(at(60))), [{ name: 'Jenkins', minutes: 60 }]);
    assert.deepEqual(outsideCiOf([], pending, PUSHED, Date.parse(at(3 * DAY))), [{ name: 'Jenkins', minutes: null }]);
  });

  it("takes a status context's end as its first mark that isn't pending", () => {
    const context = 'continuous-integration/jenkins/pr-merge';

    assert.deepEqual(outsideCiOf([], [mark(context, 'success', 31), mark(context, 'pending', 1)], PUSHED, SOON), [{ name: 'Jenkins', minutes: 31 }]);
    assert.deepEqual(outsideCiOf([], [mark(context, 'success', 12)], PUSHED, SOON), [{ name: 'Jenkins', minutes: 12 }]);
  });

  it('makes no long run of two contexts marked far apart, or of marks from before the push', () => {
    const far = [mark('continuous-integration/jenkins/unit', 'success', 1), mark('continuous-integration/jenkins/nightly', 'success', 61)];
    const before = [mark('ci/circleci: build', 'success', -90), mark('ci/circleci: build', 'pending', -95)];

    assert.deepEqual(outsideCiOf([], far, PUSHED, SOON), [{ name: 'Jenkins', minutes: 1 }]);
    assert.deepEqual(outsideCiOf([], before, PUSHED, SOON), [{ name: 'CircleCI', minutes: null }]);
  });

  it('takes review bots, scanners, previews and licence checks as no CI', () => {
    const checks = ['github-actions', 'coderabbitai', 'vercel', 'socket-security', 'dco', 'blacksmith-sh', 'codecov', 'gitlab-review-bot', 'jenkins-preview'].map((slug) => check(slug, 0, 9));
    const statuses = ['license/cla', 'deploy/preview', 'jenkins-preview', 'pull-preview', 'pull-request-preview', 'ci/circleci: deploy-preview'].map((context) => mark(context, 'success', 4));

    assert.deepEqual(outsideCiOf(checks, statuses, PUSHED, SOON), []);
  });

  it('knows a Prow job by its name', () => {
    assert.deepEqual(outsideCiOf([], [mark('pull-kubernetes-e2e-gce', 'pending', 1), mark('pull-kubernetes-e2e-gce', 'success', 48)], PUSHED, SOON), [{ name: 'Prow', minutes: 48 }]);
  });
});

describe('evidenceOf', () => {
  const whole: EvidenceInputs = { timed: 60, p50: 6, rerunsUnread: 0, expectedWait: 8, linesOfCode: 40_000, measured: 1, missing: [], empty: [], sizedShare: 1, configs: [], treeTruncated: false, outside: { sampled: 3, read: 3, pushes: [] } };
  const push = (sha: string, actionsMin: number, minutes: number | null) => ({ sha, actionsMin, ci: [{ name: 'Azure Pipelines', minutes }] });
  const read = (pushes: EvidenceInputs['outside']['pushes']) => ({ sampled: 3, read: 3, pushes });

  it('is sure of a score with every measure made and no other CI seen', () => {
    const { thin, evidence } = evidenceOf(whole);

    assert.equal(thin, undefined);
    assert.equal(evidence.confidence, 'high');
    assert.deepEqual(evidence.reasons, []);
  });

  it('withholds the score when another CI was still running after the Actions checks on two sampled pushes', () => {
    const { thin, evidence } = evidenceOf({ ...whole, p50: 0.3, outside: read([push('a', 0.3, 72), push('b', 0.4, 70), push('c', 0.3, null)]) });

    assert.equal(thin, 'Pull requests here wait on Azure Pipelines, outside GitHub Actions: on 2 of 3 sampled pushes it was still running when the Actions checks finished, until at least 70 minutes after the push against 0.3 minutes at the median. The score reads only GitHub Actions.');
    assert.equal(evidence.confidence, null);
    assert.deepEqual(evidence.reasons, []);
    assert.equal(evidence.outsideCi.pushes.length, 3);
  });

  it('keeps the score when the Actions checks finished last, however long the other CI ran', () => {
    // Actions waited in a queue and ended at minute 35; the other CI ended at minute 10, then at 35.5.
    const { thin, evidence } = evidenceOf({ ...whole, p50: 35, expectedWait: 30, outside: read([push('a', 35, 10), push('b', 35, 35.5), push('c', 6, 9)]) });

    assert.equal(thin, undefined);
    assert.equal(evidence.confidence, 'medium');
    assert.deepEqual(evidence.reasons, ["Azure Pipelines also ran on 3 of 3 sampled pushes, which the score doesn't read"]);
  });

  it('names only the CIs pull requests waited on, and says one minute as one', () => {
    const both = (sha: string) => ({ sha, actionsMin: 0.96, ci: [{ name: 'Azure Pipelines', minutes: 60 }, { name: 'CircleCI', minutes: 1 }] });
    const two = (sha: string) => ({ sha, actionsMin: 0.96, ci: [{ name: 'Azure Pipelines', minutes: 60 }, { name: 'Buildkite', minutes: 45 }] });

    assert.match(evidenceOf({ ...whole, outside: read([both('a'), both('b')]) }).thin!, /^Pull requests here wait on Azure Pipelines, outside GitHub Actions: on 2 of 3 sampled pushes it was still running when the Actions checks finished, until at least 60 minutes after the push against 1 minute at the median\./);
    assert.match(evidenceOf({ ...whole, outside: read([two('a'), two('b')]) }).thin!, /^Pull requests here wait on Azure Pipelines and Buildkite, outside GitHub Actions: on 2 of 3 sampled pushes they were still running when/);
  });

  it("withholds the score when the repo keeps another CI's config and its Actions checks are small for its size", () => {
    const configs = [{ ci: 'Azure Pipelines', path: 'azure-pipelines.yml' }];
    const small = evidenceOf({ ...whole, p50: 1.3, expectedWait: 26, linesOfCode: 4_368_071, configs });
    const fair = evidenceOf({ ...whole, p50: 3, expectedWait: 26, linesOfCode: 4_368_071, configs });
    const tiny = evidenceOf({ ...whole, p50: 0.1, expectedWait: 2, linesOfCode: 412, configs });

    assert.match(small.thin!, /keeps a config for Azure Pipelines \(`azure-pipelines\.yml`\).*a wait of 1\.3 minutes, where about 26 minutes is typical for 4,368,000 lines\./);
    assert.match(tiny.thin!, /is typical for 412 lines\./);
    assert.equal(fair.thin, undefined);
    assert.equal(fair.evidence.confidence, 'high');
  });

  it('withholds the score when none of a part could be measured, whichever part', () => {
    const made = { p50: 4, p90: 9, linesOfCode: 40_000, passedOnRerunRate: 0.02, mainRedRate: 0.1, vcpuMinutesPerMergedPr: 120, runsPerMergedPr: 8, setupMinPerJob: 0.4, queueP90Sec: 12, shardIdleTail: NaN, pathFlags: 0, graphFlags: NaN };
    const noEfficiency = scoreOf({ ...made, vcpuMinutesPerMergedPr: NaN, runsPerMergedPr: NaN, setupMinPerJob: NaN, queueP90Sec: NaN, pathFlags: NaN });
    // Shard balance and the package graph's flags are known, and they don't stand for the part: only some repos have them.
    const shardsOnly = scoreOf({ ...made, vcpuMinutesPerMergedPr: NaN, runsPerMergedPr: NaN, setupMinPerJob: NaN, queueP90Sec: NaN, pathFlags: NaN, shardIdleTail: 0.2, graphFlags: 1 });
    const noReliability = scoreOf({ ...made, passedOnRerunRate: NaN, mainRedRate: NaN });
    const reason = 'Too little of the score\'s efficiency part could be measured to score: none of vCPU-minutes per merged PR, runs per merged PR, setup time, queue time or how the jobs are wired.';

    assert.equal(noEfficiency.measured, 0.8);
    assert.deepEqual([noEfficiency.empty, shardsOnly.empty, noReliability.empty, scoreOf(made).empty], [['efficiency'], ['efficiency'], ['reliability'], []]);
    assert.equal(evidenceOf({ ...whole, ...noEfficiency }).thin, reason);
    assert.equal(evidenceOf({ ...whole, ...shardsOnly }).thin, reason);
    assert.equal(evidenceOf({ ...whole, ...noReliability }).thin, "Too little of the score's reliability part could be measured to score: none of the share of pushes green only on a rerun or the default branch's red rate.");
  });

  it('is less sure with few pushes, a measure missing or reruns unread, and says each', () => {
    const { measured, missing, empty } = scoreOf({ p50: 4, p90: 9, linesOfCode: 40_000, passedOnRerunRate: 0.02, mainRedRate: NaN, vcpuMinutesPerMergedPr: 120, runsPerMergedPr: 8, setupMinPerJob: 0.4, queueP90Sec: 12, shardIdleTail: NaN, pathFlags: 0, graphFlags: NaN });
    const { evidence } = evidenceOf({ ...whole, timed: 14, rerunsUnread: 2, measured, missing, empty });

    assert.deepEqual(missing, ['reliability.mainRed']);
    assert.equal(evidence.confidence, 'medium');
    assert.deepEqual(evidence.reasons, ['14 pushes were timed, under 20', "the default branch's red rate couldn't be measured", "2 reruns' first attempts weren't read"]);
    assert.equal(evidenceOf({ ...whole, timed: 7 }).evidence.confidence, 'low');
  });

  it('is low under 80% measured, by the share itself and not its rounding', () => {
    // Speed and flakes made; the default branch's red rate, vCPU-minutes, queue time and the job graph not: 79.7%.
    const { measured, missing, empty } = scoreOf({ p50: 4, p90: 9, linesOfCode: 40_000, passedOnRerunRate: 0.02, mainRedRate: NaN, vcpuMinutesPerMergedPr: NaN, runsPerMergedPr: 8, setupMinPerJob: 0.4, queueP90Sec: NaN, shardIdleTail: NaN, pathFlags: NaN, graphFlags: NaN });
    const { evidence } = evidenceOf({ ...whole, measured, missing, empty });

    assert.ok(measured < 0.8 && measured > 0.795, String(measured));
    assert.equal(evidence.measured, 0.8);
    assert.equal(evidence.confidence, 'low');
  });

  it("says it couldn't read the other checks, on all the pushes or on some, which is unknown, not absent", () => {
    const configs = [{ ci: 'CircleCI', path: '.circleci/config.yml' }];
    const none = evidenceOf({ ...whole, configs, outside: { sampled: 3, read: 0, pushes: [] } });
    const some = evidenceOf({ ...whole, outside: { sampled: 3, read: 1, pushes: [] } });

    assert.equal(none.thin, undefined);
    assert.deepEqual(none.evidence.reasons, ["checks from outside GitHub Actions couldn't be read, and the repo keeps a config for CircleCI"]);
    assert.equal(some.evidence.confidence, 'medium');
    assert.deepEqual(some.evidence.reasons, ["checks from outside GitHub Actions couldn't be read on 2 of 3 sampled pushes"]);
  });

  it("is less sure when under half the job minutes ran on runners of a known size, by the share it shows", () => {
    const reasons = (sizedShare: number, missing: string[] = []) => evidenceOf({ ...whole, sizedShare, missing }).evidence.reasons;

    assert.deepEqual(reasons(0.49), ["the runners' sizes are known for 49% of job minutes, and the rest count as standard runners"]);
    assert.equal(evidenceOf({ ...whole, sizedShare: 0.49 }).evidence.confidence, 'medium');
    // 49.6% shows as 50%, which isn't under half; and no job sampled is no share at all.
    assert.deepEqual([reasons(0.496), reasons(0.5), reasons(NaN)], [[], [], []]);
    // The sizes changed no score where the minutes weren't scored.
    assert.deepEqual(reasons(0, ['efficiency.minutesPerPr']), ["vCPU-minutes per merged PR couldn't be measured"]);
  });

  it("says a file tree cut short may hide another CI's config, when the Actions checks are small for the repo's size", () => {
    const cut = evidenceOf({ ...whole, p50: 1.3, expectedWait: 26, treeTruncated: true });

    assert.equal(cut.thin, undefined);
    assert.deepEqual(cut.evidence.reasons, ["GitHub cut the file tree short, so another CI's config may be past the cut"]);
    assert.deepEqual(evidenceOf({ ...whole, treeTruncated: true }).evidence.reasons, []);
  });
});

describe("scoreOf's measured share", () => {
  const all = { p50: 4, p90: 9, linesOfCode: 40_000, passedOnRerunRate: 0.02, mainRedRate: 0.1, vcpuMinutesPerMergedPr: 120, runsPerMergedPr: 8, setupMinPerJob: 0.4, queueP90Sec: 12, shardIdleTail: NaN, pathFlags: 0, graphFlags: NaN };

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

    assert.equal(Math.round(measured * 100), 92);
    assert.deepEqual(missing, ['reliability.mainRed']);
  });
});

describe("scoreOf's weights", () => {
  const best = { p50: 2, p90: 4, linesOfCode: 40_000, passedOnRerunRate: 0, mainRedRate: 0, vcpuMinutesPerMergedPr: 10, runsPerMergedPr: 3, setupMinPerJob: 0.2, queueP90Sec: 5, shardIdleTail: NaN, pathFlags: 0, graphFlags: NaN };

  it('weighs speed 60, reliability 20 and efficiency 20', () => {
    const slow = scoreOf({ ...best, p50: 600, p90: 900 });
    const flaky = scoreOf({ ...best, passedOnRerunRate: 0.5, mainRedRate: 0.9 });
    const wasteful = scoreOf({ ...best, vcpuMinutesPerMergedPr: 1e6, runsPerMergedPr: 500, setupMinPerJob: 30, queueP90Sec: 3600, pathFlags: 3 });

    assert.equal(scoreOf(best).score, 100);
    assert.deepEqual([slow.parts.speed, slow.score], [0, 40]);
    assert.deepEqual([flaky.parts.reliability, flaky.score], [0, 80]);
    assert.deepEqual([wasteful.parts.efficiency, wasteful.score], [0, 80]);
  });

  it('takes a third off the job graph for each kind of flag, and counts it missing when unread', () => {
    const path = (pathFlags: number) => scoreOf({ ...best, pathFlags }).detail.efficiency!.path;

    assert.deepEqual([path(0), path(1), path(2), path(3)], [100, 67, 33, 0]);
    assert.deepEqual(scoreOf({ ...best, pathFlags: NaN }).missing, ['efficiency.path']);
  });

  it('takes a quarter off the package and task graphs for each kind of flag, only for a repo that has them', () => {
    const graphs = (graphFlags: number) => scoreOf({ ...best, graphFlags }).detail.efficiency!.graphs;

    assert.deepEqual([graphs(0), graphs(1), graphs(2), graphs(4), graphs(7)], [100, 75, 50, 0, 0]);
    assert.deepEqual([scoreOf(best).detail.efficiency!.graphs, scoreOf(best).missing, scoreOf(best).measured], [null, [], 1]);
    assert.ok(scoreOf({ ...best, graphFlags: 2 }).score < 100);
  });

  it("is easier on a slow-building language's wait for its size, and harder on a quick one's", () => {
    const forSize = (language?: string) => scoreOf({ ...best, p50: 12, language }).detail.speed!.forSize!;

    assert.ok(forSize('C') > forSize() && forSize() > forSize('PHP'), `${forSize('C')}, ${forSize()}, ${forSize('PHP')}`);
    assert.equal(forSize('Brainfuck'), forSize());
    // A name every object has is no language's factor.
    assert.equal(expectedWait(100_000, 'constructor'), expectedWait(100_000));
    assert.equal(expectedWait(100_000, 'C'), expectedWait(100_000) * LANGUAGE_WAIT.C!);
  });
});

describe('flagCounts', () => {
  const section = (kinds: string[] = [], unknown: string[] = []) => ({ flags: kinds.map((kind) => ({ kind })), unknown });
  type Section = ReturnType<typeof section>;
  // runs: the sampled runs that fit today's workflows; undecided: entries unread, or that importers not seen could still flag.
  const graphs = (o: { jobs?: Section | null; runs?: number; packages?: Section; exports?: Section; tasks?: Section; nodes?: number; undecided?: number; cached?: number; unknown?: string[] } = {}) => ({
    jobs: o.jobs === null ? null : { ...(o.jobs ?? section()), count: { runs: o.runs ?? 3 } },
    packages: { ...(o.packages ?? section()), count: { nodes: o.nodes ?? 5 } },
    exports: { ...(o.exports ?? section()), count: { undecided: o.undecided ?? 0 } },
    tasks: { ...(o.tasks ?? section()), count: { cached: o.cached ?? 0 } },
    unknown: o.unknown ?? [],
  });

  it('counts kinds of flag, not flags', () => {
    const found = flagCounts(graphs({ jobs: section(['top-blocker', 'setup-in-path']), exports: section(['root-barrel', 'root-barrel', 'overloaded-entry']), tasks: section(['no-inputs']) }));

    assert.deepEqual(found, { pathFlags: 2, graphFlags: 3 });
  });

  it('is clean only where everything was read', () => {
    assert.deepEqual(flagCounts(graphs()), { pathFlags: 0, graphFlags: 0 });
    assert.deepEqual(flagCounts(graphs({ jobs: section([], ["a workflow file couldn't be read"]), undecided: 2 })), { pathFlags: NaN, graphFlags: NaN });
    assert.deepEqual(flagCounts(graphs({ jobs: section(['hidden-wait'], ["a workflow file couldn't be read"]), exports: section(['root-barrel']), undecided: 2 })), { pathFlags: 1, graphFlags: 1 });
    // No sampled run fits today's workflows: no flag could have been raised.
    assert.ok(Number.isNaN(flagCounts(graphs({ runs: 0 })).pathFlags));
    // The packages, the tasks, or the read as a whole partly unknown.
    for (const partly of [{ packages: section([], ['a manifest was not read']) }, { tasks: section([], ['a task config was not read']) }, { unknown: ['Read the first 300 of 412 task config files'] }])
      assert.ok(Number.isNaN(flagCounts(graphs(partly)).graphFlags), JSON.stringify(partly));
  });

  it("takes a note on the entries for unknown only when an entry is undecided", () => {
    const bounded = section([], ['2 entries of 2 belong to packages with more than one entry']);

    assert.equal(flagCounts(graphs({ exports: bounded })).graphFlags, 0);
    assert.ok(Number.isNaN(flagCounts(graphs({ exports: bounded, undecided: 1 })).graphFlags));
  });

  it('ignores a kind of flag the score has no measure for', () => {
    assert.deepEqual(flagCounts(graphs({ jobs: section(['a-new-kind']), tasks: section(['another-new-kind']) })), { pathFlags: 0, graphFlags: 0 });
  });

  it('has no job graph count without a job graph, and no other count for a repo with nothing to read', () => {
    assert.ok(Number.isNaN(flagCounts(graphs({ jobs: null })).pathFlags));
    assert.ok(Number.isNaN(flagCounts(graphs({ nodes: 1 })).graphFlags));
    assert.equal(flagCounts(graphs({ nodes: 1, cached: 2 })).graphFlags, 0);
    // A flag found counts even there: a single package's uncached scripts can still form a cycle.
    assert.equal(flagCounts(graphs({ nodes: 1, tasks: section(['task-cycle']) })).graphFlags, 1);
  });
});
