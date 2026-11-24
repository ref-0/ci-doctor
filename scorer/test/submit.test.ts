// --submit and the smoke check ci-doctor-db runs on a submitted report, with the gh stub: no test opens a real fork or
// pull request.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { band, grade, GUIDE, smokeCheck, submissionOf, submissionPath } from '../src/index.ts';
import { VERSION } from '../src/version.ts';
import { fakeRepo, type Routes } from './fixtures.ts';
import { checkout, runCli, scratch } from './helpers.ts';

const REPO = 'pip/garden';
const DB = 'ref-0/ci-doctor-db';
const PR = 'https://github.com/ref-0/ci-doctor-db/pull/7';
const ok = (json: unknown) => ({ status: 200, json });
const today = () => new Date().toISOString().slice(0, 10);
const path = () => submissionPath(REPO, today());

/** ci-doctor-db's answers, with Pip's fork or without, and any pull requests already open. */
const dataRepo = ({ fork = true, open = [] as unknown[] } = {}): Routes => ({
  [`repos/${DB}/pulls`]: ok(open),
  'repos/pip/ci-doctor-db': fork ? ok({ full_name: 'pip/ci-doctor-db', fork: true, parent: { full_name: DB } }) : { status: 404, message: 'Not Found' },
  [`POST repos/${DB}/forks`]: ok({ full_name: 'pip/ci-doctor-db' }),
  [`repos/${DB}`]: ok({ full_name: DB, default_branch: 'main' }),
  [`repos/${DB}/git/ref/heads/main`]: ok({ object: { sha: 'f00d' } }),
  'POST repos/pip/ci-doctor-db/git/refs': ok({ ref: 'refs/heads/x' }),
  [`PUT repos/pip/ci-doctor-db/contents/${path()}`]: ok({ content: {} }),
  [`POST repos/${DB}/pulls`]: ok({ html_url: PR }),
});

/** A call as `METHOD path`, or the path alone for a read. */
const callOf = (c: string[]) => {
  const m = c.indexOf('--method');
  return m >= 0 ? `${c[m + 1]} ${c[m + 2]}` : c.at(-1)!;
};
const bodyOf = (c: string[]) => JSON.parse(c.at(-1)!.replace(/^stdin:/, ''));
const writes = (calls: string[][]) => calls.filter((c) => c.includes('--method'));
/** The calls from the check for an open pull request on. */
const submission = (calls: string[][]) => calls.slice(calls.findIndex((c) => c.at(-1)!.startsWith(`repos/${DB}/pulls`))).map(callOf);

