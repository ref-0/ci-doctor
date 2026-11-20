import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ApiJob, graphBlock, graphFixes, jobGraphOf, matrixValues, parseYaml, promptLines, runGraph, workflowGraph } from '../src/job-graph.ts';

const T0 = Date.parse('2026-11-19T10:00:00Z');
const at = (min: number) => new Date(T0 + min * 60e3).toISOString();
let nextId = 1;
/** A job created at `created`, given a runner at `start` and done at `end`, in minutes from the run's start. */
const job = (name: string, created: number, start: number, end: number, steps: [string, number, number][] = []): ApiJob => ({
  id: nextId++,
  name,
  conclusion: 'success',
  created_at: at(created),
  started_at: at(start),
  completed_at: at(end),
  steps: steps.map(([n, a, b]) => ({ name: n, started_at: at(a), completed_at: at(b), conclusion: 'success' })),
});
const skipped = (name: string): ApiJob => ({ id: nextId++, name, conclusion: 'skipped', created_at: at(0), started_at: null, completed_at: null });
const graphOf = (yaml: string, files: Record<string, string> = {}) => workflowGraph('.github/workflows/ci.yml', yaml, (p) => files[p]);
const close = (a: number | null | undefined, b: number) => assert.ok(a !== null && a !== undefined && Math.abs(a - b) < 0.01, `${a} ≈ ${b}`);

describe('parseYaml', () => {
  it('reads what workflow files use', () => {
    const doc = parseYaml(`name: CI # a comment
on:
  pull_request:
    branches: [main, "release/*"]
env: &env
  A: 'it''s'
jobs:
  build:
    runs-on: \${{ matrix.os }}
    needs:
    - lint
    - "types"
    if: github.event_name == 'push' &&
      github.ref == 'refs/heads/main'
    strategy:
      matrix: { os: [ubuntu-latest, macos-latest], node: [22] }
    steps:
      - uses: actions/checkout@v4
      - name: Test
        run: |
          pnpm test # not a comment
          echo done
  other:
    <<: *env
    B: x
`) as any;
    assert.equal(doc.name, 'CI');
    assert.deepEqual(doc.on.pull_request.branches, ['main', 'release/*']);
    assert.deepEqual(doc.jobs.build.needs, ['lint', 'types']);
    assert.equal(doc.jobs.build.if, "github.event_name == 'push' && github.ref == 'refs/heads/main'");
    assert.deepEqual(doc.jobs.build.strategy.matrix, { os: ['ubuntu-latest', 'macos-latest'], node: ['22'] });
    assert.equal(doc.jobs.build.steps[1].name, 'Test');
    assert.equal(doc.jobs.build.steps[1].run, 'pnpm test # not a comment\necho done');
    assert.equal(doc.jobs.build['runs-on'], '${{ matrix.os }}');
    assert.deepEqual(doc.jobs.other, { A: "it's", B: 'x' });
  });
});

describe('a workflow file that starts with a byte-order mark', () => {
  it('keeps its jobs', () => {
    const g = workflowGraph('.github/workflows/ci.yml', '\uFEFFname: CI\njobs:\n  a: {}\n  b: { needs: a }\n', () => undefined);
    assert.deepEqual(g.jobs.map((j) => [j.key, j.needs]), [['a', []], ['b', ['a']]]);
  });
});

describe('a diamond graph', () => {
  const graph = graphOf(`jobs:
  a: { runs-on: x }
  b: { needs: a }
  c:
    needs: [a]
  d:
    needs: [b, c]
`);
  // a 0–3, then b 3–5 and c 3–8 side by side, then d 8–9.
  const jobs = [
    job('a', 0, 0, 3, [['Set up job', 0, 0.5]]),
    job('b', 3, 3, 5),
    job('c', 3, 3, 8, [['Set up job', 3, 3.5], ['Run pnpm install', 3.5, 4.5], ['Run tests', 4.5, 8]]),
    job('d', 8, 8, 9),
  ];
  const run = runGraph(graph, jobs)!;

  it('reads the needs', () => assert.deepEqual(graph.jobs.map((j) => [j.key, j.needs]), [['a', []], ['b', ['a']], ['c', ['a']], ['d', ['b', 'c']]]));

  it('takes the chain that ends last, through the need that finished last', () => {
    assert.deepEqual(run.path.map((l) => l.name), ['a', 'c', 'd']);
    assert.deepEqual(run.path.map((l) => Math.round(l.share * 9)), [3, 5, 1]);
    assert.equal(run.end, 'd');
    assert.equal(run.spanMin, 9);
  });

  it('parts blocked from queue and work', () => {
    const d = run.jobs.find((j) => j.name === 'd')!;
    assert.deepEqual([d.blockedMin, d.queueMin, d.workMin], [8, 0, 1]);
    assert.equal(run.blockedMin, 8);
    close(run.queueMin + run.workMin, run.spanMin);
  });

  it('finds the job that holds up the most job-minutes', () => {
    // a holds up b, c and d for 3 minutes each; c holds up d for 5.
    assert.equal(run.topBlocker!.name, 'a');
    assert.equal(run.topBlocker!.heldJobs, 3);
    assert.equal(run.topBlocker!.heldJobMin, 9);
  });

  it('counts setup only in path jobs that first waited', () => close(run.setupInPathMin, 1.5));
});

