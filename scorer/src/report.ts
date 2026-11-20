// What the terminal shows: the score, the <ci-report> block an agent can start from, each practice as yes, no or
// unknown, the fixes with their guide pages, and where the numbers came from.
import { graphBlock, promptLines } from './job-graph.ts';
import type { Inventory, Practices, Report } from './score.ts';
import type { Stack } from './stack.ts';

const p = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–');
const m = (x: number | undefined) => (x !== undefined && Number.isFinite(x) ? x.toFixed(1) : '–');

const fmtK = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);
const pkgText = (pk: Record<string, number>) =>
  Object.entries(pk).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k === 'npm' ? 'npm package' : k === 'cargo' ? 'crate' : k === 'go' ? 'Go module' : 'Python project'}${n === 1 ? '' : 's'}`).join(', ') || 'one package';

/** The block a person pastes into their agent, as ci-score's report has it. */
const profileLine = (r: Report) =>
  `Repo: ~${fmtK(r.profile.linesOfCode)} lines (${r.profile.languages.map(([l, s]) => `${l} ${s}%`).join(', ')}), tests ${p(r.profile.testShare)} of source, ${pkgText(r.profile.packages)}; ${r.profile.commitsPerWeek} commits/week by ${r.profile.activeAuthors28d} ${r.profile.activeAuthors28d === 1 ? 'person' : 'people'} (28 days, pace ${r.profile.pace ?? '–'}× the year); ${r.profile.prsMergedPerWeek} PRs merged/week, ${r.profile.botShareOfMergedPrs === null ? '–' : `${r.profile.botShareOfMergedPrs}%`} by bots, people's open→merge p50 ${r.profile.openToMergeHours.p50 ?? '–'} h; ${r.profile.runsPerMergedPr ?? '–'} PR runs per merged PR`;

export const promptBlock = (r: Report) =>
  [
    `<ci-report repo="${r.repo}" date="${r.date}">`,
    `Score ${r.score}/100, grade ${r.grade}: speed ${r.parts.speed}, reliability ${r.parts.reliability}, efficiency ${r.parts.efficiency} (${r.size}: ${r.headsPerWeek} PR pushes a week)`,
    profileLine(r),
    `PR wait p50 / p75 / p90: ${m(r.wait.p50)} / ${m(r.wait.p75)} / ${m(r.wait.p90)} min (pushes that ran ${r.wait.heavyWorkflows.map((w) => `"${w}"`).join(', ')}; all pushes p50 ${m(r.wait.allPushesP50)}) · queue p90 ${m(r.jobs?.queueP90Sec)} s · red heads ${p(r.wait.redRate)}${r.wait.redBy.length ? ` (${r.wait.redBy.map(([n, c]) => `${n} ×${c}`).join(', ')})` : ''} · green only on rerun ${p(r.wait.passedOnRerunRate)}`,
    `CI per merged PR: ${m(r.efficiency.jobMinutesPerMergedPr ?? NaN)} job-min across ${r.efficiency.workflowsOnPrs} PR workflows (expected for this size ~${r.efficiency.expectedMinutesPerMergedPr}); p50 wait expected for this size ~${r.efficiency.expectedWait} min; main red ${p(r.main.redRate)}`,
    r.jobs && `Last to finish: "${r.wait.lastToFinish[0]?.[0]}", ${r.jobs.jobs} jobs, ${m(r.jobs.jobMinutes)} job-min; run ${m(r.jobs.spanMin)} min; longest job "${r.jobs.longest.name}" ${m(r.jobs.longest.minutes)} min; setup ${p(r.jobs.setupShare)} of job time`,
    ...(r.jobGraph ? promptLines(r.jobGraph) : []),
    r.jobs?.shard && `Shards "${r.jobs.shard.name}": ${r.jobs.shard.shards}, slowest ${r.jobs.shard.maxOverMedian.toFixed(2)}× the median, ${p(r.jobs.shard.idleTail)} idle tail`,
    r.tests?.top.length && `Slowest test files: ${r.tests.top.slice(0, 3).map((t) => `${t.file} ${t.sec.toFixed(1)} s`).join(', ')}`,
    `Fix first: ${r.fixes.slice(0, 3).map((f, i) => `${i + 1}. ${f.text} (${f.guide.split('/').at(-1)!.slice(0, 2)})`).join('  ') || 'nothing urgent'}`,
    `</ci-report>`,
  ]
    .filter(Boolean)
    .join('\n');

const LABELS: Record<Exclude<keyof Practices, 'unknown' | 'workflows'>, string> = {
  cancelInProgress: 'Superseded PR runs cancelled',
  pathFilters: 'Path filters on PR workflows',
  affected: 'Affected-only selection',
  draftSkip: 'Drafts skipped',
  mergeQueue: 'Merge queue',
  scheduled: 'Scheduled sweep',
  depCache: 'Dependency cache',
  remoteCache: 'Remote build cache',
  compilerCache: 'Compiler cache',
  frozenInstall: 'Frozen-lockfile install',
  shardsConfigured: 'Shards',
  timeouts: 'Job timeouts',
  taskRunner: 'Task runner',
  packageManager: 'Package manager',
  fastLint: 'Oxlint or Biome',
  eslint: 'ESLint',
  testRunner: 'Test runner',
  testResults: 'Test results recorded',
  depBotsBatched: 'Dependency updates batched',
  agentsMd: 'Agent instructions',
  agentRules: 'Agent rules or skills',
  preCommit: 'Pre-commit hooks',
};

const shown = (v: unknown) =>
  v === null ? 'unknown' : v === true ? 'yes' : v === false ? 'no' : Array.isArray(v) ? (v.length ? v.join(', ') : 'no') : String(v);

