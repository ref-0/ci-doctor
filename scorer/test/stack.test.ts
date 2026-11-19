import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { manifestPaths } from '../src/score.ts';
import type { Source } from '../src/source.ts';
import { exportsOf, MAX_MANIFESTS, packageGraph, parseManifest, stackOf, type StackInputs } from '../src/stack.ts';

/** A tree of files, read from memory. `unreadable` paths are listed but answer nothing, as a failed read does. */
const tree = (files: Record<string, string>, { truncated = false, unreadable = [] as string[] } = {}): Source => {
  const read = (p: string) => (unreadable.includes(p) ? undefined : files[p]);
  return {
    tree: { truncated, blobs: Object.keys(files).map((path) => ({ path, size: files[path]!.length })) },
    read,
    readMany: (paths) => new Map(paths.flatMap((p) => (read(p) === undefined ? [] : [[p, read(p)!] as const]))),
  };
};

const stack = (files: Record<string, string>, o: Partial<StackInputs> & { truncated?: boolean; unreadable?: string[] } = {}) => {
  const source = tree(files, o);
  const workflows = Object.keys(files).filter((p) => p.startsWith('.github/workflows/')).map((p) => files[p]!);
  return stackOf({
    source,
    manifestPaths: manifestPaths(source.tree),
    workflows: { texts: workflows, complete: !o.truncated },
    languages: o.languages,
    packages: { npm: 0 },
    runners: o.runners,
    ...(o.manifestPaths ? { manifestPaths: o.manifestPaths } : {}),
  });
};

const pkg = (o: object) => JSON.stringify(o);

describe('stack: a JavaScript workspace', () => {
  const s = stack({
    'package.json': pkg({ name: 'root', private: true, workspaces: ['packages/*'], scripts: { test: 'vitest run', e2e: 'playwright test' }, devDependencies: { vitest: '4', eslint: '9', prettier: '3', typescript: '5', '@types/node': '24' } }),
    'pnpm-lock.yaml': '',
    'pnpm-workspace.yaml': '',
    'turbo.json': '{}',
    'packages/app/package.json': pkg({ name: '@pip/app', dependencies: { react: '19', next: '16', '@pip/ui': 'workspace:*' }, devDependencies: { '@playwright/test': '1' } }),
    'packages/ui/package.json': pkg({ name: '@pip/ui', dependencies: { react: '19', 'class-variance-authority': '1' }, peerDependencies: { '@pip/app': '*' } }),
    'examples/demo/package.json': pkg({ name: 'demo', dependencies: { vue: '3' } }),
    'packages/create/template-vue/package.json': pkg({ name: 'tpl', dependencies: { vue: '3' } }),
    'node_modules/x/package.json': pkg({ name: 'x', dependencies: { lodash: '4' } }),
  });

  it("reads only the workspace's own manifests: not examples, templates or node_modules", () => {
    const files = ['package.json', 'packages/app/package.json', 'packages/ui/package.json', 'examples/demo/package.json', 'packages/create/template-vue/package.json', 'node_modules/x/package.json'];
    assert.deepEqual(manifestPaths({ truncated: false, blobs: files.map((path) => ({ path, size: 1 })) }), files.slice(0, 3));
  });

  it('names the package manager and the workspace tools', () => {
    assert.deepEqual(s.workspace.packageManagers, ['pnpm']);
    assert.deepEqual(s.workspace.tools, ['Turborepo', 'pnpm workspaces', 'npm workspaces']);
  });

  it('finds every test runner, and lint and format tools, from dependencies and scripts', () => {
    assert.deepEqual(s.testRunners, ['Vitest', 'Playwright']);
    assert.deepEqual(s.lintFormat, ['ESLint', 'Prettier']);
  });

  it("counts libraries by how many packages use them, without the workspace's own, types, TypeScript or the tools", () => {
    assert.deepEqual(s.libraries, [
      { name: 'react', ecosystem: 'npm', packages: 2 },
      { name: 'class-variance-authority', ecosystem: 'npm', packages: 1 },
      { name: 'next', ecosystem: 'npm', packages: 1 },
    ]);
  });

  it('says an empty list only when every input was read', () => {
    assert.deepEqual(s.agentFiles, []);
    assert.deepEqual(s.unknown, []);
  });
});