describe('a matrix', () => {
  const graph = graphOf(`jobs:
  test:
    strategy:
      matrix:
        shard: [1, 2, 3]
  e2e:
    name: E2E \${{ matrix.browser }}
    strategy: { matrix: { browser: [chromium, firefox] } }
  report:
    needs: [test, e2e]
`);
  const jobs = [job('test (1)', 0, 0, 4), job('test (2)', 0, 0.2, 7), job('test (3)', 0, 0.1, 5), job('E2E chromium', 0, 0, 3), job('E2E firefox', 0, 0, 6), job('report', 7, 7.5, 8)];
  const run = runGraph(graph, jobs)!;

  it("matches the API's names to their job", () => {
    assert.deepEqual(run.jobs.map((j) => j.key), ['test', 'test', 'test', 'e2e', 'e2e', 'report']);
    assert.deepEqual(run.unmatched, []);
  });

  it('waits for every instance, and the chain goes through the last', () => {
    assert.deepEqual(run.path.map((l) => l.name), ['test (2)', 'report']);
    const report = run.jobs.find((j) => j.name === 'report')!;
    assert.deepEqual([report.blockedMin, report.queueMin], [7, 0.5]);
  });

  it('names a matrix blocker by its job', () => assert.equal(run.topBlocker!.name, 'test'));
});

describe('two jobs with one name template', () => {
  const yaml = (other: string) => `jobs:
  unit:
    name: Test \${{ matrix.os }}
    strategy: { matrix: { os: [ubuntu-latest, windows-latest] } }
  integration:
    name: Test \${{ matrix.os }}
    strategy:
      matrix:
        os: [${other}]
        include:
          - os: macos-15
  report: { needs: [unit, integration] }
`;

  it('matches each by its matrix values', () => {
    const run = runGraph(graphOf(yaml('macos-14')), [job('Test ubuntu-latest', 0, 0, 2), job('Test macos-14', 0, 0, 3), job('Test macos-15', 0, 0, 4), job('report', 4, 4, 5)])!;
    assert.deepEqual(run.jobs.map((j) => j.key), ['unit', 'integration', 'integration', 'report']);
    assert.deepEqual(run.ambiguous, []);
  });

  it('leaves a name both could take unmatched, rather than guessing', () => {
    const run = runGraph(graphOf(yaml('ubuntu-latest')), [job('Test ubuntu-latest', 0, 0, 2), job('Test windows-latest', 0, 0, 2), job('report', 2, 2, 3)])!;
    assert.deepEqual(run.jobs.map((j) => j.key), [undefined, 'unit', 'report']);
    assert.deepEqual(run.ambiguous, ['Test ubuntu-latest']);
    assert.deepEqual(run.unmatched, ['Test ubuntu-latest']);
  });

  it('reads values from lists, objects and include, and not from an expression', () => {
    const { values } = matrixValues(parseYaml('config: [{ os: linux, arch: x64 }, { os: mac, arch: arm64 }]\nnode: ${{ fromJSON(x) }}\ninclude: [{ extra: "yes" }]\n'));
    assert.deepEqual([...values.get('config.os')!], ['linux', 'mac']);
    assert.deepEqual([...values.get('extra')!], ['yes']);
    assert.equal(values.get('node'), undefined);
    assert.ok(values.has('node'));
  });
});