export const practicesBlock = (pr: Practices) => {
  const width = Math.max(...Object.values(LABELS).map((l) => l.length));
  const lines = Object.entries(LABELS).map(([key, label]) => `  ${label.padEnd(width)}  ${shown(pr[key as keyof typeof LABELS])}`);
  const why = pr.unknown.map((u) => `  Unknown because: ${u}.`);
  return [`Practices (${pr.workflows} workflow file${pr.workflows === 1 ? '' : 's'}):`, ...lines, ...why].join('\n');
};

const LIBRARIES_SHOWN = 8;

const graphText = (g: Stack['graph']) =>
  g.count === null
    ? 'unknown'
    : `${g.count} package${g.count === 1 ? '' : 's'}, ${g.edges} internal edge${g.edges === 1 ? '' : 's'}, depth ${g.maxDepth}, ${g.cycles.length} cycle${g.cycles.length === 1 ? '' : 's'}${g.topFanIn.length ? `; most depended on: ${g.topFanIn.map((p) => `${p.name} (${p.dependents})`).join(', ')}` : ''}`;

/** What the repo is built with, each line "unknown" where its inputs couldn't be read. */
export const stackBlock = (st: Stack) => {
  const or = <T>(v: T | null, f: (x: T) => string) => (v === null ? 'unknown' : f(v) || 'none found');
  const ws = st.workspace;
  const lines: [string, string][] = [
    ['Languages', or(st.languages, (ls) => ls.map(([l, n]) => `${l} ${n}%`).join(', '))],
    ['Workspace', [or(ws.packageManagers, (x) => x.join(', ')), ...(ws.tools?.length ? [ws.tools.join(', ')] : []), st.packages ? pkgText(st.packages) : 'packages unknown'].join(' · ')],
    ['Tests', or(st.testRunners, (x) => x.join(', '))],
    ['Lint, format', or(st.lintFormat, (x) => x.join(', '))],
    ['Libraries', or(st.libraries, (x) => x.slice(0, LIBRARIES_SHOWN).map((l) => `${l.name} (${l.packages})`).join(', '))],
    ['CI runners', or(st.runners, (x) => x.map(([p, n]) => `${p} (${n} job${n === 1 ? '' : 's'})`).join(', '))],
    ['Agent files', or(st.agentFiles, (x) => x.join(', '))],
    ['Package graph', graphText(st.graph)],
  ];
  const width = Math.max(...lines.map(([l]) => l.length));
  return ['Stack:', ...lines.map(([l, v]) => `  ${l.padEnd(width)}  ${v}`), ...st.unknown.map((u) => `  Unknown because: ${u}.`)].join('\n');
};

const listBlock = (title: string, items: { text: string; guide: string }[]) =>
  items.length ? [title, ...items.map((f, i) => `  ${i + 1}. ${f.text}\n     ${f.guide}`)].join('\n') : '';

/** Whole numbers of a unit, in words: "3 hours", never "3h". */
export const ageInWords = (ms: number) => {
  const minutes = Math.round(ms / 60e3);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
};

export interface Provenance {
  calls: number;
  fromCache: number;
  oldestCachedAt: number | undefined;
  cacheDir: string | undefined;
  savedTo: string | undefined;
}

export const provenanceLine = (v: Provenance) => {
  const read = v.fromCache
    ? `Read through gh: ${v.calls} API call${v.calls === 1 ? '' : 's'} live and ${v.fromCache} answer${v.fromCache === 1 ? '' : 's'} from the cache in ${v.cacheDir}, the oldest ${ageInWords(Date.now() - v.oldestCachedAt!)} old.`
    : `Read live through gh: ${v.calls} API calls${v.cacheDir ? `, cached in ${v.cacheDir}` : ''}.`;
  const wrote = v.savedTo ? `Saved the report to ${v.savedTo}.` : v.cacheDir ? '' : 'Nothing was written to disk.';
  return [read, 'Job logs were read in memory and not kept.', wrote].filter(Boolean).join(' ');
};

export const scoredText = (r: Report, v: Provenance) => {
  const head = r.score === null
    ? `${r.repo}: unscored. ${r.unscored}`
    : `${r.repo}: score ${r.score}/100, grade ${r.grade} (${r.band}) · speed ${r.parts.speed} · reliability ${r.parts.reliability} · efficiency ${r.parts.efficiency} · size ${r.size}`;
  const window = `Window: ${r.window.days ?? 0} days, ${r.window.runs}${r.window.truncated ? ` of ${r.window.runsInPeriod}` : ''} PR runs, from ${r.defaultBranch}'s workflows and Actions history.`;

  return [
    head,
    window,
    r.score === null ? profileLine(r) : `To fix it with your agent, paste the AI Quickstart prompt from https://github.com/ref-0/ci-doctor, then "Start from this CI report:" and this block:\n\n${promptBlock(r)}`,
    r.jobGraph && graphBlock(r.jobGraph),
    practicesBlock(r.practices),
    stackBlock(r.stack),
    listBlock('Fix first:', r.fixes),
    listBlock('Notes:', r.notes),
    provenanceLine(v),
  ]
    .filter(Boolean)
    .join('\n\n');
};

export const inventoryText = (r: Inventory) => {
  const pf = r.profile;
  return [
    `${r.checkout}: unscored. ${r.unscored}`,
    `From the checkout's tracked files: ~${fmtK(pf.linesOfCode)} lines of source, tests ${p(pf.testShare)} of it, ${pkgText(pf.packages)}, ${pf.files} files.`,
    practicesBlock(r.practices),
    stackBlock(r.stack),
    listBlock('Fix first:', r.fixes),
    listBlock('Notes:', r.notes),
    'Read only the checkout: no GitHub calls. Nothing was written to disk.',
  ]
    .filter(Boolean)
    .join('\n\n');
};
