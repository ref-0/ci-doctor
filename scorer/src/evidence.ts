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
  /** Its config file in the repo. Left out where the file as often holds a deploy as a check. */
  config?: RegExp;
}

// CIs that report to a commit from outside GitHub Actions. A runner provider, such as Blacksmith, runs Actions
// jobs, so it isn't one. Review bots, scanners, deploy previews and licence checks aren't CI.
const OUTSIDE: Ci[] = [
  { name: 'Azure Pipelines', app: /^azure-pipelines$/, config: /(^|\/)azure-pipelines[^/]*\.ya?ml$|^\.azure-pipelines\/|^\.azuredevops\/|^eng\/pipelines\// },
  { name: 'CircleCI', app: /^circleci/, status: /^ci\/circleci/, config: /^\.circleci\/config\.yml$/ },
  { name: 'Buildkite', app: /^buildkite/, status: /^buildkite\//, config: /^\.buildkite\// },
  { name: 'Travis CI', app: /^travis-ci/, status: /^continuous-integration\/travis-ci/, config: /^\.travis\.yml$/ },
  { name: 'Cirrus CI', app: /^cirrus-ci/, config: /^\.cirrus\.(yml|star)$/ },
  { name: 'AppVeyor', app: /^appveyor/, status: /^continuous-integration\/appveyor/, config: /^\.?appveyor\.yml$/ },
  { name: 'Jenkins', app: /jenkins/, status: /^continuous-integration\/jenkins|^jenkins/i, config: /^Jenkinsfile[^/]*$/ },
  { name: 'GitLab CI', app: /^gitlab/, status: /^ci\/gitlab/, config: /^\.gitlab-ci\.yml$/ },
  { name: 'Drone', status: /^continuous-integration\/drone/, config: /^\.drone\.(yml|jsonnet|star)$/ },
  { name: 'Woodpecker', status: /^ci\/woodpecker/, config: /^\.woodpecker(\.ya?ml$|\/)/ },
  { name: 'TeamCity', app: /teamcity/, status: /teamcity/i, config: /^\.teamcity\// },
  { name: 'Semaphore', app: /^semaphore/, status: /^ci\/semaphoreci/, config: /^\.semaphore\// },
  { name: 'Bitrise', app: /^bitrise/, status: /^ci\/bitrise/, config: /^bitrise\.yml$/ },
  { name: 'Google Cloud Build', app: /^google-cloud-build$/ },
  { name: 'AWS CodeBuild', app: /^aws-codebuild/, status: /^codebuild/i },
  { name: 'Prow', status: /^tide$|^pull-[a-z0-9-]+$/ },
];

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
  /** Each outside CI seen on it, and how long it ran: null when only its end was reported. */
  ci: { name: string; minutes: number | null }[];
}

const spanMin = (from: number[], to: number[]) => (from.length && to.length ? Math.round(((Math.max(...to) - Math.min(...from)) / 60e3) * 10) / 10 : null);

/** One push's outside CIs, from its check runs and commit statuses. A run still going has run at least until now. */
export const outsideCiOf = (checks: CheckRun[], statuses: Status[], now = Date.now()) =>
  OUTSIDE.flatMap((ci) => {
    const runs = checks.filter((c) => ci.app?.test(c.app?.slug ?? '') && c.started_at);
    const marks = statuses.filter((s) => ci.status?.test(s.context));
    if (!runs.length && !marks.length) return [];

    const ran = spanMin(runs.map((c) => Date.parse(c.started_at!)), runs.map((c) => (c.completed_at ? Date.parse(c.completed_at) : now)));
    // A status is one moment. A pending one and the one that ended it are a start and an end.
    const marked = marks.length > 1 ? spanMin(marks.map((s) => Date.parse(s.created_at)), marks.map((s) => Date.parse(s.created_at))) : null;
    const minutes = ran === null ? marked : marked === null ? ran : Math.max(ran, marked);
    return [{ name: ci.name, minutes }];
  });

/**
 * The outside CIs on people's newest pushes. `read` is how many pushes' checks GitHub gave: a token
 * without read access to checks gets none, which is unknown, not absent.
 */
export const outsideOn = (gh: Gh, repo: string, pushes: { sha: string; wait: number }[]) => {
  let read = 0;
  const seen: OutsidePush[] = [];
  for (const push of pushes.slice(0, SAMPLED_PUSHES)) {
    const checks = gh.json(`repos/${repo}/commits/${push.sha}/check-runs?per_page=100`, { absentOn: [403, 404, 422] });
    if (checks === undefined) continue;
    const statuses = gh.json(`repos/${repo}/commits/${push.sha}/statuses?per_page=100`, { absentOn: [403, 404, 422] }) ?? [];

    read++;
    const ci = outsideCiOf(checks.check_runs ?? [], statuses);
    if (ci.length) seen.push({ sha: push.sha, actionsMin: Math.round(push.wait * 10) / 10, ci });
  }
  return { read, pushes: seen };
};

const MEASURES: Record<string, string> = {
  'reliability.flakes': 'the share of pushes green only on a rerun',
  'reliability.mainRed': "the default branch's red rate",
  'efficiency.minutesPerPr': 'minutes per merged PR',
  'efficiency.runsPerPr': 'runs per merged PR',
  'efficiency.setup': 'setup time',
  'efficiency.queue': 'queue time',
  'efficiency.shardIdle': 'shard balance',
};

const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;
const words = (minutes: number) => `${minutes < 10 ? Math.round(minutes * 10) / 10 : Math.round(minutes)} minute${minutes === 1 ? '' : 's'}`;

export interface EvidenceInputs {
  /** Pushes timed, their p50 wait in minutes, and reruns whose first attempt wasn't read. */
  timed: number;
  p50: number;
  rerunsUnread: number;
  /** The wait typical for the repo's size, in minutes, and its lines of code. */
  expectedWait: number;
  linesOfCode: number;
  /** From `scoreOf`: the share of the score's weight measured, and each measure that wasn't. */
  measured: number;
  missing: string[];
  /** The share of the sampled job minutes whose runner's size is known: NaN when no job was sampled. */
  sizedShare: number;
  configs: { ci: string; path: string }[];
  outside: { read: number; pushes: OutsidePush[] };
}

/**
 * Whether there's enough to score, and how sure the score is. `thin` is the reason to withhold it: another
 * CI decides the wait, the Actions checks are too small for a repo that keeps another CI's config, or a
 * whole part of the score went unmeasured.
 */
export const evidenceOf = (o: EvidenceInputs) => {
  const longer = o.outside.pushes.filter((p) => p.ci.some((c) => c.minutes !== null && c.minutes > p.actionsMin));
  const names = (pushes: OutsidePush[]) => [...new Set(pushes.flatMap((p) => p.ci.map((c) => c.name)))];
  const emptyParts = ['reliability', 'efficiency'].filter((part) => {
    const of = Object.keys(MEASURES).filter((m) => m.startsWith(`${part}.`) && m !== 'efficiency.shardIdle');
    return of.every((m) => o.missing.includes(m));
  });

  const thin =
    longer.length >= OUTSIDE_DECIDES
      ? `Pull requests here wait on ${list(names(longer))}, outside GitHub Actions: on ${longer.length} of ${o.outside.read} sampled pushes it ran longer than the Actions checks, ${words(median(longer.map((p) => Math.max(...p.ci.map((c) => c.minutes ?? 0)))))} against ${words(median(longer.map((p) => p.actionsMin)))} at the median. The score reads only GitHub Actions.`
      : o.configs.length && o.p50 < THIN_WAIT * o.expectedWait
        ? `The repo keeps a config for ${list(o.configs.map((c) => c.ci))} (\`${o.configs[0]!.path}\`), and its GitHub Actions checks on pull requests are small for its size: a wait of ${words(o.p50)}, where about ${words(o.expectedWait)} is typical for ${Math.round(o.linesOfCode / 1000).toLocaleString('en-US')},000 lines. Its main checks likely run outside GitHub Actions, where the score can't read them.`
        : emptyParts.length
          ? `None of the score's ${emptyParts[0]} measures could be made (${list(Object.entries(MEASURES).filter(([m]) => m.startsWith(`${emptyParts[0]}.`) && o.missing.includes(m)).map(([, text]) => text))}), so there's too little to score.`
          : undefined;

  const alsoRan = names(o.outside.pushes);
  const unmeasured = o.missing.map((m) => MEASURES[m] ?? m);
  const reasons = [
    o.timed < FEW_PUSHES.medium && `${o.timed} pushes were timed, under ${o.timed < FEW_PUSHES.low ? FEW_PUSHES.low : FEW_PUSHES.medium}`,
    alsoRan.length > 0 && `${list(alsoRan)} also ran on ${o.outside.pushes.length} of ${o.outside.read} sampled pushes, which the score doesn't read`,
    o.outside.read === 0 && `checks from outside GitHub Actions couldn't be read${o.configs.length ? `, and the repo keeps a config for ${list(o.configs.map((c) => c.ci))}` : ''}`,
    unmeasured.length > 0 && `${list(unmeasured)} couldn't be measured`,
    o.sizedShare < SIZED_ENOUGH && `the runners' sizes are known for ${Math.round(o.sizedShare * 100)}% of job minutes, and the rest count as standard runners`,
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
      measured: o.measured,
      /** Each measure that couldn't be made, as `part.measure`. */
      missing: o.missing,
      outsideCi: { sampled: o.outside.read, configs: o.configs, pushes: o.outside.pushes },
    },
  };
};

export type Evidence = ReturnType<typeof evidenceOf>['evidence'];
