#!/usr/bin/env node
// npx @ref0/ci-doctor: score the current checkout's CI from its GitHub history, read through the caller's own `gh`.
// npx @ref0/ci-doctor agents skills: how to install ci-doctor's skills in each agent.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { CliError, usage } from './errors.ts';
import { ApiCache, Gh } from './gh.ts';
import { installText } from './install-steps.ts';
import { apiCacheDir, reportFile } from './paths.ts';
import { isRepoName, resolveTarget } from './repo.ts';
import { inventoryText, scoredText } from './report.ts';
import { inventoryLocal, measure, provenanceOf } from './score.ts';
import { sendStanding, standingUrl } from './standing.ts';
import { DATA_REPO, submissionOf, submit } from './submit.ts';
import { VERSION } from './version.ts';

const HELP = `Score this repo's CI, on your machine, from its GitHub Actions history.

Usage:
  npx @ref0/ci-doctor [options]      score the repo this checkout belongs to
  npx @ref0/ci-doctor agents skills  print how to install ci-doctor's skills in your agent

Options:
  --repo owner/name   score this GitHub repo instead of the checkout's remote
  --days <n>          how many days of runs to read (default 7, at most 90)
  --json              print the report as JSON
  --cache             reuse API answers up to 24 hours old, kept per gh account
  --save              save the report as JSON, beside the cache
  --standing          send the score and size class, and nothing else, to compare with other repos
  --standing-url <u>  the endpoint --standing sends to
  --submit            add this public repo's report to ${DATA_REPO}, as a pull request from your fork
  -h, --help          show this
  -v, --version       show the version

The repo is origin's, else the only remote on github.com, else --repo. Reads go through gh, so sign in
first with \`gh auth login\`. Nothing is written or sent unless you pass --cache, --save, --standing
or --submit.`;

const parse = (argv: string[]) => {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        repo: { type: 'string' },
        days: { type: 'string' },
        json: { type: 'boolean' },
        cache: { type: 'boolean' },
        save: { type: 'boolean' },
        standing: { type: 'boolean' },
        'standing-url': { type: 'string' },
        submit: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (e) {
    throw usage(`${(e as Error).message}\nRun with --help to see the options.`);
  }
};

const out = (text: string) => process.stdout.write(`${text}\n`);
const err = (text: string) => process.stderr.write(`${text}\n`);

export const main = async (argv: string[], cwd = process.cwd()) => {
  const { values: o, positionals } = parse(argv);
  if (o.help) return out(HELP);
  if (o.version) return out(VERSION);

  if (positionals.length) {
    if (positionals.join(' ') === 'agents skills') return out(installText());
    if (positionals[0] === 'agents') throw usage('Try `npx @ref0/ci-doctor agents skills`, which prints how to install the skills in each agent.');
    throw usage(`Unknown command "${positionals.join(' ')}". Run with --help to see the commands.`);
  }

  const days = o.days === undefined ? 7 : Number(o.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw usage('--days takes a whole number from 1 to 90.');
  if (o.repo !== undefined && !isRepoName(o.repo)) throw usage(`--repo takes owner/name, such as vitejs/vite, not "${o.repo}".`);
  // Settle the endpoint before reading anything, so a bad one fails fast.
  const endpoint = o.standing ? standingUrl(o['standing-url']) : undefined;
  if (o['standing-url'] && !o.standing) throw usage('--standing-url only names where --standing sends; add --standing to send.');
  // ci-doctor-db compares repos over the same 7 days.
  if (o.submit && days !== 7) throw usage(`--submit sends a 7-day report, as ${DATA_REPO} keeps them: leave out --days.`);

  const target = o.repo ? ({ kind: 'github', repo: o.repo, from: '--repo' } as const) : resolveTarget(cwd);
  if (o.submit && target.kind === 'local')
    throw usage(`Not submitted: ${target.reason[0]!.toLowerCase()}${target.reason.slice(1)}. Run it in a checkout of a public GitHub repo, or pass --repo owner/name.`);

  if (target.kind === 'local') {
    const inventory = inventoryLocal(target.root, target.reason);
    out(o.json ? JSON.stringify(inventory) : inventoryText(inventory));
    if (endpoint) (o.json ? err : out)('Standing not sent: there is no score to send.');
    return;
  }

  // The account is asked for only when something will be written, to keep each account's files apart, or submitted.
  const login = o.cache || o.save || o.submit ? new Gh().login() : undefined;
  const cacheDir = o.cache && login ? apiCacheDir(login) : undefined;
  const gh = new Gh(cacheDir ? new ApiCache(cacheDir) : undefined);
  // Before reading the rest: a private repo's report never goes in a public file. GitHub is asked now, never the cache:
  // a repo made private since the cache's answer must still be refused, and a renamed one filed under its new name.
  const meta = o.submit ? gh.json(`repos/${target.repo}`, { absentOn: [404], noCache: true }) : undefined;
  if (meta?.private === true) throw usage(`Not submitted: ${target.repo} is private, and ${DATA_REPO} is public. --standing sends only the score and size class.`);
  // A submitted report is filed under the name as GitHub spells it, so --repo Pip/Garden lands in pip__garden.
  const repo = typeof meta?.full_name === 'string' && isRepoName(meta.full_name) ? meta.full_name : target.repo;
  const report = measure(gh, repo, days);

  let savedTo: string | undefined;
  if (o.save && login) {
    savedTo = reportFile(login, target.repo, report.date);
    mkdirSync(dirname(savedTo), { recursive: true, mode: 0o700 });
    writeFileSync(savedTo, JSON.stringify({ ...report, readAt: new Date().toISOString(), fromCache: gh.fromCache }, null, 1), { mode: 0o600 });
  }
  const provenance = provenanceOf(gh, cacheDir, savedTo);
  out(o.json ? JSON.stringify({ ...report, read: provenance }) : scoredText(report, provenance));
  // Under --json, stdout holds only the JSON.
  const say = o.json ? err : out;

  if (endpoint) {
    if (report.score === null) say('Standing not sent: there is no score to send.');
    else {
      const said = await sendStanding(endpoint, { score: report.score, size: report.size });
      say(`Sent the score and size class, and nothing else, to ${endpoint.origin}.${said ? ` It said: ${said}` : ''}`);
    }
  }

  if (o.submit && login) {
    if (report.score === null) throw usage(`Not submitted: there's no score, so there's nothing to submit. ${report.unscored ?? ''}`.trim());
    const sent = submit(gh, report, submissionOf(report, provenance, login), login, say);
    if (sent.already) return say(`Not sent: your pull request ${sent.url} already adds this report, and is still open.`);
    say(`Opened ${sent.url}. A check there reads the file and comments what it found. Once it's merged, the repo's row shows as submitted.`);
  }
};

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof CliError) {
    process.stderr.write(`ci-doctor: ${e.message}\n`);
    process.exitCode = e.exitCode;
  } else {
    process.stderr.write(`ci-doctor: ${(e as Error).stack ?? e}\n`);
    process.exitCode = 1;
  }
}