describe('a reusable workflow', () => {
  const graph = graphOf(
    `jobs:
  build:
    uses: ./.github/workflows/build.yml
  lint:
    uses: pip/shared/.github/workflows/lint.yml@v1
  e2e:
    needs: build
  gate:
    needs: [e2e, lint]
`,
    {
      '.github/workflows/build.yml': `on: workflow_call
jobs:
  compile: {}
  pack:
    name: Pack
    needs: compile
`,
    },
  );
  const jobs = [job('build / compile', 0, 0, 3), job('build / Pack', 3, 3, 5), job('lint / oxlint', 0, 0, 1), job('lint / types', 0, 0, 2), job('e2e', 5, 5, 9), job('gate', 9, 9, 9.5)];
  const run = runGraph(graph, jobs)!;

  it('expands a local one into its jobs, and takes one in another repo as one job', () => {
    assert.deepEqual(run.jobs.map((j) => j.key), ['build/compile@build', 'build/pack@build', 'lint', 'lint', 'e2e', 'gate']);
    assert.match(graph.unknown.join(), /pip\/shared\/.github\/workflows\/lint.yml, in another repo/);
  });

  it("takes a skipped caller under its own name, and leaves an opaque workflow's inner order out of the hidden waits", () => {
    const g = graphOf(`jobs:
  bench:
    uses: ./.github/workflows/build.yml
  review:
    uses: pip/shared/.github/workflows/review.yml@v1
`, { '.github/workflows/build.yml': 'jobs:\n  compile: {}\n' });
    const r = runGraph(g, [skipped('bench'), job('review / prepare', 0, 0, 1), job('review / run', 5, 5, 6)])!;
    assert.deepEqual(r.unmatched, []);
    assert.deepEqual(r.lateStarts, []);
  });

  it("keeps each instance of a matrix caller's jobs apart", () => {
    const g = graphOf(
      `jobs:
  call:
    strategy: { matrix: { os: [ubuntu, macos] } }
    uses: ./.github/workflows/b.yml
  after: { needs: call }
`,
      { '.github/workflows/b.yml': 'jobs:\n  build: {}\n  test: { needs: build }\n' },
    );
    // macOS builds slowly; Ubuntu's test waits only on Ubuntu's build.
    const r = runGraph(g, [job('call (ubuntu) / build', 0, 0, 1), job('call (macos) / build', 0, 0, 6), job('call (ubuntu) / test', 1, 1, 3), job('call (macos) / test', 6, 6, 7), job('after', 7, 7, 8)])!;
    const ubuntuTest = r.jobs.find((j) => j.name === 'call (ubuntu) / test')!;
    assert.deepEqual([ubuntuTest.blockedMin, ubuntuTest.hiddenMin], [1, 0]);
    assert.deepEqual(ubuntuTest.needs, ['call/build@call (ubuntu)']);
    assert.deepEqual(r.path.map((l) => l.name), ['call (macos) / build', 'call (macos) / test', 'after']);
    assert.equal(r.jobs.find((j) => j.name === 'after')!.blockedMin, 7);
  });

  it('runs the chain through the called jobs', () => {
    assert.deepEqual(run.path.map((l) => l.name), ['build / compile', 'build / Pack', 'e2e', 'gate']);
    assert.equal(run.jobs.find((j) => j.name === 'e2e')!.blockedMin, 5);
  });
});

describe('local reusable workflows', () => {
  it("expands calls nested to GitHub's 10 levels, and no deeper", () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 10; i++) files[`.github/workflows/w${i}.yml`] = `jobs:\n  c${i}:\n    uses: ./.github/workflows/w${i + 1}.yml\n`;
    files['.github/workflows/w9.yml'] = 'jobs:\n  leaf: {}\n';
    const nine = graphOf('jobs:\n  c0:\n    uses: ./.github/workflows/w1.yml\n', files);
    assert.ok(nine.jobs.some((j) => j.key.endsWith('/c8/leaf')));
    assert.deepEqual(nine.unknown, []);

    delete files['.github/workflows/w9.yml'];
    files['.github/workflows/w9.yml'] = 'jobs:\n  c9:\n    uses: ./.github/workflows/w10.yml\n';
    files['.github/workflows/w10.yml'] = 'jobs:\n  c10:\n    uses: ./.github/workflows/w11.yml\n';
    const eleven = graphOf('jobs:\n  c0:\n    uses: ./.github/workflows/w1.yml\n', files);
    assert.match(eleven.unknown.join(), /past GitHub's 10 levels/);
  });

  it('never takes a local call for another repo, quoted or not readable', () => {
    const g = graphOf(`jobs:\n  a:\n    uses: "./.github/workflows/gone.yml"\n  b:\n    uses: ./.github/workflows/here.yaml\n`, { '.github/workflows/here.yaml': 'jobs:\n  x: {}\n' });
    assert.deepEqual(g.unknown, ['"a" calls .github/workflows/gone.yml, which couldn\'t be read']);
    assert.ok(g.jobs.some((j) => j.key === 'b/x'));
  });
});