describe('stack: Vite+', () => {
  it('counts Vitest, Oxlint and Oxfmt, which it bundles, and Vite+ as the task runner', () => {
    const s = stack({ 'package.json': pkg({ devDependencies: { 'vite-plus': '1.7.0' } }), 'pnpm-lock.yaml': '' });
    assert.deepEqual(s.testRunners, ['Vitest']);
    assert.deepEqual(s.lintFormat, ['Oxlint', 'Oxfmt']);
    assert.deepEqual(s.workspace.tools, ['Vite+']);
    assert.deepEqual(s.libraries, []);
  });

  it('takes Biome, Oxlint and Oxfmt from their config files, and Cypress, Jest and Mocha from theirs', () => {
    const s = stack({ 'package.json': '{}', 'biome.json': '{}', '.oxlintrc.json': '{}', '.oxfmtrc.json': '{}', 'web/cypress.config.ts': '', 'jest.config.js': '', '.mocharc.yml': '' });
    assert.deepEqual(s.testRunners, ['Jest', 'Cypress', 'Mocha']);
    assert.deepEqual(s.lintFormat, ['Oxlint', 'Biome', 'Oxfmt']);
  });
});

describe('stack: a Rust workspace', () => {
  const s = stack({
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n\n[workspace.dependencies]\nserde = "1"\npip_core = { path = "crates/pip_core" }\n\n[workspace.lints.clippy]\npedantic = "warn"\n',
    'Cargo.lock': '',
    '.config/nextest.toml': '',
    'rustfmt.toml': '',
    'crates/pip_core/Cargo.toml': '[package]\nname = "pip_core"\n\n[dependencies]\nserde = { workspace = true }\ntokio.workspace = true\nlog = "0.4" # logging\n\n[dev-dependencies]\ninsta = "1"\n',
    'crates/pip_cli/Cargo.toml': '[package]\nname = "pip_cli"\n\n[dependencies]\npip_core = { workspace = true }\nserde = { version = "1", features = ["derive"] }\nmy_clap = { version = "4", package = "clap" }\nlocal = { path = "../local" }\n\n[dependencies.anyhow]\nversion = "1"\n\n[target.\'cfg(unix)\'.dependencies]\nlibc = "0.2"\n',
    '.github/workflows/ci.yml': 'on: pull_request\njobs:\n  t:\n    steps:\n      - run: cargo nextest run\n      - run: cargo test --doc\n',
  });

  it('names Cargo and the workspace', () => {
    assert.deepEqual(s.workspace.packageManagers, ['Cargo']);
    assert.deepEqual(s.workspace.tools, ['Cargo workspace']);
  });

  it('finds nextest and cargo test, Clippy from the lints table and rustfmt from its config', () => {
    assert.deepEqual(s.testRunners, ['cargo nextest', 'cargo test']);
    assert.deepEqual(s.lintFormat, ['Clippy', 'rustfmt']);
  });

  it('counts crates by package, renamed ones by their real name, and leaves path and workspace crates out', () => {
    assert.deepEqual(s.libraries!.map((l) => `${l.name}:${l.packages}`), ['serde:2', 'anyhow:1', 'clap:1', 'insta:1', 'libc:1', 'log:1', 'tokio:1']);
  });
});

