// The checks a submitted report must pass before ci-doctor-db takes it. `--submit` runs them before sending, and the
// data repo's workflow runs the same function on the file a pull request adds. They catch nonsense and hand-edited
// scores, and nothing more: they read no API, and they don't measure the repo again.
import { MEASURED_LOW } from './evidence.ts';
import { isRepoName } from './repo.ts';
import { band, grade, GUIDE, MIN_TIMED, scoreOf, sizeClass, type Inputs } from './score.ts';
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
  ['evidence', 'object'],
  ['evidence.confidence', 'string|null'],
];

/** The longest string or key a report holds, in characters. Stored reports' longest outside the fields below is about 300. */
export const MAX_STRING = 400;
// A field is named by its steps from the report's root, EACH standing for any place in an array, so a key that only
// looks like a path (`fixes.0.text` at the root) is never taken for the field.
const EACH = Symbol('each');
type Step = string | typeof EACH;
const among = (fields: Step[][], steps: Step[]) => fields.some((f) => f.length === steps.length && f.every((step, i) => step === steps[i]));
/** A package cycle is named whole, one package after another: 4,920 characters on the biggest real one. */
export const MAX_LONG_STRING = 8000;
const LONG_STRINGS: Step[][] = [['fixes', EACH, 'text'], ['graphs', 'packages', 'flags', EACH, 'subject'], ['graphs', 'packages', 'chain', EACH]];
// The only links a report holds are its fixes' and notes' guides, each a page of ci-doctor's guide. No real report
// holds a link anywhere else, and one in a fix's words would read on the site as ci-doctor's own advice.
const GUIDES: Step[][] = [['fixes', EACH, 'guide'], ['notes', EACH, 'guide']];
const LINK = /:\/\/|\bwww\./i;
const GUIDE_PAGE = /^\d{2}-[a-z0-9-]+\.md(#[\w-]+)?$/;
// Control characters (newline and tab too), bidi overrides and isolates, the report block's closing tag and a code fence:
// each could change what a page or an agent's prompt shows around the text.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]|<\/ci-report|```/i;

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

/**
 * A value from the file, safe to print in a problem line, which the data repo's check posts as a comment: only
 * `[\w./:@+-]`, at most 60 characters, in backticks. Numbers and booleans print as they are.
 */
export const shown = (x: unknown) => {
  if (typeof x === 'number' || typeof x === 'boolean' || x === null || x === undefined) return String(x);
  const s = String(typeof x === 'object' ? JSON.stringify(x) : x).replace(/[^\w./:@+-]/g, '');
  return `\`${s.length > 60 ? `${s.slice(0, 60)}…` : s}\``;
};

/** One walk over the report: each number that isn't finite (`1e999` parses to Infinity), and each string or key that's unsafe or too long. */
const walk = (x: unknown, path: string, steps: Step[], out: { nonFinite: string[]; strings: string[] }) => {
  const look = (s: string, where: string, what: string, cap: number, link: boolean) => {
    if (UNSAFE.test(s)) out.strings.push(`${where} holds ${what} with a control character, a bidi override, a code fence or \`</ci-report\`.`);
    if (s.length > cap) out.strings.push(`${where} holds ${what} of ${s.length} characters; at most ${cap}.`);
    if (!link && LINK.test(s)) out.strings.push(`${where} holds ${what} with a link; a report's only links are its fixes' and notes' guides.`);
  };
  if (typeof x === 'number' && !Number.isFinite(x)) out.nonFinite.push(path);
  else if (typeof x === 'string') look(x, shown(path), 'a string', among(LONG_STRINGS, steps) ? MAX_LONG_STRING : MAX_STRING, among(GUIDES, steps));
  else if (Array.isArray(x)) x.forEach((v, i) => walk(v, `${path}.${i}`, [...steps, EACH], out));
  else if (x && typeof x === 'object')
    for (const [k, v] of Object.entries(x)) {
      look(k, path ? shown(path) : 'The report', 'a key', MAX_STRING, false);
      walk(v, path ? `${path}.${k}` : k, [...steps, k], out);
    }
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
 * stored. It reads no API, and a line never repeats a string from the file but through `shown`.
 */
export const smokeCheck = (text: string, { path, now = Date.now(), version: release = VERSION }: SmokeOptions = {}): string[] => {
  // 1. It parses, fits, has the fields that are read, of their types, and holds only strings that are safe to show.
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
  const found = walk(r, '', [], { nonFinite: [], strings: [] });
  if (found.strings.length) return found.strings;
  // A report with no score adds nothing to compare, and its reason is free text: there's nothing to submit.
  if (r.score === null) return [`It has no score, so there's nothing to submit. The scorer said: ${shown(r.unscored)}`];

  const problems: string[] = [];

  // 2. The repo and date match where it's filed, and the date is today's or yesterday's.
  if (!isRepoName(r.repo)) problems.push(`repo ${shown(r.repo)} isn't owner/name.`);
  else if (path !== undefined && path !== submissionPath(r.repo, r.date)) problems.push(`The file is at ${shown(path)}, but a report of ${shown(r.repo)} for ${shown(r.date)} goes at ${shown(submissionPath(r.repo, r.date))}.`);
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = new Date(now - DAY).toISOString().slice(0, 10);
  if (r.date !== today && r.date !== yesterday) problems.push(`The report is dated ${shown(r.date)}; a submission is from today or yesterday (${today} or ${yesterday}, UTC). Score the repo again.`);
  if (!/^[\w-]+$/.test(r.submitted.by)) problems.push(`submitted.by ${shown(r.submitted.by)} isn't a GitHub login.`);
  if (!Number.isFinite(Date.parse(r.submitted.at))) problems.push(`submitted.at ${shown(r.submitted.at)} isn't a time.`);

  // 3. The current release made it.
  if (typeof r.scorerVersion !== 'string') problems.push(`It doesn't say which scorer made it, so an older one did. Update and run again: \`npx @ref0/ci-doctor@latest --submit\`.`);
  else if (newer(r.scorerVersion, release)) problems.push(`It was made by ci-doctor ${shown(r.scorerVersion)}, newer than the ${release} this check runs. The check needs updating first, so it's left for a maintainer.`);
  else if (r.scorerVersion !== release) problems.push(`It was made by ci-doctor ${shown(r.scorerVersion)}, and submissions come from the current release, ${release}. Update and run again: \`npx @ref0/ci-doctor@latest --submit\`.`);

  // 4. Numbers in range and in order, and links only into the guide.
  for (const field of found.nonFinite) problems.push(`${shown(field)} isn't a finite number.`);
  const scores = [['score', r.score], ...PARTS.map((p) => [`parts.${p}`, r.parts[p]])] as [string, unknown][];
  for (const [field, s] of scores) if (typeof s === 'number' && (s < 0 || s > 100)) problems.push(`${field} is ${s}; scores run 0 to 100.`);
  for (const field of RATES) if (typeof at(r, field) === 'number' && (at(r, field) < 0 || at(r, field) > 1)) problems.push(`${field} is ${at(r, field)}; a share runs 0 to 1.`);
  for (const field of NOT_NEGATIVE) if (typeof at(r, field) === 'number' && at(r, field) < 0) problems.push(`${field} is ${at(r, field)}; it can't be negative.`);
  for (const [a, b] of [['wait.p50', 'wait.p75'], ['wait.p75', 'wait.p90'], ['main.p50', 'main.p90'], ['wait.timed', 'wait.heads']] as const)
    if (Number.isFinite(at(r, a)) && Number.isFinite(at(r, b)) && at(r, a) > at(r, b)) problems.push(`${a} is ${at(r, a)}, more than ${b}, ${at(r, b)}.`);
  if (r.wait.timed < MIN_TIMED) problems.push(`It's scored on ${r.wait.timed} timed PR pushes; a score needs ${MIN_TIMED}.`);
  for (const list of ['fixes', 'notes'] as const)
    r[list].forEach((x: any, i: number) => {
      if (typeof x?.guide !== 'string' || !x.guide.startsWith(GUIDE) || !GUIDE_PAGE.test(x.guide.slice(GUIDE.length))) problems.push(`${list}[${i}].guide isn't a page of ci-doctor's guide, ${GUIDE}.`);
    });
  if (problems.length) return problems;

  // 5. The score, grade, parts, detail and size are what its own measures give, within a point for rounding, and the
  // measures are enough to score on, by the rules `measure` applies.
  const again = scoreOf(inputsOf(r));
  const gives = (x: number | null | undefined) => (typeof x === 'number' && Number.isFinite(x) ? x : 'none');
  const near = (want: number | null | undefined, got: unknown) => typeof got === 'number' && typeof want === 'number' && Number.isFinite(want) && Math.abs(want - got) <= 1;
  if (!near(again.score, r.score)) problems.push(`score is ${shown(r.score)}, but its own measures give ${gives(again.score)}.`);
  for (const p of PARTS) if (!near(again.parts[p], r.parts[p])) problems.push(`parts.${p} is ${shown(r.parts[p])}, but its own measures give ${gives(again.parts[p])}.`);
  for (const [part, measures] of Object.entries(again.detail))
    for (const [m, want] of Object.entries(measures)) {
      const got = r.detail[part]?.[m];
      if (!(want === null ? got === null : near(want, got))) problems.push(`detail.${part}.${m} is ${shown(got)}, but its own measures give ${gives(want)}.`);
    }
  if (r.grade !== grade(r.score)) problems.push(`grade is ${shown(r.grade)}, but a score of ${r.score} is ${grade(r.score)}.`);
  if (r.band !== band(r.score)) problems.push(`band is ${shown(r.band)}, but a score of ${r.score} is ${band(r.score)}.`);
  // headsPerWeek is rounded, and the size was taken before it was.
  const sizes = [sizeClass(r.headsPerWeek - 0.5, r.profile.linesOfCode), sizeClass(r.headsPerWeek + 0.5, r.profile.linesOfCode)];
  if (!sizes.includes(r.size)) problems.push(`size is ${shown(r.size)}, but ${r.headsPerWeek} PR pushes a week and ${r.profile.linesOfCode} lines are ${sizes[0]}.`);
  for (const part of again.empty) problems.push(`None of its ${part} part's measures are there, and the scorer gives no score without them.`);
  if (again.measured < MEASURED_LOW && r.evidence.confidence !== 'low') problems.push(`Only ${Math.round(again.measured * 100)}% of the score's weight was measured, which the scorer calls low confidence, but evidence.confidence is ${shown(r.evidence.confidence)}.`);
  return problems;
};
