#!/usr/bin/env node
/**
 * graph.ts: how a JavaScript or TypeScript workspace is wired, and what a change triggers.
 *
 * Where it runs: in a repo's checkout, by hand, in ci-doctor's Phase 1 and 2. Node 24 or later and
 * `git`; no install, and nothing in the repo runs. It reads committed trees only.
 *
 *     node scripts/graph/graph.ts                        the default branch, the last 200 commits
 *     node scripts/graph/graph.ts --repo ../app --commits 100
 *     node scripts/graph/graph.ts --json > graph.json    the field report's shape, README "JSON"
 *
 * It measures four graphs, in this order, and replays history through them:
 *   1. packages and their internal edges;
 *   2. each package's export paths, and the file graph through them;
 *   3. folders inside each package, as layers;
 *   4. the workspace's tasks.
 *
 * Options:
 *   --repo <dir>           the repo (default: the current folder)
 *   --rev <ref>            the branch to measure and replay (default: origin/HEAD, main or master)
 *   --commits <n>          first-parent commits to replay (default 200; 0 skips the replay)
 *   --tests <regex>        what a test file's path looks like (default: .test., .spec., __tests__/)
 *   --conditions <a,b>     `exports` conditions to prefer, in order (default: the first tracked target)
 *   --layers <file.json>   declared folder layers, `{ "<source folder>": [["bottom"], ["next", "beside"]] }`
 *   --json                 print the JSON report instead of the readable one
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, exit, stderr, stdout } from 'node:process';
import { parseArgs } from 'node:util';

import { DEFAULT_TESTS, openGit, readGraph, UNRESOLVED_NOTES } from './read.ts';
import type { FileGraph, ReadOptions, Unresolved } from './read.ts';
import { defaultBranch, nearestRank, replay } from './replay.ts';
import type { CommitReach } from './replay.ts';
import { exportsSection, layersSection, nodesOf, packagesSection, tasksSection, THRESHOLDS } from './shape.ts';
import type { Flag, Layers } from './shape.ts';
import { readTasks } from './tasks.ts';
import type { TaskGraph } from './tasks.ts';

/** The JSON report's version. A change to a field's meaning or a removed field bumps it. */
export const SCHEMA = 1;

const quantiles = (values: ReadonlyArray<number>) => ({ p50: nearestRank(values, 0.5), p90: nearestRank(values, 0.9) });
const ratio = (n: number, of: number) => (of === 0 ? 0 : n / of);

/** The report, as `--json` prints it. README's "JSON" section documents every field. */
export const report = (repo: string, options: ReadOptions & { rev?: string; commits: number; layers?: Layers }, progress?: (done: number, of: number) => void) => {
  const git = openGit(repo);
  const branch = options.rev ?? defaultBranch(git);
  const sha = git.run('rev-parse', `${branch}^{commit}`).trim();
  let graph: FileGraph;
  let tasks: TaskGraph;
  let commits: ReadonlyArray<CommitReach> = [];
  if (options.commits > 0) {
    const replayed = replay(git, branch, options.commits, options, progress);
    ({ graph, tasks } = replayed.last);
    commits = replayed.commits;
  } else {
    graph = readGraph(git, sha, options);
    tasks = readTasks(git, graph);
  }

  const through = new Map<string, number>();
  for (const c of commits) for (const id of c.through) through.set(id, (through.get(id) ?? 0) + 1);
  const packages = packagesSection(graph);
  const exports = exportsSection(graph, commits.length > 0 ? through : undefined);
  const layers = layersSection(graph, options.layers);
  const taskShape = tasksSection(graph, tasks);
  const nodes = nodesOf(graph);
  const shares = (pick: (c: CommitReach) => number) => quantiles(commits.map(pick));
  const replayed = commits.length > 0;
  const triggers = new Map<string, { path: string; why: string; commits: number; testsShare: number }>();
  const p90 = nearestRank(commits.map((c) => ratio(c.reached.tests, c.of.tests)), 0.9) ?? 1;
  for (const c of commits) {
    if (!c.widest || ratio(c.reached.tests, c.of.tests) < p90 || c.reached.tests === 0) continue;
    const t = triggers.get(c.widest.path) ?? { path: c.widest.path, why: c.widest.why, commits: 0, testsShare: 0 };
    t.commits++;
    t.testsShare = Math.max(t.testsShare, ratio(c.widest.tests, c.of.tests));
    triggers.set(c.widest.path, t);
  }

  return {
    schema: SCHEMA,
    repo: { rev: branch, sha, workspace: graph.kind },
    denominators: {
      trackedFiles: graph.files.size,
      files: nodes.length,
      tests: nodes.filter(graph.isTest).length,
      packages: graph.packages.length,
      entries: exports.nodes.length,
      tasks: tasks.tasks.size,
      cachedTasks: taskShape.cached,
    },
    unresolved: {
      specifiers: graph.specifiers,
      reasons: Object.fromEntries([...graph.unresolved].map(([why, v]) => [why, { ...v, note: UNRESOLVED_NOTES[why] }])) as Partial<Record<Unresolved, { count: number; examples: string[]; note: string }>>,
    },
    packages: {
      nodes: packages.nodes, edges: packages.edges, flags: packages.flags, depth: packages.depth, chain: packages.chain,
      replay: replayed ? { reached: shares((c) => ratio(c.reached.packages, c.of.packages)) } : null,
    },
    exports: {
      nodes: exports.nodes, edges: exports.edges, flags: exports.flags,
      replay: replayed ? {
        entries: shares((c) => ratio(c.reached.entries, c.of.entries)),
        files: shares((c) => ratio(c.reached.files, c.of.files)),
        tests: shares((c) => ratio(c.reached.tests, c.of.tests)),
        packageLevelTests: shares((c) => ratio(c.packageLevelTests, c.of.tests)),
        through: Object.fromEntries([...through].sort((a, b) => b[1] - a[1])),
      } : null,
    },
    layers: { nodes: layers.nodes, edges: layers.edges, flags: layers.flags, declared: options.layers !== undefined },
    tasks: {
      nodes: taskShape.nodes, edges: taskShape.edges, flags: taskShape.flags, depth: taskShape.depth, chain: taskShape.chain,
      runners: tasks.runners, unread: tasks.unread,
      replay: replayed ? { touched: shares((c) => ratio(c.tasks.touched, c.of.cachedTasks)), withDependents: shares((c) => ratio(c.tasks.withDependents, c.of.cachedTasks)) } : null,
    },
    replay: replayed ? {
      branch,
      asked: options.commits,
      commits: commits.length,
      method: 'nearest-rank',
      everything: { count: commits.filter((c) => c.everything).length, of: commits.length },
      docsOnly: { count: commits.filter((c) => c.reached.files === 0 && c.reached.tests === 0).length, of: commits.length },
      triggers: [...triggers.values()].sort((a, b) => b.commits - a.commits || b.testsShare - a.testsShare).slice(0, 10),
      perCommit: commits,
    } : null,
    thresholds: THRESHOLDS,
  };
};

