// What a score rests on. The scorer reads only GitHub Actions, so a repo whose pull requests wait on another CI
// would be scored on whatever small checks it also runs there. This reads the checks other CIs left on a few
// pushes, finds their configs in the tree, and says how sure the score is: no score when the evidence is too
// thin, and otherwise a confidence with its reasons.
import type { Gh } from './gh.ts';

/** How many of people's newest pushes have their checks from outside GitHub Actions read: two calls each. */
export const SAMPLED_PUSHES = 3;
/** Pushes on which another CI must have run longer than the Actions checks for the score to be withheld. */
export const OUTSIDE_DECIDES = 2;
/** With another CI's config in the tree, a wait under this share of what's typical for the size is too small to score. */
export const THIN_WAIT = 0.1;
/** Timed pushes under which confidence is low, and under which it's medium. */
export const FEW_PUSHES = { low: 10, medium: 20 };
/** The share of job minutes whose runner's size must be known, or the vCPU-minutes are mostly a guess. */
export const SIZED_ENOUGH = 0.5;
/** The share of the score's weight that must be measured for confidence not to be low. */
export const MEASURED_LOW = 0.8;

/** What the score can't know from outside, said beside every score. */
export const UNSEEN =
  "The score reads GitHub Actions' history: how long pull requests wait, how often checks fail or pass only on a rerun, and how much CI runs for each merged PR. It doesn't see what the tests prove, what CI costs in money, or checks that run outside GitHub Actions.";

interface Ci {
  name: string;
  /** Its GitHub App's slug, on a check run. */
  app?: RegExp;
  /** Its context, on a commit status. */
  status?: RegExp;
  /** Its config file in the repo, at the paths the CI itself reads. Left out where the file as often holds a deploy as a check. */
  config?: RegExp;
}