describe('reading the workflow files', () => {
  const jobs = [job('a', 0, 0, 1)];
  const refused = () => {
    throw new Error("Couldn't read repos/pip/app/contents/x: HTTP 403.");
  };

  it('asks only for the sampled workflow and what it calls', () => {
    const asked: string[] = [];
    const files: Record<string, string> = { '.github/workflows/ci.yml': 'jobs:\n  a:\n    uses: ./.github/workflows/b.yml\n', '.github/workflows/b.yml': 'jobs:\n  x: {}\n' };
    jobGraphOf((p) => (asked.push(p), files[p]), [{ id: 1, path: '.github/workflows/ci.yml', jobs }]);
    assert.deepEqual(asked, ['.github/workflows/ci.yml', '.github/workflows/b.yml']);
  });

  it('takes a refused read as unknown, with the reason, and goes on', () => {
    const top = jobGraphOf(refused, [{ id: 1, path: '.github/workflows/ci.yml', jobs }])!;
    assert.match(top.unknown.join(), /ci\.yml couldn't be read \(Couldn't read .*HTTP 403\)/);
    const callee = jobGraphOf((p) => (p.endsWith('ci.yml') ? 'jobs:\n  a:\n    uses: ./.github/workflows/b.yml\n' : refused()), [{ id: 1, path: '.github/workflows/ci.yml', jobs }])!;
    assert.match(callee.unknown.join(), /calls \.github\/workflows\/b\.yml, which couldn't be read \(.*HTTP 403\)/);
  });
});

describe('a skipped job', () => {
  const graph = graphOf(`jobs:
  test: {}
  deploy:
    needs: test
    if: github.event_name == 'push'
  gate:
    needs: [test, deploy]
`);
  const run = runGraph(graph, [job('test', 0, 0, 4), skipped('deploy'), job('gate', 4, 4.2, 4.5)])!;

  it('is done when its needs are, and the chain passes it by', () => {
    assert.deepEqual(run.skipped, ['deploy']);
    assert.deepEqual(run.path.map((l) => l.name), ['test', 'gate']);
    assert.equal(run.jobs.find((j) => j.name === 'gate')!.blockedMin, 4);
    assert.equal(graph.jobs.find((j) => j.key === 'deploy')!.if, "github.event_name == 'push'");
  });
});

describe("a wait the YAML can't see", () => {
  const graph = graphOf(`jobs:
  build: {}
  test: { needs: build }
  lint: {}
  deploy-preview: {}
`);
  // deploy-preview needs nothing, yet GitHub queued it 6 minutes in: it waited on something outside this file.
  // lint was queued at once but got a runner late: that's queue, not a hidden wait.
  const jobs = [
    job('build', 0, 0, 2, [['Run build', 0.5, 1.5]]),
    job('test', 2, 2.1, 4),
    job('lint', 0, 3, 4),
    job('deploy-preview', 6, 6, 8, [['Wait for the other workflow', 6, 7.5]]),
    job('surprise', 0, 0.1, 0.5),
  ];
  const run = runGraph(graph, jobs)!;

  it('counts a late start and a waiting step, and names jobs not in the YAML', () => {
    assert.deepEqual(run.lateStarts.map((l) => l.name), ['deploy-preview']);
    const lint = run.jobs.find((j) => j.name === 'lint')!;
    assert.deepEqual([lint.hiddenMin, lint.queueMin], [0, 3]);
    assert.deepEqual(run.waitSteps.map((w) => w.step), ['Wait for the other workflow']);
    assert.deepEqual(run.unmatched, ['surprise']);
  });

  it('says so across the sample', () => {
    const g = jobGraphOf(() => `jobs:\n  build: {}\n  test: { needs: build }\n  lint: {}\n  deploy-preview: {}\n`, [
      { id: 1, path: '.github/workflows/ci.yml', jobs },
      { id: 2, path: '.github/workflows/ci.yml', jobs: [job('build', 0, 0, 2), job('test', 2, 2.1, 4)] },
    ])!;
    assert.equal(g.hidden.runs, 1);
    assert.deepEqual(g.hidden.jobs, [{ name: 'deploy-preview', runs: 1 }]);
    assert.match(graphBlock(g), /1 of 2 runs had a job GitHub queued over 2 minutes after its needs finished/);
  });
});

