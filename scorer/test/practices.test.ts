// The practices from in-memory files: each form a practice is found in, the near misses that must not read as found,
// and the loose hints that leave a practice unknown rather than missing.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_ACTIONS, practices, type History } from '../src/practices.ts';
import { fixesOf } from '../src/score.ts';
import type { Source } from '../src/source.ts';

const source = (files: Record<string, string>, { truncated = false } = {}): Source => ({
  tree: { truncated, blobs: Object.keys(files).map((path) => ({ path, size: 1 })) },
  read: (path) => files[path],
  readMany: (paths) => ({ texts: new Map(paths.flatMap((p) => (files[p] === undefined ? [] : [[p, files[p]] as const]))), failed: new Map() }),
});
const of = (files: Record<string, string>, history?: History) => practices(source({ 'package.json': '{}', ...files }), history);
const prs = (...titles: [string, string][]): History => ({ prs: titles.map(([login, title]) => ({ login, title })), complete: true });
const NONE = prs();

const workflow = (steps: string, on = 'pull_request') => `on: ${on}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n${steps}\n`;
const ci = (steps: string, on?: string) => ({ '.github/workflows/ci.yml': workflow(steps, on) });

describe('a monorepo whose practices live outside the forms known before', () => {
  // A composite action sets the remote cache, a `changes` job maps changed files to packages and gates the rest, and
  // Dependabot's pull requests arrive grouped by a setting no file shows.
  const files = {
    'package.json': JSON.stringify({ devDependencies: { 'vite-plus': '1.7.0' } }),
    'pnpm-lock.yaml': '',
    '.task-cache.json': '{}',
    '.github/workflows/ci.yml': `on: pull_request
jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      test: \${{ steps.scope.outputs.test }}
      filters: \${{ steps.scope.outputs.filters }}
    steps:
      - uses: actions/checkout@v4
      - id: scope
        uses: ./.github/actions/scope
  test:
    needs: changes
    if: needs.changes.outputs.test != 'false'
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/setup
      - run: vp run test \${{ needs.changes.outputs.filters }}
`,
    '.github/actions/setup/action.yml': `runs:
  using: composite
  steps:
    - shell: bash
      run: echo "VP_REMOTE_CACHE=read" >> "$GITHUB_ENV"
`,
    '.github/actions/scope/action.yml': `runs:
  using: composite
  steps:
    - shell: bash
      run: git diff --name-only origin/main... | node scripts/ci/packages-of.ts >> "$GITHUB_OUTPUT"
`,
  };
  const history = prs(['dependabot[bot]', 'Bump the npm_and_yarn group across 5 directories with 2 updates'], ['mo', 'Fix the orchard map']);

  it('reads all three as in place, and says where', () => {
    const p = of(files, history);

    assert.equal(p.remoteCache, true);
    assert.equal(p.affected, true);
    assert.equal(p.depBotsBatched, true);
    assert.equal(p.where.remoteCache, '.github/actions/setup/action.yml');
    assert.equal(p.where.affected, '.github/workflows/ci.yml');
    assert.equal(p.where.depBotsBatched, 'pull requests');
  });
});

describe('local actions', () => {
  it("reads one a workflow calls outside .github/actions, and past the cap leaves a step's practice unknown", () => {
    const called = { '.github/workflows/ci.yml': workflow('      - uses: ./tools/setup'), 'tools/setup/action.yml': 'runs:\n  using: composite\n  steps:\n    - run: npm ci\n' };
    assert.equal(of(called).frozenInstall, true);
    assert.equal(of(called).where.frozenInstall, 'tools/setup/action.yml');

    const many = Object.fromEntries(Array.from({ length: MAX_ACTIONS + 1 }, (_, i) => [`.github/actions/a${i}/action.yml`, 'runs:\n  using: composite\n']));
    const p = of({ ...ci('      - run: npm test'), ...many });
    assert.equal(p.remoteCache, null);
    assert.equal(p.timeouts, false);
    assert.ok(p.unknown.includes(`Read the first ${MAX_ACTIONS} of ${MAX_ACTIONS + 1} local actions`));
  });
});

