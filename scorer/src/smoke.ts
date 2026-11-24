// The checks a submitted report must pass before ci-doctor-db takes it. `--submit` runs them before sending, and the
// data repo's workflow runs the same function on the file a pull request adds. They catch nonsense and hand-edited
// scores, and nothing more: they read no API, and they don't measure the repo again.
import { isRepoName } from './repo.ts';
import { band, grade, MIN_TIMED, scoreOf, type Inputs } from './score.ts';
import { VERSION } from './version.ts';

/** A submitted file's size limit, in bytes: GitHub's contents API gives a file's content inline up to 1 MB. Stored reports run 10 to 210 KB. */
export const SUBMISSION_MAX_BYTES = 1_000_000;

/** Where ci-doctor-db keeps a repo's report for a day. */
export const submissionPath = (repo: string, date: string) => `reports/${repo.replace('/', '__')}/${date}.json`;

const DAY = 24 * 3600e3;
const n = (x: unknown) => (typeof x === 'number' ? x : NaN);

/** A stored report's score inputs, as `measure` passed them to `scoreOf`; a measure the JSON holds as null is unknown. */
export const inputsOf = (r: any): Inputs => ({
  p50: n(r.wait?.p50),
  p90: n(r.wait?.p90),
  linesOfCode: n(r.profile?.linesOfCode),
  passedOnRerunRate: n(r.wait?.passedOnRerunRate),
  mainRedRate: n(r.main?.redRate),
  vcpuMinutesPerMergedPr: n(r.efficiency?.vcpuMinutesPerMergedPr),
  runsPerMergedPr: n(r.profile?.runsPerMergedPr),
  setupMinPerJob: n(r.jobs?.setupMinPerJob),
  queueP90Sec: n(r.jobs?.queueP90Sec),
  shardIdleTail: n(r.jobs?.shard?.idleTail),
});

// The fields ci-doctor-db's import and the score site read, with the types each may have. `undefined` means it may be left out.
const FIELDS: [string, string][] = [
  ['repo', 'string'],
  ['date', 'string'],
  ['submitted', 'object'],
  ['submitted.by', 'string'],
  ['submitted.at', 'string'],
  ['score', 'number|null'],
  ['grade', 'string|null'],
  ['band', 'string|null'],
  ['unscored', 'string|undefined'],
  ['parts', 'object'],
  ['detail', 'object'],
  ['size', 'string'],
  ['headsPerWeek', 'number'],
  ['profile', 'object'],
  ['profile.linesOfCode', 'number'],
  ['profile.languages', 'array'],
  ['profile.runsPerMergedPr', 'number|null|undefined'],
  ['window', 'object'],
  ['window.days', 'number'],
  ['window.runs', 'number'],
  ['window.truncated', 'boolean'],
  ['wait', 'object'],
  ['wait.heads', 'number'],
  ['wait.timed', 'number'],
  ['wait.p50', 'number|null'],
  ['wait.p75', 'number|null'],
  ['wait.p90', 'number|null'],
  ['wait.redRate', 'number|null'],
  ['wait.passedOnRerunRate', 'number|null'],
  ['main', 'object'],
  ['main.redRate', 'number|null'],
  ['efficiency', 'object'],
  ['efficiency.jobMinutesPerMergedPr', 'number|null'],
  ['efficiency.vcpuMinutesPerMergedPr', 'number|null'],
  ['jobs', 'object|undefined'],
  ['jobs.setupShare', 'number|null|undefined'],
  ['jobs.setupMinPerJob', 'number|null|undefined'],
  ['jobs.queueP90Sec', 'number|null|undefined'],
  ['tests', 'object|undefined'],
  ['botRunShare', 'number|null'],
  ['practices', 'object'],
  ['stack', 'object'],
  ['fixes', 'array'],
  ['notes', 'array'],
  ['apiCalls', 'number'],
];

// Shares, 0 to 1, and waits, minutes and counts, never negative. A field left out or null isn't checked.
const RATES = ['wait.redRate', 'wait.passedOnRerunRate', 'wait.rerunRate', 'wait.cancelledRate', 'main.redRate', 'botRunShare', 'jobs.setupShare', 'efficiency.sizedShare'];
const NOT_NEGATIVE = [
  'headsPerWeek', 'profile.linesOfCode', 'profile.runsPerMergedPr', 'window.days', 'window.runs', 'wait.heads', 'wait.timed',
  'wait.p50', 'wait.p75', 'wait.p90', 'main.p50', 'main.p90', 'jobs.spanMin', 'jobs.jobMinutes', 'jobs.queueP50Sec', 'jobs.queueP90Sec',
  'jobs.setupMinPerJob', 'efficiency.prJobMinutesPerDay', 'efficiency.jobMinutesPerMergedPr', 'efficiency.prVcpuMinutesPerDay',
  'efficiency.vcpuMinutesPerMergedPr', 'apiCalls',
];
const PARTS = ['speed', 'reliability', 'efficiency'];