// CIs that report to a commit from outside GitHub Actions. A runner provider, such as Blacksmith, runs Actions
// jobs, so it isn't one.
const OUTSIDE: Ci[] = [
  { name: 'Azure Pipelines', app: /^azure-pipelines$/, config: /^azure-pipelines[^/]*\.ya?ml$|^(\.azure-pipelines|\.azuredevops|\.azure\/pipelines|eng\/pipelines)\/.+\.ya?ml$/ },
  { name: 'CircleCI', app: /^circleci(-checks)?$/, status: /^ci\/circleci/, config: /^\.circleci\/config\.yml$/ },
  { name: 'Buildkite', app: /^buildkite$/, status: /^buildkite\//, config: /^\.buildkite\/.+\.(ya?ml|json)$/ },
  { name: 'Travis CI', app: /^travis-ci$/, status: /^continuous-integration\/travis-ci/, config: /^\.travis\.yml$/ },
  { name: 'Cirrus CI', app: /^cirrus-ci$/, config: /^\.cirrus\.(yml|star)$/ },
  { name: 'AppVeyor', app: /^appveyor$/, status: /^continuous-integration\/appveyor/, config: /^\.?appveyor\.yml$/ },
  { name: 'Jenkins', app: /^jenkins(-ci)?$/, status: /^continuous-integration\/jenkins|^jenkins(\/|$)/i, config: /^(\.?ci\/|\.?jenkins\/)?Jenkinsfile(\.(?!md$|txt$)[\w-]+)?$/ },
  { name: 'GitLab CI', app: /^gitlab(-ci)?$/, status: /^ci\/gitlab/, config: /^\.gitlab-ci\.yml$/ },
  { name: 'Drone', status: /^continuous-integration\/drone/, config: /^\.drone\.(yml|jsonnet|star)$/ },
  { name: 'Woodpecker', status: /^ci\/woodpecker/, config: /^\.woodpecker(\.ya?ml$|\/.+\.ya?ml$)/ },
  { name: 'TeamCity', app: /^teamcity/, status: /teamcity/i, config: /^\.teamcity\/.+/ },
  { name: 'Semaphore', app: /^semaphore/, status: /^ci\/semaphoreci/, config: /^\.semaphore\/.+\.ya?ml$/ },
  { name: 'Bitrise', app: /^bitrise$/, status: /^ci\/bitrise/, config: /^bitrise\.yml$/ },
  { name: 'Google Cloud Build', app: /^google-cloud-build$/ },
  { name: 'AWS CodeBuild', app: /^aws-codebuild/, status: /^codebuild/i },
  { name: 'Prow', status: /^pull-[a-z0-9]+-[a-z0-9-]+$/ },
];
// Review bots, deploy previews, coverage and licence checks aren't CI, whatever else their name holds.
const NOT_CI = /preview|deploy|review|coverage|licen[cs]e|\bcla\b|\bbot\b/i;

/** Each outside CI with a config in the tree, and the first such file. */
export const outsideConfigs = (paths: string[]) =>
  OUTSIDE.flatMap((ci) => {
    const path = ci.config && paths.find((p) => ci.config!.test(p));
    return path ? [{ ci: ci.name, path }] : [];
  });

interface CheckRun {
  status: string;
  started_at: string | null;
  completed_at: string | null;
  app?: { slug?: string };
}

interface Status {
  context: string;
  state: string;
  created_at: string;
}

export interface OutsidePush {
  sha: string;
  /** This push's wait on GitHub Actions, in minutes. */
  actionsMin: number;
  /** Each outside CI on it, and the minutes from the push to the latest end known of its work: null when none is. */
  ci: { name: string; minutes: number | null }[];
}

/** A CI's work belongs to a push when it starts within this long after it: later work came from another event, such as a rerun or a second pull request on the same commit. */
export const PUSH_CHECKS_WINDOW = 30 * 60e3;
// A later stage of the same work starts within this long of the stage before it ending.
const STAGE_GAP = 10 * 60e3;
// Clocks differ: a check may be stamped a little before the run that marks the push.
const CLOCK_SLACK = 2 * 60e3;
// Work with no end is still going only on a fresh push; on an old one it was abandoned.
const FRESH = 24 * 3600e3;

/**
 * One push's outside CIs, from its check runs and commit statuses, each with the minutes from the push to
 * the latest end known of that CI's work on it. When each finished tells who decides the wait, not how long
 * each ran. The minutes are a floor: work that can't be tied to the push, or has no end, isn't counted.
 */
export const outsideCiOf = (checks: CheckRun[], statuses: Status[], pushedAt: number, now = Date.now()) => {
  const going = now - pushedAt < FRESH ? now : null;

  return OUTSIDE.flatMap((ci) => {
    const runs = checks.filter((c) => ci.app?.test(c.app?.slug ?? '') && !NOT_CI.test(c.app?.slug ?? ''));
    const contexts = Map.groupBy(statuses.filter((s) => ci.status?.test(s.context) && !NOT_CI.test(s.context)), (s) => s.context);
    if (!runs.length && !contexts.size) return [];

    // Each stretch of the CI's work: a check run, queued ones from the push, or a status context, from its
    // first mark after the push to the first that isn't pending. A status is one moment, so a context marked
    // once, already ended, starts and ends there.
    const spans = [
      ...runs.map((c) => ({ from: c.started_at ? Date.parse(c.started_at) : pushedAt, to: c.completed_at ? Date.parse(c.completed_at) : going })),
      ...[...contexts.values()].flatMap((marks) => {
        const after = marks.map((s) => ({ state: s.state, at: Date.parse(s.created_at) })).filter((s) => s.at >= pushedAt - CLOCK_SLACK).sort((a, b) => a.at - b.at);
        return after.length ? [{ from: after[0]!.at, to: after.find((s) => s.state !== 'pending')?.at ?? going }] : [];
      }),
    ];

    // The push's own work starts within the window, or soon after its earlier work ends, as a later stage does.
    let horizon = pushedAt + PUSH_CHECKS_WINDOW;
    let end: number | null = null;
    for (const span of spans.filter((each) => each.from >= pushedAt - CLOCK_SLACK).sort((a, b) => a.from - b.from)) {
      if (span.from > horizon) break;
      if (span.to === null) continue;
      end = Math.max(end ?? pushedAt, span.to);
      horizon = Math.max(horizon, span.to + STAGE_GAP);
    }
    return [{ name: ci.name, minutes: end === null ? null : Math.round(((end - pushedAt) / 60e3) * 10) / 10 }];
  });
};

// Check runs a commit can hold past the first page: 3 pages is 300.
const CHECK_PAGES = 3;

/**
 * The outside CIs on people's newest pushes. `sampled` is how many pushes were asked about and `read` how
 * many GitHub answered in full: a token without read access to checks or statuses gets none, which is
 * unknown, not absent.
 */
export const outsideOn = (gh: Gh, repo: string, pushes: { sha: string; at: number; wait: number }[]) => {
  const asked = pushes.slice(0, SAMPLED_PUSHES);
  let read = 0;
  const seen: OutsidePush[] = [];
  for (const push of asked) {
    const checks: CheckRun[] = [];
    let whole = false;
    for (let page = 1; page <= CHECK_PAGES; page++) {
      const answer = gh.json(`repos/${repo}/commits/${push.sha}/check-runs?per_page=100${page > 1 ? `&page=${page}` : ''}`, { absentOn: [403, 404, 422] });
      if (!Array.isArray(answer?.check_runs)) break;
      checks.push(...answer.check_runs);
      whole = checks.length >= (answer.total_count ?? 0) || answer.check_runs.length < 100;
      if (whole) break;
    }
    if (!whole) continue;
    const statuses = gh.json(`repos/${repo}/commits/${push.sha}/statuses?per_page=100`, { absentOn: [403, 404, 422] });
    if (!Array.isArray(statuses)) continue;

    read++;
    const ci = outsideCiOf(checks, statuses, push.at);
    if (ci.length) seen.push({ sha: push.sha, actionsMin: Math.round(push.wait * 10) / 10, ci });
  }
  return { sampled: asked.length, read, pushes: seen };
};

const MEASURES: Record<string, string> = {
  'reliability.flakes': 'the share of pushes green only on a rerun',
  'reliability.mainRed': "the default branch's red rate",
  'efficiency.minutesPerPr': 'vCPU-minutes per merged PR',
  'efficiency.runsPerPr': 'runs per merged PR',
  'efficiency.setup': 'setup time',
  'efficiency.queue': 'queue time',
  'efficiency.shardIdle': 'shard balance',
  'efficiency.path': 'how the jobs are wired',
  'efficiency.graphs': 'the package and task graphs',
};

const list = (xs: string[], last = 'and') => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${last} ${xs.at(-1)}`);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;
const words = (minutes: number) => {
  const shown = minutes < 10 ? Math.round(minutes * 10) / 10 : Math.round(minutes);
  return `${shown} minute${shown === 1 ? '' : 's'}`;
};
const linesWords = (lines: number) => (lines >= 10_000 ? Math.round(lines / 1000) * 1000 : Math.round(lines)).toLocaleString('en-US');
/** Another CI decides a push's wait when it ended more than this long after the Actions checks did. */
export const DECIDES_BY = 1;

export interface EvidenceInputs {
  /** Pushes timed, their p50 wait in minutes, and reruns whose first attempt wasn't read. */
  timed: number;
  p50: number;
  rerunsUnread: number;
  /** The wait typical for the repo's size, in minutes, and its lines of code. */
  expectedWait: number;
  linesOfCode: number;
  /** From `scoreOf`: the share of the score's weight measured, each measure that wasn't, and each part with none made. */
  measured: number;
  missing: string[];
  empty: string[];
  /** The share of the sampled job minutes whose runner's size is known: NaN when no job was sampled. */
  sizedShare: number;
  configs: { ci: string; path: string }[];
  /** GitHub cut the file tree short, so a config past the cut wasn't seen. */
  treeTruncated: boolean;
  outside: { sampled: number; read: number; pushes: OutsidePush[] };
}

/**
 * Whether there's enough to score, and how sure the score is. `thin` is the reason to withhold it: another
 * CI decides the wait, the Actions checks are too small for a repo that keeps another CI's config, or a
 * whole part of the score went unmeasured.
 */
export const evidenceOf = (o: EvidenceInputs) => {
  // On each push, the CIs still at work after the Actions checks ended: the ones the pull request was still waiting on.
  const decides = (p: OutsidePush) => p.ci.filter((c) => c.minutes !== null && c.minutes > p.actionsMin + DECIDES_BY);
  const longer = o.outside.pushes.filter((p) => decides(p).length);
  const names = (cis: { name: string }[]) => [...new Set(cis.map((c) => c.name))];
  const deciding = names(longer.flatMap(decides));
  const small = o.p50 < THIN_WAIT * o.expectedWait;

  const thin =
    longer.length >= OUTSIDE_DECIDES
      ? `Pull requests here wait on ${list(deciding)}, outside GitHub Actions: on ${longer.length} of ${o.outside.read} sampled pushes ${deciding.length > 1 ? 'they were' : 'it was'} still running when the Actions checks finished, until at least ${words(median(longer.map((p) => Math.max(...decides(p).map((c) => c.minutes!)))))} after the push against ${words(median(longer.map((p) => p.actionsMin)))} at the median. The score reads only GitHub Actions.`
      : o.configs.length && small
        ? `The repo keeps a config for ${list(o.configs.map((c) => c.ci))} (\`${o.configs[0]!.path}\`), and its GitHub Actions checks on pull requests are small for its size: a wait of ${words(o.p50)}, where about ${words(o.expectedWait)} is typical for ${linesWords(o.linesOfCode)} lines. Its main checks likely run outside GitHub Actions, where the score can't read them.`
        : o.empty.length
          ? `Too little of the score's ${o.empty[0]} part could be measured to score: none of ${list(Object.entries(MEASURES).filter(([m]) => m.startsWith(`${o.empty[0]}.`) && o.missing.includes(m)).map(([, text]) => text), 'or')}.`
          : undefined;

  const alsoRan = names(o.outside.pushes.flatMap((p) => p.ci));
  const unread = o.outside.sampled - o.outside.read;
  const unmeasured = o.missing.map((m) => MEASURES[m] ?? m);
  const reasons = [
    o.timed < FEW_PUSHES.medium && `${o.timed} pushes were timed, under ${o.timed < FEW_PUSHES.low ? FEW_PUSHES.low : FEW_PUSHES.medium}`,
    alsoRan.length > 0 && `${list(alsoRan)} also ran on ${o.outside.pushes.length} of ${o.outside.read} sampled pushes, which the score doesn't read`,
    unread > 0 && `checks from outside GitHub Actions couldn't be read${o.outside.read ? ` on ${unread} of ${o.outside.sampled} sampled pushes` : ''}${o.configs.length ? `, and the repo keeps a config for ${list(o.configs.map((c) => c.ci))}` : ''}`,
    o.treeTruncated && small && !o.configs.length && "GitHub cut the file tree short, so another CI's config may be past the cut",
    unmeasured.length > 0 && `${list(unmeasured)} couldn't be measured`,
    // Only where the minutes were scored, and by the share as it's shown.
    !o.missing.includes('efficiency.minutesPerPr') && Math.round(o.sizedShare * 100) < SIZED_ENOUGH * 100 && `the runners' sizes are known for ${Math.round(o.sizedShare * 100)}% of job minutes, and the rest count as standard runners`,
    o.rerunsUnread > 0 && `${o.rerunsUnread} rerun${o.rerunsUnread === 1 ? "'s first attempt wasn't" : "s' first attempts weren't"} read`,
  ].filter((r): r is string => typeof r === 'string');
  const confidence = thin ? null : o.timed < FEW_PUSHES.low || o.measured < MEASURED_LOW ? ('low' as const) : reasons.length ? ('medium' as const) : ('high' as const);

  return {
    thin,
    evidence: {
      /** How sure the score is; null when there's no score. */
      confidence,
      /** What lowers it, each a clause; empty when it's high. */
      reasons: thin ? [] : reasons,
      /** The share of the score's weight that was measured, 0 to 1. */
      measured: Math.round(o.measured * 100) / 100,
      /** Each measure that couldn't be made, as `part.measure`. */
      missing: o.missing,
      /** Pushes asked about, pushes read in full, the configs found, and each push another CI was on. */
      outsideCi: { sampled: o.outside.sampled, read: o.outside.read, configs: o.configs, pushes: o.outside.pushes },
    },
  };
};

export type Evidence = ReturnType<typeof evidenceOf>['evidence'];