describe('remote cache', () => {
  it("takes each runner's own switch outside the workflows", () => {
    assert.equal(of({ ...ci('      - run: bazel test //...'), '.bazelrc': 'build --remote_cache=grpcs://cache.example.com\n' }).remoteCache, true);
    assert.equal(of({ ...ci('      - run: pants test ::'), 'pants.toml': '[GLOBAL]\nremote_cache_read = true\n' }).remoteCache, true);
    assert.equal(of({ ...ci('      - run: ./gradlew test'), 'settings.gradle.kts': 'buildCache {\n  remote<HttpBuildCache> { url = uri("https://cache.example.com/") }\n}\n' }).remoteCache, true);
    assert.equal(of({ ...ci('      - run: moon ci'), '.moon/workspace.yml': "remote:\n  host: 'grpcs://cache.example.com'\n" }).remoteCache, true);
    assert.equal(of({ ...ci('      - run: nx test'), 'nx.json': '{ "nxCloudId": "abc" }' }).where.remoteCache, 'nx.json');
  });

  it('takes no switch that is off, commented out or a file of its own as one', () => {
    assert.equal(of({ ...ci('      - run: bazel test //...'), '.bazelrc': 'build --remote_cache=\n' }).remoteCache, false);
    assert.equal(of(ci('      - run: vp run test\n        env:\n          VP_REMOTE_CACHE: off')).remoteCache, false);
    assert.equal(of(ci('      # TURBO_TOKEN goes here once we have one\n      - run: turbo test')).remoteCache, false);
    assert.equal(of({ ...ci('      - run: vp run test'), '.task-cache.json': '{}' }).remoteCache, false);
  });

  it("leaves a cache token in a form it doesn't know unknown, with a hint naming the file", () => {
    const p = of({ ...ci('      - run: make test\n        env:\n          BUILD_CACHE_TOKEN: ${{ secrets.BUILD_CACHE_TOKEN }}') });
    assert.equal(p.remoteCache, null);
    assert.deepEqual(p.hints, [{ practice: 'remoteCache', path: '.github/workflows/ci.yml', kind: 'word' }]);
    assert.ok(p.unknown.includes("remoteCache: .github/workflows/ci.yml hints at it, in a form the scorer doesn't check (word)"));

    const turbo = of({ ...ci('      - run: turbo test'), 'turbo.json': '{ "remoteCache": { "apiUrl": "https://cache.example.com" } }' });
    assert.equal(turbo.remoteCache, null);
    assert.deepEqual(turbo.hints, [{ practice: 'remoteCache', path: 'turbo.json', kind: 'config' }]);
  });

  it('still suggests a shared cache for the runner only when the cache is known to be missing', () => {
    const wait = { p50: 12, p90: 14, passedOnRerunRate: 0 };
    const share = (p: ReturnType<typeof of>) => fixesOf({ wait }, p).some((f) => /Share a remote cache for turbo\.json/.test(f.text));
    assert.equal(share(of({ ...ci('      - run: turbo test'), 'turbo.json': '{}' })), true);
    assert.equal(share(of({ ...ci('      - run: turbo test'), 'turbo.json': '{ "remoteCache": { "teamSlug": "orchard" } }' })), false);
  });
});

describe('affected', () => {
  it("takes each runner's documented selection by what changed", () => {
    for (const run of ['pnpm --filter "...[origin/main]" test', 'npx jest --changedSince=origin/main', 'lerna run test --since origin/main', 'moon ci', 'pants --changed-since=origin/main test', 'yarn workspaces foreach --since run test', 'rush test --impacted-by git:origin/main'])
      assert.equal(of(ci(`      - run: ${run}`)).affected, true, run);
  });

  it('takes a job that works from the changed files and whose outputs gate others', () => {
    const gated = (steps: string) => ({
      '.github/workflows/ci.yml': `on: pull_request\njobs:\n  scope:\n    runs-on: ubuntu-latest\n    outputs:\n      web: \${{ steps.f.outputs.web }}\n    steps:\n${steps}\n  web:\n    needs: scope\n    if: needs.scope.outputs.web == 'true'\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`,
    });
    assert.equal(of(gated('      - id: f\n        uses: dorny/paths-filter@v3')).affected, true);
    assert.equal(of(gated('      - id: f\n        run: git diff --name-only HEAD~1 > files.txt')).affected, true);
    assert.equal(of({ ...gated('      - id: f\n        uses: ./.github/actions/what-changed'), '.github/actions/what-changed/action.yml': 'runs:\n  using: composite\n' }).affected, true);
  });

  it("isn't fooled by a gating job that isn't about changes, or a comment", () => {
    const version = `on: pull_request\njobs:\n  version:\n    runs-on: ubuntu-latest\n    outputs:\n      v: \${{ steps.v.outputs.v }}\n    steps:\n      - id: v\n        run: echo v=1 >> $GITHUB_OUTPUT\n  build:\n    needs: version\n    if: needs.version.outputs.v != ''\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`;
    assert.equal(of({ '.github/workflows/ci.yml': version }).affected, false);
    assert.equal(of(ci('      # one day: nx affected -t test\n      - run: nx run-many -t test')).affected, false);
  });

  it('leaves a job named for changes whose outputs gate others, but not shown to read them, unknown', () => {
    const named = `on: pull_request\njobs:\n  changes:\n    runs-on: ubuntu-latest\n    outputs:\n      web: \${{ steps.f.outputs.web }}\n    steps:\n      - id: f\n        run: ./ci/scope >> $GITHUB_OUTPUT\n  web:\n    needs: changes\n    if: needs.changes.outputs.web == 'true'\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`;
    const p = of({ '.github/workflows/ci.yml': named });
    assert.equal(p.affected, null);
    assert.deepEqual(p.hints, [{ practice: 'affected', path: '.github/workflows/ci.yml', kind: 'job' }]);
  });
});