describe('--submit', () => {
  it('scores, prints the report, says what it sends, then opens the pull request from the fork', async () => {
    const r = await runCli(['--repo', REPO, '--submit'], { routes: { ...fakeRepo({ repo: REPO }), ...dataRepo() } });

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(submission(r.calls), [
      `repos/${DB}/pulls?state=open&per_page=100`,
      'repos/pip/ci-doctor-db',
      `repos/${DB}`,
      `repos/${DB}/git/ref/heads/main`,
      'POST repos/pip/ci-doctor-db/git/refs',
      `PUT repos/pip/ci-doctor-db/contents/${path()}`,
      `POST ${`repos/${DB}/pulls`}`,
    ]);
    assert.match(r.stdout, new RegExp(`^${REPO}: score \\d+/100`));
    const sending = r.stdout.indexOf(`Sending ${path()} (`);
    assert.ok(sending > r.stdout.indexOf('<ci-report'), 'says what it sends after the report');
    assert.match(r.stdout, /the report above, your login pip and the scorer's version\) to ref-0\/ci-doctor-db, as a pull request from pip\/ci-doctor-db\./);
    assert.match(r.stdout, new RegExp(`Opened ${PR}\\. A check there reads the file`));

    const [ref, put, pr] = writes(r.calls).map(bodyOf);
    assert.equal(ref.sha, 'f00d');
    assert.match(ref.ref, new RegExp(`^refs/heads/submit/pip__garden/${today()}-\\d{6}$`));
    assert.equal(put.branch, ref.ref.replace('refs/heads/', ''));
    const file = Buffer.from(put.content, 'base64').toString('utf8');
    assert.deepEqual(smokeCheck(file, { path: path() }), []);
    const sent = JSON.parse(file);
    assert.equal(sent.repo, REPO);
    assert.equal(sent.scorerVersion, VERSION);
    assert.equal(sent.submitted.by, 'pip');
    assert.deepEqual(Object.keys(sent.read), ['calls', 'fromCache']);
    assert.deepEqual(pr, { title: `Submit ${REPO}, ${today()}`, head: `pip:${put.branch}`, base: 'main', body: pr.body, maintainer_can_modify: true });
  });

  it('forks ci-doctor-db first when there is no fork', async () => {
    const r = await runCli(['--repo', REPO, '--submit'], { routes: { ...fakeRepo({ repo: REPO }), ...dataRepo({ fork: false }) } });

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(submission(r.calls).slice(1, 3), ['repos/pip/ci-doctor-db', `POST repos/${DB}/forks`]);
    assert.match(r.stdout, /as a pull request from a new fork, pip\/ci-doctor-db\./);
    assert.ok(r.stdout.indexOf('Sending') < r.stdout.indexOf('Opened'));
  });

  it('with a pull request of the same file already open, prints its link and sends nothing', async () => {
    const open = [{ html_url: PR, user: { login: 'pip' }, head: { ref: `submit/pip__garden/${today()}-090000` } }];
    const r = await runCli(['--repo', REPO, '--submit'], { routes: { ...fakeRepo({ repo: REPO }), ...dataRepo({ open }) } });

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(writes(r.calls), []);
    assert.match(r.stdout, new RegExp(`Not sent: your pull request ${PR} already adds this report, and is still open\\.`));
    assert.doesNotMatch(r.stdout, /Sending/);
  });

  it("refuses an unscored report after printing it, with the scorer's reason, and sends nothing", async () => {
    const r = await runCli(['--repo', REPO, '--submit', '--json'], { routes: { ...fakeRepo({ repo: REPO, heads: 3 }), ...dataRepo() } });

    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.stdout).score, null, 'stdout holds only the JSON');
    assert.match(r.stderr, /Not submitted: there's no score, so there's nothing to submit\. Only \d PR pushes in the window/);
    assert.deepEqual(writes(r.calls), []);
    assert.ok(!r.calls.some((c) => c.at(-1)!.includes('ci-doctor-db')), 'asks ci-doctor-db nothing');
  });

  it('files the report under the name as GitHub spells it', async () => {
    const routes = { ...fakeRepo({ repo: REPO }), ...dataRepo() };
    routes['repos/Pip/Garden'] = routes[`repos/${REPO}`]!;
    const r = await runCli(['--repo', 'Pip/Garden', '--submit'], { routes });

    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^pip\/garden: score/);
    const put = r.calls.find((c) => callOf(c).startsWith('PUT '))!;
    assert.equal(callOf(put), `PUT repos/pip/ci-doctor-db/contents/${path()}`);
    assert.equal(JSON.parse(Buffer.from(bodyOf(put).content, 'base64').toString('utf8')).repo, REPO);
  });

  it('refuses a private repo before reading the rest, and points to --standing', async () => {
    const r = await runCli(['--repo', 'pip/shed', '--submit'], { routes: { ...fakeRepo({ repo: 'pip/shed', private: true }), ...dataRepo() } });

    assert.equal(r.code, 2);
    assert.match(r.stderr, /Not submitted: pip\/shed is private, and ref-0\/ci-doctor-db is public\. --standing sends only the score and size class\./);
    assert.deepEqual(r.calls.map(callOf), ['user', 'repos/pip/shed']);
  });

  it('asks GitHub whether the repo is private, whatever the cache holds', async () => {
    const cacheDir = join(scratch(), 'cache');
    const env = { CI_DOCTOR_CACHE_DIR: cacheDir };
    const seeded = await runCli(['--repo', 'pip/shed', '--json', '--cache'], { routes: fakeRepo({ repo: 'pip/shed' }), env });
    assert.equal(seeded.code, 0);

    const r = await runCli(['--repo', 'pip/shed', '--submit', '--cache'], { routes: { ...fakeRepo({ repo: 'pip/shed', private: true }), ...dataRepo() }, env });

    assert.equal(r.code, 2);
    assert.match(r.stderr, /Not submitted: pip\/shed is private/);
    assert.ok(!r.calls.map(callOf).some((c) => /^(POST|PUT) /.test(c)));
  });

  it('refuses a checkout with no GitHub history, calling no gh', async () => {
    const r = await runCli(['--submit'], { cwd: checkout() });

    assert.equal(r.code, 2);
    assert.match(r.stderr, /Not submitted: this checkout has no remote, so there's no Actions history to read\. Run it in a checkout of a public GitHub repo, or pass --repo owner\/name\./);
    assert.deepEqual(r.calls, []);
  });

  it('sends only 7-day reports', async () => {
    const r = await runCli(['--repo', REPO, '--submit', '--days', '14'], { routes: fakeRepo({ repo: REPO }) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--submit sends a 7-day report/);
    assert.deepEqual(r.calls, []);
  });
});