describe('stack: Python, Go and Ruby', () => {
  it('reads pyproject arrays, groups and Poetry tables, with names normalized', () => {
    const s = stack({
      'pyproject.toml': '[project]\nname = "Pip_App"\ndependencies = [\n  "Requests>=2",\n  "pydantic[email]>=2",  # models\n]\n\n[dependency-groups]\ndev = ["pytest>=8", "ruff"]\n\n[tool.ruff]\nline-length = 100\n',
      'libs/core/pyproject.toml': '[tool.poetry]\nname = "core"\n\n[tool.poetry.dependencies]\npython = "^3.12"\nrequests = "*"\npip-app = { path = "../.." }\n',
      'uv.lock': '',
      'tests/conftest.py': '',
    });
    assert.deepEqual(s.workspace.packageManagers, ['uv']);
    assert.deepEqual(s.testRunners, ['pytest']);
    assert.deepEqual(s.lintFormat, ['Ruff']);
    assert.deepEqual(s.libraries!.map((l) => `${l.name}:${l.packages}`), ['requests:2', 'pydantic:1']);
  });

  it("reads go.mod's direct requires, and go test and golangci-lint from the Makefile and config", () => {
    const s = stack({
      'go.mod': 'module github.com/pip/app\n\ngo 1.24\n\nrequire (\n\tgithub.com/spf13/cobra v1.8.0\n\tgolang.org/x/sys v0.20.0 // indirect\n\tgithub.com/pip/app/tools v0.0.0\n)\n\nrequire github.com/stretchr/testify v1.9.0\n',
      'tools/go.mod': 'module github.com/pip/app/tools\n\nrequire github.com/spf13/cobra v1.8.0\n',
      'go.work': '',
      Makefile: 'test:\n\tgo test ./...\n',
      '.golangci.yml': '',
    });
    assert.deepEqual(s.workspace.packageManagers, ['Go modules']);
    assert.deepEqual(s.workspace.tools, ['Go workspace', 'Make']);
    assert.deepEqual(s.testRunners, ['go test']);
    assert.deepEqual(s.lintFormat, ['golangci-lint']);
    assert.deepEqual(s.libraries!.map((l) => `${l.name}:${l.packages}`), ['github.com/spf13/cobra:2', 'github.com/stretchr/testify:1']);
  });

  it('reads gems, RSpec and RuboCop', () => {
    const s = stack({ Gemfile: "source 'https://rubygems.org'\ngem 'rails', '~> 8.0'\ngem \"engine\", path: \"engines/engine\"\ngroup :test do\n  gem 'rspec-rails'\nend\n", '.rubocop.yml': '' });
    assert.deepEqual(s.workspace.packageManagers, ['Bundler']);
    assert.deepEqual(s.testRunners, ['RSpec']);
    assert.deepEqual(s.lintFormat, ['RuboCop']);
    assert.deepEqual(s.libraries!.map((l) => l.name), ['rails']);
  });
});

describe('stack: languages, runners and agent files', () => {
  it("takes the profile's languages and the sampled jobs' runner providers", () => {
    const s = stack({ 'README.md': '' }, { languages: [['TypeScript', 90], ['Rust', 10]], runners: [['Blacksmith', 12], ['GitHub-hosted', 3]] });
    assert.deepEqual(s.languages, [['TypeScript', 90], ['Rust', 10]]);
    assert.deepEqual(s.runners, [['Blacksmith', 12], ['GitHub-hosted', 3]]);
  });

  it('names agent files found at any depth, but not in node_modules, vendored code or examples', () => {
    const s = stack({ 'AGENTS.md': '', 'apps/web/AGENTS.md': '', 'CLAUDE.md': '', '.cursor/rules/a.mdc': '', '.cursor/rules/b.mdc': '', '.claude/skills/x/SKILL.md': '', 'node_modules/p/AGENTS.md': '', 'vendor/q/CLAUDE.md': '', 'examples/r/GEMINI.md': '' });
    assert.deepEqual(s.agentFiles, ['AGENTS.md', 'CLAUDE.md', '.cursor/rules', '.claude/skills']);
  });
});

describe('stack: unknown is not none', () => {
  it('no languages or jobs read: both unknown', () => {
    const s = stack({ 'package.json': '{}' });
    assert.equal(s.languages, null);
    assert.equal(s.runners, null);
  });

  it("a truncated tree leaves what wasn't found unknown, and keeps what was", () => {
    const s = stack({ 'package.json': pkg({ devDependencies: { vitest: '4' } }) }, { truncated: true });
    assert.deepEqual(s.testRunners, ['Vitest']);
    assert.equal(s.lintFormat, null);
    assert.equal(s.agentFiles, null);
    assert.equal(s.packages, null);
    assert.match(s.unknown.join('\n'), /cut the file tree short/);
  });

  it("a manifest that can't be read leaves the libraries unknown and says which", () => {
    const s = stack({ 'package.json': pkg({ dependencies: { react: '19' } }), 'packages/a/package.json': '{}' }, { unreadable: ['package.json', 'packages/a/package.json'] });
    assert.equal(s.libraries, null);
    assert.equal(s.testRunners, null);
    assert.match(s.unknown[0]!, /2 manifest or task files .* couldn't be read, such as package\.json/);
  });

  it('past the cap, reads the first manifests and says how many it left', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_MANIFESTS; i++) files[`packages/p${i}/package.json`] = pkg({ name: `p${i}`, dependencies: { react: '19' } });
    const s = stack(files);
    assert.equal(s.libraries![0]!.packages, MAX_MANIFESTS);
    assert.match(s.unknown[0]!, new RegExp(`first ${MAX_MANIFESTS} of ${MAX_MANIFESTS + 1} package manifests`));
  });
});