describe('path filters', () => {
  it('takes `paths` on a pull-request trigger, never on `push` alone', () => {
    assert.equal(of(ci('      - run: npm test', '\n  pull_request:\n    paths: [src/**]')).pathFilters, true);
    assert.equal(of(ci('      - run: npm test', '\n  pull_request:\n  push:\n    paths: [src/**]')).pathFilters, false);
  });
});

describe('dependency batching', () => {
  it("takes each bot's config forms and its grouped pull requests", () => {
    assert.equal(of({ 'renovate.jsonc': '{ "extends": ["config:recommended"] }' }, NONE).depBotsBatched, true);
    assert.equal(of({ 'package.json': JSON.stringify({ renovate: { packageRules: [{ groupName: 'lint' }] } }) }, NONE).where.depBotsBatched, 'package.json');
    assert.equal(of({ '.github/dependabot.yaml': 'updates:\n  - groups:\n      all: {}\n' }, NONE).depBotsBatched, true);
    assert.equal(of({}, prs(['renovate[bot]', 'chore(deps): update all non-major dependencies'])).depBotsBatched, true);
  });

  it('says false only when a config or the whole window shows ungrouped updates', () => {
    assert.equal(of({ '.github/dependabot.yml': 'updates:\n  - package-ecosystem: npm\n' }).depBotsBatched, false);
    assert.equal(of({}, prs(['dependabot[bot]', 'Bump vite from 7.1.0 to 7.1.2'])).depBotsBatched, false);
    assert.equal(of({}, { ...prs(['dependabot[bot]', 'Bump vite from 7.1.0 to 7.1.2']), complete: false }).depBotsBatched, null);
  });

  it('has nothing to batch with no bot config and no bot pull requests, in a window or a checkout', () => {
    const quiet = of({}, prs(['pip', 'Plant the pear rows']));
    assert.equal(quiet.depBotsBatched, null);
    assert.ok(quiet.unknown.includes('No dependency bot config and no bot pull requests merged in the window, so there are no updates to batch'));
    assert.equal(of({}).depBotsBatched, null);
  });

  it('leaves a bot title that sounds grouped, in a form it does not know, unknown', () => {
    const p = of({}, prs(['renovate[bot]', 'chore(deps): update linters (and 3 others)']));
    assert.equal(p.depBotsBatched, null);
    assert.deepEqual(p.hints, [{ practice: 'depBotsBatched', path: 'pull requests', kind: 'title' }]);
  });
});

describe('merge queue', () => {
  it("takes GitHub's trigger and the configs that say a queue tests on top of the base", () => {
    assert.equal(of(ci('      - run: npm test', '[pull_request, merge_group]')).mergeQueue, true);
    assert.equal(of({ ...ci('      - run: npm test'), '.mergify.yml': 'queue_rules:\n  - name: default\n' }).where.mergeQueue, '.mergify.yml');
    assert.equal(of({ ...ci('      - run: npm test'), 'bors.toml': 'status = ["ci"]\n' }).mergeQueue, true);
    assert.equal(of({ ...ci('      - run: npm test'), '.aviator/config.yml': 'merge_rules:\n  merge_mode:\n    type: parallel\n' }).mergeQueue, true);
  });

  it("takes neither an auto-merge rule nor a comment as a queue, and leaves a tool that may not test on top unknown", () => {
    assert.equal(of({ ...ci('      - run: npm test'), '.mergify.yml': 'pull_request_rules:\n  - name: merge\n    actions:\n      merge: {}\n' }).mergeQueue, false);
    assert.equal(of(ci('      # merge_group would go here\n      - run: npm test')).mergeQueue, false);
    const kodiak = of({ ...ci('      - run: npm test'), '.kodiak.toml': 'version = 1\n' });
    assert.equal(kodiak.mergeQueue, null);
    assert.deepEqual(kodiak.hints, [{ practice: 'mergeQueue', path: '.kodiak.toml', kind: 'config' }]);
  });
});

describe('frozen installs', () => {
  it("takes pnpm and Yarn 2+'s defaults on CI, unless they're turned off", () => {
    assert.equal(of(ci('      - run: pnpm install')).frozenInstall, true);
    assert.equal(of(ci('      - run: pnpm install --no-frozen-lockfile')).frozenInstall, false);
    assert.equal(of({ ...ci('      - run: yarn install'), '.yarnrc.yml': 'nodeLinker: node-modules\n' }).frozenInstall, true);
    assert.equal(of({ ...ci('      - run: yarn install'), '.yarnrc.yml': 'enableImmutableInstalls: false\n' }).frozenInstall, false);
    assert.equal(of(ci('      - run: npm install')).frozenInstall, false);
  });
});

describe('a truncated tree', () => {
  it('leaves what a file past the cut could show unknown, never missing', () => {
    const p = practices(source({ '.github/workflows/ci.yml': workflow('      - run: npm test'), 'package.json': '{}' }, { truncated: true }), NONE);
    for (const key of ['remoteCache', 'affected', 'mergeQueue', 'depBotsBatched', 'preCommit'] as const) assert.equal(p[key], null, key);
  });
});