const at = (r: any, path: string) => path.split('.').reduce((x, k) => (x === null || typeof x !== 'object' ? undefined : x[k]), r);
const kind = (x: unknown) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x);
const version = (v: string) => v.split('.').map(Number);
const newer = (a: string, b: string) => {
  const [x, y] = [version(a), version(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

/** Every number anywhere in the report that isn't finite, by path. JSON can't hold NaN, but `1e999` parses to Infinity. */
const nonFinite = (x: unknown, path: string, out: string[]) => {
  if (typeof x === 'number' && !Number.isFinite(x)) out.push(path);
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) nonFinite(v, path ? `${path}.${k}` : k, out);
  return out;
};

export interface SmokeOptions {
  /** The path the file is added at, in ci-doctor-db: it must be the report's own. */
  path?: string;
  /** The time it's checked at, for the date: today or yesterday, UTC. */
  now?: number;
  /** The scorer release that submissions must come from. Default: this package's version. */
  version?: string;
}

/**
 * What's wrong with a submitted report file, in plain words; empty when it passes. `text` is the file as it would be
 * stored. It reads no API.
 */
export const smokeCheck = (text: string, { path, now = Date.now(), version: release = VERSION }: SmokeOptions = {}): string[] => {
  // 1. It parses, fits, and has the fields that are read, with their types.
  const bytes = Buffer.byteLength(text);
  if (bytes > SUBMISSION_MAX_BYTES) return [`The file is ${Math.ceil(bytes / 1000)} KB; a report is at most ${SUBMISSION_MAX_BYTES / 1000} KB.`];
  let r: any;
  try {
    r = JSON.parse(text);
  } catch {
    return ["The file isn't JSON."];
  }
  if (kind(r) !== 'object') return ["The file isn't a report: it holds no JSON object."];
  const wrong = FIELDS.filter(([field, types]) => !types.split('|').includes(kind(at(r, field))));
  if (wrong.length)
    return wrong.map(([field, types]) => `${field} is ${kind(at(r, field)) === 'undefined' ? 'missing' : `a ${kind(at(r, field))}`}; it should be ${types.replace(/\|undefined$/, '').replaceAll('|', ' or ')}.`);

  const problems: string[] = [];

  // 2. The repo and date match where it's filed, and the date is today's or yesterday's.
  if (!isRepoName(r.repo)) problems.push(`repo "${r.repo}" isn't owner/name.`);
  else if (path !== undefined && path !== submissionPath(r.repo, r.date)) problems.push(`The file is at ${path}, but a report of ${r.repo} for ${r.date} goes at ${submissionPath(r.repo, r.date)}.`);
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = new Date(now - DAY).toISOString().slice(0, 10);
  if (r.date !== today && r.date !== yesterday) problems.push(`The report is dated ${r.date}; a submission is from today or yesterday (${today} or ${yesterday}, UTC). Score the repo again.`);
  if (!/^[\w-]+$/.test(r.submitted.by)) problems.push(`submitted.by "${r.submitted.by}" isn't a GitHub login.`);
  if (!Number.isFinite(Date.parse(r.submitted.at))) problems.push(`submitted.at "${r.submitted.at}" isn't a time.`);

  // 3. The current release made it.
  if (typeof r.scorerVersion !== 'string') problems.push(`It doesn't say which scorer made it, so an older one did. Update and run again: \`npx @ref0/ci-doctor@latest --submit\`.`);
  else if (newer(r.scorerVersion, release)) problems.push(`It was made by ci-doctor ${r.scorerVersion}, newer than the ${release} this check runs. The check needs updating first, so it's left for a maintainer.`);
  else if (r.scorerVersion !== release) problems.push(`It was made by ci-doctor ${r.scorerVersion}, and submissions come from the current release, ${release}. Update and run again: \`npx @ref0/ci-doctor@latest --submit\`.`);

  // 4. Numbers in range.
  for (const field of nonFinite(r, '', [])) problems.push(`${field} isn't a finite number.`);
  const scored = r.score !== null;
  const scores = [['score', r.score], ...PARTS.map((p) => [`parts.${p}`, r.parts[p]])] as [string, unknown][];
  for (const [field, s] of scores) if (typeof s === 'number' && (s < 0 || s > 100)) problems.push(`${field} is ${s}; scores run 0 to 100.`);
  for (const field of RATES) if (typeof at(r, field) === 'number' && (at(r, field) < 0 || at(r, field) > 1)) problems.push(`${field} is ${at(r, field)}; a share runs 0 to 1.`);
  for (const field of NOT_NEGATIVE) if (typeof at(r, field) === 'number' && at(r, field) < 0) problems.push(`${field} is ${at(r, field)}; it can't be negative.`);
  if (scored && r.wait.timed < MIN_TIMED) problems.push(`It's scored on ${r.wait.timed} timed PR pushes; a score needs ${MIN_TIMED}.`);
  if (!scored && typeof r.unscored !== 'string') problems.push("It has no score and doesn't say why: an unscored report gives its reason in unscored.");
  if (problems.length) return problems;

  // 5. The score, grade and parts are what its own measures give, within a point for rounding.
  if (!scored) {
    if (r.grade !== null || r.band !== null) problems.push('It has no score, but has a grade or band.');
    return problems;
  }
  const again = scoreOf(inputsOf(r));
  const near = (want: number | undefined, got: unknown) => typeof got === 'number' && Number.isFinite(want) && Math.abs(want! - got) <= 1;
  if (!near(again.score, r.score)) problems.push(`score is ${r.score}, but its own measures give ${again.score}.`);
  for (const p of PARTS) if (!near(again.parts[p], r.parts[p])) problems.push(`parts.${p} is ${r.parts[p] ?? 'missing'}, but its own measures give ${again.parts[p]}.`);
  if (r.grade !== grade(r.score)) problems.push(`grade is ${r.grade}, but a score of ${r.score} is ${grade(r.score)}.`);
  if (r.band !== band(r.score)) problems.push(`band is ${r.band}, but a score of ${r.score} is ${band(r.score)}.`);
  return problems;
};