export type Report = ReturnType<typeof report>;

// ---- The readable report -------------------------------------------------------------------------

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(x < 0.1 && x > 0 ? 1 : 0)}%`);
const of = (n: number, d: number) => `${n.toLocaleString('en-US')} of ${d.toLocaleString('en-US')} (${pct(ratio(n, d))})`;
const flagsOf = (flags: ReadonlyArray<Flag>, kind: string) => flags.filter((f) => f.kind === kind);

/** The headline: one line per graph, plus what didn't resolve. ci-doctor's baseline pastes it. */
export const headline = (r: Report) => {
  const d = r.denominators;
  const unresolved = Object.values(r.unresolved.reasons).reduce((n, v) => n + (v?.count ?? 0), 0);
  const lines = [
    `Workspace: ${r.repo.workspace}, ${d.packages} packages, ${d.files.toLocaleString('en-US')} files in the import graph (${d.tests.toLocaleString('en-US')} tests), ${r.repo.rev} at ${r.repo.sha.slice(0, 12)}`,
    `Unresolved: ${of(unresolved, r.unresolved.specifiers.total)} specifiers${unresolved > 0 ? ': ' + Object.entries(r.unresolved.reasons).map(([k, v]) => `${v!.count} ${k}`).join(', ') : ''}`,
    `1 Packages: depth ${r.packages.depth}, ${flagsOf(r.packages.flags, 'package-cycle').length} cycles, ${flagsOf(r.packages.flags, 'undeclared-import').length} undeclared imports${r.packages.replay ? `; a commit reaches p50 ${pct(r.packages.replay.reached.p50)}, p90 ${pct(r.packages.replay.reached.p90)} of packages` : ''}`,
    `2 Exports: ${d.entries} entries, ${flagsOf(r.exports.flags, 'overloaded-entry').length} overloaded${flagsOf(r.exports.flags, 'overloaded-entry')[0] ? ` (top ${flagsOf(r.exports.flags, 'overloaded-entry')[0]!.subject}: ${flagsOf(r.exports.flags, 'overloaded-entry')[0]!.numbers.reexports} modules × ${flagsOf(r.exports.flags, 'overloaded-entry')[0]!.numbers.importerPackages} packages)` : ''}${r.exports.replay ? `; a commit reaches tests p50 ${pct(r.exports.replay.tests.p50)}, p90 ${pct(r.exports.replay.tests.p90)} (package-level selection: p50 ${pct(r.exports.replay.packageLevelTests.p50)}, p90 ${pct(r.exports.replay.packageLevelTests.p90)})` : ''}`,
    `3 Layers: ${new Set(r.layers.nodes.map((n) => n.source)).size} sources with folders, ${flagsOf(r.layers.flags, 'folder-cycle').length} folder cycles${r.layers.declared ? `, ${flagsOf(r.layers.flags, 'layer-violation').length} layer violations` : ', no layers declared'}`,
    `4 Tasks: ${d.tasks} tasks (${d.cachedTasks} cached; ${r.tasks.runners.join(', ') || 'none'}), depth ${r.tasks.depth}, ${flagsOf(r.tasks.flags, 'no-inputs').length} cached with no declared inputs, ${flagsOf(r.tasks.flags, 'wide-inputs').length} with inputs over ${pct(THRESHOLDS.wideInputs)} of the repo${r.tasks.replay ? `; a commit touches p50 ${pct(r.tasks.replay.touched.p50)}, p90 ${pct(r.tasks.replay.touched.p90)} of cached tasks' inputs` : ''}`,
  ];
  if (r.replay) {
    const t = r.replay.triggers.slice(0, 3).map((x) => `${x.path} (${x.commits})`).join(', ');
    lines.push(`Replay: ${r.replay.commits} of ${r.replay.asked} commits asked on ${r.replay.branch}; ${of(r.replay.everything.count, r.replay.everything.of)} reach everything${t ? `; widest triggers: ${t}` : ''}`);
  }
  return lines;
};

export const readable = (r: Report) => {
  const d = r.denominators;
  const out: string[] = ['# Workspace graphs', '', ...headline(r), ''];
  const list = (title: string, rows: string[]) => { if (rows.length > 0) out.push(title, ...rows.map((x) => `  ${x}`), ''); };

  const reasons = Object.entries(r.unresolved.reasons);
  list('What it could not resolve', reasons.map(([k, v]) => `${k}: ${v!.count}, ${v!.note}; e.g. ${v!.examples.slice(0, 2).join('; ')}`));
  const s = r.unresolved.specifiers;
  out.push(`Specifiers: ${s.total} total; ${s.resolved} resolved (${s.workspace} to other packages, ${s.guessed} by the dist→src convention, ${s.crossRelative} by a relative path or alias into another package), ${s.external} third-party, ${s.builtin} built-in`, '');

  out.push('## 1. Packages', '');
  list('Most imported (other packages, their files; depth below):', r.packages.nodes.slice(0, 15).map((n) => `${n.id}: ${n.importedBy.packages} packages, ${n.importedBy.files} files; depth ${n.depth}; ${n.files} files, ${n.tests} tests`));
  if (r.packages.chain.length > 1) out.push(`Longest dependency chain (${r.packages.depth + 1} packages): ${r.packages.chain.join(' → ')}`, '');
  list('Flags:', r.packages.flags.map((f) => `${f.kind}: ${f.subject}${f.detail ? ` (${f.detail})` : ''}`));
  if (r.packages.replay) out.push(`Replay: a commit reaches p50 ${pct(r.packages.replay.reached.p50)}, p90 ${pct(r.packages.replay.reached.p90)} of ${d.packages} packages`, '');

  out.push('## 2. Export paths and the file graph', '');
  const imported = r.exports.nodes.filter((n) => n.importedBy.packages > 0).length;
  out.push(`Entries: ${d.entries} declared or imported; ${of(imported, d.entries)} imported by another package; ${r.exports.nodes.filter((n) => n.barrel).length} barrels, ${r.exports.nodes.filter((n) => n.stars > 0).length} with \`export *\``, '');
  list(`Export-path overload (modules re-exported × packages importing; flagged at ≥ ${THRESHOLDS.overloadModules} × ≥ ${THRESHOLDS.overloadPackages}):`, r.exports.nodes.filter((n) => n.overload > 0).slice(0, 10).map((n) => `${n.id}: ${n.reexports} × ${n.importedBy.packages} = ${n.overload}; loads ${n.loads} files${n.stars ? `, ${n.stars} export *` : ''}${r.exports.replay ? `; ${r.exports.replay.through[n.id] ?? 0} of ${r.replay!.commits} commits reached through it` : ''}`));
  list(`Files whose change reaches the most (of ${d.files} files, ${d.packages} packages, ${d.tests} tests):`, flagsOf(r.exports.flags, 'wide-file').map((f) => `${f.subject}: ${pct(ratio(f.numbers.files!, d.files))} of files, ${f.numbers.packages} packages, ${pct(ratio(f.numbers.tests!, d.tests))} of tests`));
  if (r.exports.replay) out.push(`Replay: a commit reaches entries p50 ${pct(r.exports.replay.entries.p50)}, p90 ${pct(r.exports.replay.entries.p90)}; files p50 ${pct(r.exports.replay.files.p50)}, p90 ${pct(r.exports.replay.files.p90)}; tests p50 ${pct(r.exports.replay.tests.p50)}, p90 ${pct(r.exports.replay.tests.p90)}. A package-level selector would run p50 ${pct(r.exports.replay.packageLevelTests.p50)}, p90 ${pct(r.exports.replay.packageLevelTests.p90)} of tests.`, '');

  out.push('## 3. Layers inside packages', '');
  const size = new Map<string, number>();
  for (const n of r.layers.nodes) size.set(n.source, (size.get(n.source) ?? 0) + n.files);
  const sources = [...size.keys()].sort((a, b) => size.get(b)! - size.get(a)! || a.localeCompare(b));
  list(`${r.layers.declared ? 'Declared layers' : 'Proposed layers (folders in a cycle share one)'}, from the bottom, the ${Math.min(12, sources.length)} largest of ${sources.length} sources:`, sources.slice(0, 12).map((src) => {
    const places = r.layers.nodes.filter((n) => n.source === src);
    const top = Math.max(0, ...places.map((p) => p.layer ?? 0));
    const rows = Array.from({ length: top + 1 }, (_, k) => places.filter((p) => p.layer === k).map((p) => p.place).join(', ')).filter(Boolean);
    return `${src || '(root)'}: ${rows.join(' < ')}`;
  }));
  list('Flags:', r.layers.flags.slice(0, 30).map((f) => `${f.kind}: ${f.subject} (${Object.entries(f.numbers).map(([k, v]) => `${k} ${v}`).join(', ')})${f.detail ? `, ${f.detail}` : ''}`));

  out.push('## 4. Tasks', '');
  out.push(`Tasks: ${d.tasks} (${d.cachedTasks} cached), runners: ${r.tasks.runners.join(', ') || 'none'}; ${r.tasks.edges.length} edges; depth ${r.tasks.depth}${r.tasks.chain.length > 1 ? `: ${r.tasks.chain.join(' → ')}` : ''}`, '');
  list('Flags:', r.tasks.flags.slice(0, 30).map((f) => `${f.kind}: ${f.subject}${f.numbers.files !== undefined ? ` (${of(f.numbers.files, f.numbers.filesOf ?? d.trackedFiles)} tracked files)` : ''}${f.detail ? `; ${f.detail}` : ''}`));
  list('Not read:', r.tasks.unread.slice(0, 10));
  if (r.tasks.replay) out.push(`Replay: a commit touches the inputs of p50 ${pct(r.tasks.replay.touched.p50)}, p90 ${pct(r.tasks.replay.touched.p90)} of ${d.cachedTasks} cached tasks; with the tasks that depend on them, p50 ${pct(r.tasks.replay.withDependents.p50)}, p90 ${pct(r.tasks.replay.withDependents.p90)}`, '');

  if (r.replay) {
    out.push('## What a change triggers', '');
    out.push(`${r.replay.commits} first-parent commits on ${r.replay.branch} (${r.replay.asked} asked), quantiles by nearest rank. ${of(r.replay.everything.count, r.replay.everything.of)} reach every test; ${of(r.replay.docsOnly.count, r.replay.docsOnly.of)} reach none.`, '');
    list('Files behind the widest triggers (commits at or above p90 of tests reached):', r.replay.triggers.map((t) => `${t.path}: ${t.commits} commits, up to ${pct(t.testsShare)} of tests alone (${t.why})`));
  }
  return out.join('\n');
};

