#!/usr/bin/env node
// A stand-in for `gh`, first on PATH in tests, so no test touches GitHub. It serves canned `gh api` answers from
// the JSON file GH_STUB_FIXTURES names, and appends each call to GH_STUB_LOG.
//   GH_STUB_MODE=signed-out  answers as gh does with no sign-in: exit 4.
//   GH_STUB_MODE=old         answers as gh before 2.97 does: --allow-escape-sequences is an unknown flag.
// Every call must pin --hostname=github.com and turn gh's telemetry off, or the stub fails it.
// An answer is { status, json } or { status, raw } (served only with the raw Accept header) or { status, text };
// a status of 400 or more prints gh's error line and exits 1. A path with no answer is a 404.
const { appendFileSync, readFileSync } = require('node:fs');

const args = process.argv.slice(2);
if (process.env.GH_STUB_LOG) appendFileSync(process.env.GH_STUB_LOG, `${JSON.stringify(args)}\n`);

if (process.env.GH_STUB_MODE === 'signed-out') {
  process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n');
  process.exit(4);
}
if (process.env.GH_STUB_MODE === 'old' && args.includes('--allow-escape-sequences')) {
  process.stderr.write('unknown flag: --allow-escape-sequences\n\nUsage:  gh api <endpoint> [flags]\n');
  process.exit(1);
}
if (process.env.GH_TELEMETRY !== 'false' || !args.includes('--hostname=github.com')) {
  process.stderr.write('stub gh: a call left telemetry on or its host unpinned\n');
  process.exit(3);
}
if (args[0] !== 'api') {
  process.stderr.write(`stub gh: only \`gh api\` is served, not ${args.join(' ')}\n`);
  process.exit(2);
}

let path;
const headers = [];
for (let i = 1; i < args.length; i++) {
  if (args[i] === '-H') headers.push(args[++i]);
  else if (args[i].startsWith('-')) continue;
  else path = args[i];
}

// The key keeps only what tells answers apart: the path and its event, branch, page and ref.
const keyOf = (full) => {
  const [p, query = ''] = full.split('?');
  const params = new URLSearchParams(query);
  if (p === 'search/issues') return `search/issues?${/is:merged/.test(params.get('q') ?? '') ? 'merged' : 'opened'}`;
  const kept = ['event', 'branch', 'page', 'ref'].filter((k) => params.has(k)).map((k) => `${k}=${params.get(k)}`);
  return kept.length ? `${p}?${kept.join('&')}` : p;
};

const routes = JSON.parse(readFileSync(process.env.GH_STUB_FIXTURES, 'utf8'));
const key = keyOf(path);
const answer = routes[key] ?? { status: 404, message: 'Not Found' };
const wantsRaw = headers.some((h) => /application\/vnd\.github\.raw/.test(h));

if (answer.status >= 400) {
  process.stderr.write(`gh: ${answer.message ?? 'Error'} (HTTP ${answer.status})\n`);
  process.exit(1);
}
if (answer.raw !== undefined && !wantsRaw) {
  process.stderr.write(`stub gh: ${key} is a file; ask for it with the raw Accept header\n`);
  process.exit(1);
}
process.stdout.write(answer.raw ?? answer.text ?? JSON.stringify(answer.json));