describe('parseManifest', () => {
  it("takes a broken package.json as naming nothing, rather than failing the report", () => {
    assert.deepEqual(parseManifest('package.json', '{ not json')!.deps, []);
  });

  it('ignores files that are no manifest', () => assert.equal(parseManifest('README.md', ''), undefined));
});

describe('stack: the package graph', () => {
  const s = stack({
    'package.json': pkg({ private: true, devDependencies: { '@pip/cli': 'workspace:*' } }),
    'packages/core/package.json': pkg({ name: '@pip/core', exports: { '.': './index.js', './utils': './utils.js', './package.json': './package.json' }, dependencies: { '@pip/util': '1.0.0' } }),
    'packages/util/package.json': pkg({ name: '@pip/util', exports: './index.js', dependencies: { '@pip/core': 'workspace:^' } }),
    'packages/ui/package.json': pkg({ name: '@pip/ui', exports: { './button': './button.js' }, dependencies: { '@pip/core': 'workspace:*', react: '19' } }),
    'packages/cli/package.json': pkg({ name: '@pip/cli', dependencies: { '@pip/ui': 'workspace:*', '@pip/core': '*', '@pip/cli': 'workspace:*' } }),
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
    'crates/a/Cargo.toml': '[package]\nname = "a"\n\n[dependencies]\nb = { path = "../b" }\n\n[dependencies.c]\npath = "../c"\n',
    'crates/b/Cargo.toml': '[package]\nname = "b"\n\n[dependencies]\nc = { workspace = true }\nserde = "1"\n',
    'crates/c/Cargo.toml': '[package]\nname = "c"\n',
  });
  const g = s.graph;
  const of = (name: string) => g.packages.find((p) => p.name === name)!;

  it('lists each package with its edges to the workspace, by protocol, version or path, never to itself', () => {
    assert.deepEqual(of('@pip/cli').internal, ['@pip/core', '@pip/ui']);
    assert.deepEqual(of('package.json').internal, ['@pip/cli']);
    assert.deepEqual(of('a').internal, ['b', 'c']);
    assert.deepEqual(of('b').internal, ['c']);
    assert.equal(of('a').ecosystem, 'cargo');
  });

  it("records each npm package's exports: entries, and whether one is the root", () => {
    assert.deepEqual(of('@pip/core').exports, { entries: 3, root: true });
    assert.deepEqual(of('@pip/util').exports, { entries: 1, root: true });
    assert.deepEqual(of('@pip/ui').exports, { entries: 1, root: false });
    assert.equal(of('@pip/cli').exports, false);
    assert.equal('exports' in of('a'), false);
  });

  it('counts packages and edges, finds cycles, the deepest chain and the most depended on', () => {
    // The workspace roots, package.json and Cargo.toml, are packages too, as the profile counts them.
    assert.equal(g.count, 9);
    assert.equal(g.edges, 9);
    assert.deepEqual(g.cycles, [['@pip/core', '@pip/util']]);
    // package.json → cli → ui → core ⇄ util: the cycle counts as one step.
    assert.equal(g.maxDepth, 3);
    assert.deepEqual(g.topFanIn, [['@pip/core', 3], ['c', 2], ['@pip/cli', 1], ['@pip/ui', 1], ['@pip/util', 1]]);
  });

  it("leaves the repo's numbers unknown when a manifest couldn't be read, and lists what was", () => {
    const partial = stack({ 'packages/a/package.json': pkg({ name: 'a', dependencies: { b: '*' } }), 'packages/b/package.json': pkg({ name: 'b' }) }, { unreadable: ['packages/b/package.json'] }).graph;
    assert.deepEqual(partial.packages.map((p) => p.name), ['a']);
    assert.deepEqual([partial.count, partial.edges, partial.cycles, partial.maxDepth, partial.topFanIn], [null, null, null, null, null]);
  });

  it('with no packages, is empty, not unknown', () => {
    assert.deepEqual(packageGraph([], true), { packages: [], count: 0, edges: 0, cycles: [], maxDepth: 0, topFanIn: [] });
  });

  it('reads exports in every form package.json allows', () => {
    assert.equal(exportsOf(undefined), false);
    assert.deepEqual(exportsOf(['./a.js', './b.js']), { entries: 1, root: true });
    assert.deepEqual(exportsOf({ import: './a.mjs', require: './a.cjs' }), { entries: 1, root: true });
    assert.deepEqual(exportsOf({ '.': { import: './a.mjs' }, './*': './*.js' }), { entries: 2, root: true });
  });
});