describe('the chain across runs', () => {
  it('keys a chain by its jobs, so a job named like a chain is never taken for one', () => {
    const yaml = 'jobs:\n  build: {}\n  test: { needs: build }\n';
    // The second run's only job isn't in the YAML, and is named the way the first run's chain would be joined.
    const g = jobGraphOf(() => yaml, [
      { id: 1, path: '.github/workflows/ci.yml', jobs: [job('build', 0, 0, 1), job('test', 1, 1, 2)] },
      { id: 2, path: '.github/workflows/ci.yml', jobs: [job('build → test', 0, 0, 1)] },
      { id: 3, path: '.github/workflows/ci.yml', jobs: [job('build', 0, 0, 1), job('test', 1, 1, 3)] },
    ])!;
    assert.deepEqual(g.chain.map((l) => l.name), ['build', 'test']);
    assert.equal(g.chainRuns, 2);
  });
});

describe('across the sample', () => {
  const yaml = `jobs:
  build:
    steps:
      - run: make
      - uses: actions/upload-artifact@v4
      - run: make docs
  test:
    needs: build
    strategy: { matrix: { n: [1, 2, 3, 4] } }
  gate:
    needs: test
`;
  const run = (shift: number) => [
    job('build', 0, 0.1, 6 + shift, [['Set up job', 0.1, 0.3], ['Run make', 0.3, 2], ['Run actions/upload-artifact@v4', 2, 2.2], ['Run make docs', 2.2, 6 + shift]]),
    ...[1, 2, 3, 4].map((n) =>
      job(`test (${n})`, 6 + shift, 6.1 + shift, 9 + shift + n / 10, [['Set up job', 6.1 + shift, 6.3 + shift], ['Run pnpm install', 6.3 + shift, 7.5 + shift], ['Run actions/download-artifact@v4', 7.5 + shift, 7.6 + shift], ['Run tests', 7.6 + shift, 9 + shift + n / 10]]),
    ),
    job('gate', 9.5 + shift, 9.6 + shift, 9.7 + shift),
  ];
  const g = jobGraphOf((p) => (p === '.github/workflows/ci.yml' ? yaml : undefined), [1, 2, 3].map((id) => ({ id, path: '.github/workflows/ci.yml', jobs: run(id / 10) })))!;

  it('names the chain, the gate and the top blocker', () => {
    assert.deepEqual(g.chain.map((l) => l.name), ['build', 'test (4)', 'gate']);
    assert.equal(g.chainRuns, 3);
    assert.deepEqual(g.gateEnd, [{ name: 'gate', runs: 3 }]);
    assert.equal(g.topBlockers[0]!.name, 'build');
    assert.equal(g.topBlockers[0]!.heldJobs, 5);
    assert.equal(g.pathJobsP50, 3);
    assert.deepEqual([g.jobs, g.edges, g.matrixJobs, g.reusableCalls], [3, 2, 1, 0]);
  });

  it('guesses a wait on one step', () => {
    assert.equal(g.stepWaits[0]!.job, 'test');
    assert.equal(g.stepWaits[0]!.waitsOn, 'build');
    assert.equal(g.stepWaits[0]!.step, 'Run actions/upload-artifact@v4');
    assert.equal(g.stepWaits[0]!.guess, true);
  });

  it('gives the fixes and the report lines', () => {
    const fixes = graphFixes(g);
    assert.deepEqual(fixes.map((f) => f.page), ['07-shards-runners-and-billing.md#shorten-the-critical-path-before-buying-cores', '21-optimize-all-of-your-graphs.md#ci-jobs']);
    assert.match(fixes[1]!.text, /"build" holds up 5 of 6 jobs/);
    const [chain, blocker] = promptLines(g);
    assert.match(chain!, /^Chain that sets the wait: "build" 6\.2 min \(\d+%\) → "test \(4\)"/);
    assert.match(blocker!, /^Top blocker: "build" holds up 5 of 6 jobs/);
    assert.match(graphBlock(g), /^Job graph \(\.github\/workflows\/ci\.yml, 3 jobs, 2 needs edges/);
  });

  it('keeps each run to scale for a replay', () => {
    assert.equal(g.perRun.length, 3);
    assert.deepEqual(g.perRun[0]!.jobs.find((j) => j.name === 'gate'), {
      name: 'gate',
      needs: ['test'],
      readyMin: 9.5,
      createdMin: 9.6,
      startMin: 9.7,
      endMin: 9.8,
      blockedMin: 9.5,
      hiddenMin: 0.1,
      queueMin: 0.1,
      workMin: 0.1,
      setupMin: 0,
    });
  });

  it('is undefined with no run that ran', () => assert.equal(jobGraphOf(() => yaml, []), undefined));
});