// ---- Command line -------------------------------------------------------------------------------

const main = () => {
  const { values } = parseArgs({
    args: argv.slice(2),
    options: {
      repo: { type: 'string', default: '.' },
      rev: { type: 'string' },
      commits: { type: 'string', default: '200' },
      tests: { type: 'string' },
      conditions: { type: 'string' },
      layers: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) { stdout.write(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]!.replace(/^#!.*\n\/\*\*\n?/, '').replace(/^ \* ?/gm, '') + '\n'); return; }
  const commits = Number(values.commits);
  if (!Number.isInteger(commits) || commits < 0) { stderr.write('--commits takes a whole number\n'); exit(2); }
  const result = report(resolve(values.repo), {
    tests: values.tests ? new RegExp(values.tests) : DEFAULT_TESTS,
    conditions: values.conditions ? values.conditions.split(',').map((c) => c.trim()).filter(Boolean) : [],
    ...(values.rev ? { rev: values.rev } : {}),
    commits,
    ...(values.layers ? { layers: JSON.parse(readFileSync(values.layers, 'utf8')) as Layers } : {}),
  }, stderr.isTTY ? (done, total) => stderr.write(`\rreplaying ${done}/${total}`) : undefined);
  if (stderr.isTTY) stderr.write('\n');
  stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : `${readable(result)}\n`);
};

if (argv[1] === fileURLToPath(import.meta.url)) main();