describe('smokeCheck', () => {
  let good = '';
  let unscored = '';
  before(async () => {
    const report = async (heads: number) => {
      const r = await runCli(['--repo', REPO, '--json'], { routes: fakeRepo({ repo: REPO, heads }) });
      const parsed = JSON.parse(r.stdout);
      return submissionOf(parsed, parsed.read, 'pip');
    };
    good = await report(20);
    unscored = await report(3);
  });

  const edit = (f: (r: any) => void, text = good) => {
    const r = JSON.parse(text);
    f(r);
    return JSON.stringify(r);
  };
  const check = (text: string, at = path()) => smokeCheck(text, { path: at });

  it('passes a fresh scored report, and fails an unscored one: there is nothing to submit', () => {
    assert.deepEqual(check(good), []);
    assert.match(check(unscored).join(), /^It has no score, so there's nothing to submit\. The scorer said: `Only\d+PRpushes/);
  });

  it('1. holds only strings and keys that are safe to show, and not too long', () => {
    for (const bad of ['two\nlines', 'a\ttab', 'right\u202eto left', 'an \u2066isolate', 'end </CI-Report> here', 'a ``` fence'])
      assert.deepEqual(check(edit((r) => (r.fixes[0].text = bad))), ['`fixes.0.text` holds a string with a control character, a bidi override, a code fence or `</ci-report`.'], bad);
    assert.deepEqual(check(edit((r) => (r.stack['bad\nkey'] = 1))), ['`stack` holds a key with a control character, a bidi override, a code fence or `</ci-report`.']);
    assert.deepEqual(check(edit((r) => (r.notes[0].text = 'x'.repeat(401)))), ['`notes.0.text` holds a string of 401 characters; at most 400.']);
    // A package cycle is named whole, so its fields may run longer.
    assert.deepEqual(check(edit((r) => (r.graphs.packages.chain = ['p'.repeat(5000)]))), []);
  });

  it('1. takes JSON under the size limit, with the fields that are read, of their types', () => {
    const big = check(`${good}${' '.repeat(1_000_000)}`);
    assert.equal(big.length, 1);
    assert.match(big[0]!, /^The file is \d+ KB; a report is at most 1000 KB\.$/);
    assert.deepEqual(check('{"repo":'), ["The file isn't JSON."]);
    assert.deepEqual(check(edit((r) => delete r.wait)), ['wait is missing; it should be object.', ...['heads', 'timed', 'p50', 'p75', 'p90', 'redRate', 'passedOnRerunRate'].map((k) => `wait.${k} is missing; it should be ${/heads|timed/.test(k) ? 'number' : 'number or null'}.`)]);
    assert.deepEqual(check(edit((r) => (r.score = '82'))), ['score is a string; it should be number or null.']);
    assert.deepEqual(check(edit((r) => (r.profile.languages = ['TypeScript']))), ["profile.languages holds an entry that isn't a language's name and its share."]);
  });

  it('2. matches its path, and is from today or yesterday, UTC', () => {
    assert.deepEqual(check(good, 'reports/mo__garden/2026-01-01.json'), [`The file is at \`reports/mo__garden/2026-01-01.json\`, but a report of \`${REPO}\` for \`${today()}\` goes at \`${path()}\`.`]);
    const old = edit((r) => (r.date = '2026-01-01'));
    assert.match(check(old, submissionPath(REPO, '2026-01-01')).join('\n'), /^The report is dated `2026-01-01`; a submission is from today or yesterday/);
    const yesterday = new Date(Date.now() - 24 * 3600e3).toISOString().slice(0, 10);
    assert.deepEqual(check(edit((r) => (r.date = yesterday)), submissionPath(REPO, yesterday)), []);
  });

  it('3. comes from the current release', () => {
    assert.deepEqual(smokeCheck(good, { path: path(), version: '9.0.0' }), [`It was made by ci-doctor \`${VERSION}\`, and submissions come from the current release, 9.0.0. Update and run again: \`npx @ref0/ci-doctor@latest --submit\`.`]);
    assert.match(check(edit((r) => delete r.scorerVersion)).join(), /doesn't say which scorer made it/);
    assert.match(smokeCheck(good, { path: path(), version: '0.0.1' }).join(), /newer than the 0\.0\.1 this check runs/);
  });

  it('4. keeps numbers in order, and links only into the guide', () => {
    assert.deepEqual(check(edit((r) => (r.wait.p75 = r.wait.p90 + 1))), [`wait.p75 is ${JSON.parse(good).wait.p90 + 1}, more than wait.p90, ${JSON.parse(good).wait.p90}.`]);
    assert.deepEqual(check(edit((r) => (r.wait.timed = r.wait.heads + 1))), [`wait.timed is ${JSON.parse(good).wait.heads + 1}, more than wait.heads, ${JSON.parse(good).wait.heads}.`]);
    const notAPage = ["fixes[0].guide isn't a page of ci-doctor's guide, https://github.com/ref-0/ci-doctor/blob/main/docs/pages/."];
    assert.deepEqual(check(edit((r) => (r.fixes[0].guide = 'https://example.com/docs/pages/x.md'))), notAPage);
    // A path that climbs out of the guide still starts with it.
    assert.deepEqual(check(edit((r) => (r.fixes[0].guide = `${GUIDE}../../README.md`))), notAPage);
    assert.deepEqual(check(edit((r) => (r.fixes[0].guide = `${GUIDE}06-reuse-work-by-its-real-inputs.md#the-key`))), []);
    assert.deepEqual(check(edit((r) => (r.fixes[0].text = 'Get help at https://example.com/install'))), ["`fixes.0.text` holds a string with a link; a report's only links are its fixes' and notes' guides."]);
  });

  it("gives the long fields' room to those fields only, by where they are", () => {
    assert.deepEqual(check(edit((r) => (r.fixes[0].text = 'x'.repeat(5000)))), []);
    // A key that spells a long field's path isn't that field, and neither is a name every object has.
    assert.deepEqual(check(edit((r) => (r['fixes.0.text'] = 'x'.repeat(5000)))), ['`fixes.0.text` holds a string of 5000 characters; at most 400.']);
    assert.deepEqual(check(edit((r) => (r.constructor = 'x'.repeat(9000)))), ['`constructor` holds a string of 9000 characters; at most 400.']);
    assert.deepEqual(check(edit((r) => (r.fixes[0].text = 'x'.repeat(9000)))), ['`fixes.0.text` holds a string of 9000 characters; at most 8000.']);
  });

  it('never repeats a string from the file but in a safe form', () => {
    const lines = check(edit((r) => ((r.submitted.by = 'Mo <img src=x onerror=alert(1)> [click](evil.example)'), (r.scorerVersion = '9.9.9 `rm -rf` ' + 'y'.repeat(80)))));
    for (const line of lines) assert.doesNotMatch(line, /[<>\[\]() ]img|onerror=|\(evil|rm -rf/, line);
    assert.ok(lines.some((l) => l.startsWith('submitted.by `Moimgsrcxonerroralert1clickevil.example` ')));
    assert.ok(lines.some((l) => /`9\.9\.9rm-rfy{50}…`/.test(l)));
  });

  it('4. keeps numbers in range', () => {
    assert.deepEqual(check(edit((r) => (r.score = 120))), ['score is 120; scores run 0 to 100.']);
    assert.deepEqual(check(edit((r) => (r.wait.redRate = 1.5))), ['wait.redRate is 1.5; a share runs 0 to 1.']);
    assert.deepEqual(check(edit((r) => (r.wait.p50 = -1))), ["wait.p50 is -1; it can't be negative."]);
    assert.deepEqual(check(good.replace(/"p75": [\d.]+/, '"p75": 1e999')), ["`wait.p75` isn't a finite number."]);
    assert.deepEqual(check(edit((r) => (r.wait.timed = 3))), ["It's scored on 3 timed PR pushes; a score needs 5."]);
  });

  it('5. holds the score, grade and parts its own measures give', () => {
    const r = JSON.parse(good);
    assert.deepEqual(check(edit((x) => ((x.score = 97), (x.grade = grade(97)), (x.band = band(97))))), [`score is 97, but its own measures give ${r.score}.`]);
    assert.deepEqual(check(edit((x) => (x.parts.speed = 99))), [`parts.speed is 99, but its own measures give ${r.parts.speed}.`]);
    assert.deepEqual(check(edit((x) => (x.score += 1))), [], 'a point either way is rounding');
    assert.deepEqual(check(edit((x) => (x.grade = 'A+'))), [`grade is \`A+\`, but a score of ${r.score} is ${r.grade}.`]);
    assert.deepEqual(check(edit((x) => (x.detail.speed.wait = 0))), [`detail.speed.wait is 0, but its own measures give ${r.detail.speed.wait}.`]);
    assert.deepEqual(check(edit((x) => (x.size = 'large'))), [`size is \`large\`, but ${r.headsPerWeek} PR pushes a week and ${r.profile.linesOfCode} lines are ${r.size}.`]);
    // Nulling the measures that hurt and keeping the score: the part is empty, which the scorer never scores.
    const nulled = check(edit((x) => ((x.wait.p50 = null), (x.wait.p90 = null), (x.detail.speed = { wait: null, forSize: null, tail: null }))));
    assert.ok(nulled.includes("None of its speed part's measures are there, and the scorer gives no score without them."), nulled.join('\n'));
    // A measure missing that drops the measured weight under the scorer's bar for low confidence, with confidence kept high.
    const thin = check(edit((x) => ((x.jobs.setupMinPerJob = null), (x.jobs.queueP90Sec = null), (x.profile.runsPerMergedPr = null), (x.efficiency.vcpuMinutesPerMergedPr = null), (x.main.redRate = null), (x.wait.passedOnRerunRate = null))));
    assert.ok(thin.some((l) => /^Only \d+% of the score's weight was measured, which the scorer calls low confidence, but evidence\.confidence is `(high|medium)`\.$/.test(l)), thin.join('\n'));
    // Faster waits than measured give a different score.
    assert.match(check(edit((x) => ((x.wait.p50 = 1), (x.wait.p75 = 1), (x.wait.p90 = 1)))).join(), /^score is \d+, but its own measures give \d+\./);
  });
});
