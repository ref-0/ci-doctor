// Which GitHub repo a checkout belongs to: origin if it points at github.com, else the only remote that does.
// Several GitHub remotes and none of them origin is ambiguous, so the caller names one with --repo.
import { execFileSync } from 'node:child_process';
import { CliError, usage } from './errors.ts';

export type Target =
  | { kind: 'github'; repo: string; from: string }
  | { kind: 'local'; root: string; reason: string };

const REPO = /^[\w.-]+\/[\w.-]+$/;

export const isRepoName = (s: string) => REPO.test(s) && !s.split('/').some((part) => part === '.' || part === '..');

/** owner/name from a github.com remote URL, in any of Git's spellings; undefined for any other host. */
export const parseGitHubUrl = (url: string): string | undefined => {
  const m =
    url.match(/^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ??
    url.match(/^(?:[^@/:]+@)?github\.com:\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m) return undefined;

  const repo = `${m[1]}/${m[2]}`;
  return isRepoName(repo) ? repo : undefined;
};

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

/** The checkout's top folder, or undefined outside a Git checkout. */
export const checkoutRoot = (cwd: string): string | undefined => {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']).trim();
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') throw new CliError("git isn't on PATH. Install Git, or pass --repo owner/name.");
    return undefined;
  }
};

export const remotes = (root: string): { name: string; url: string }[] => {
  let out: string;
  try {
    out = git(root, ['config', '--get-regexp', '^remote\\..*\\.url$']);
  } catch (e) {
    // git config exits 1 when nothing matches: a checkout with no remotes.
    if ((e as { status?: number }).status === 1) return [];
    throw new CliError(`Couldn't read this checkout's remotes: ${String((e as { stderr?: string }).stderr ?? e).trim()}`);
  }

  const names = [...new Set(out.split('\n').map((line) => line.match(/^remote\.(.+)\.url /)?.[1]).filter((n) => n !== undefined))];
  // get-url applies url.<base>.insteadOf, so a remote spelled as a shorthand resolves to where Git really fetches.
  return names.map((name) => ({ name, url: git(root, ['remote', 'get-url', name]).trim() }));
};

export const resolveTarget = (cwd: string): Target => {
  const root = checkoutRoot(cwd);
  if (!root) throw usage('Not in a Git checkout. Run it in your repo, or pass --repo owner/name.');

  const all = remotes(root);
  const github = all.map((r) => ({ ...r, repo: parseGitHubUrl(r.url) })).filter((r) => r.repo !== undefined);
  const origin = github.find((r) => r.name === 'origin');
  if (origin) return { kind: 'github', repo: origin.repo!, from: 'remote origin' };

  const distinct = [...new Set(github.map((r) => r.repo!))];
  if (distinct.length === 1) return { kind: 'github', repo: distinct[0]!, from: `remote ${github[0]!.name}` };
  if (distinct.length > 1)
    throw usage(`Several remotes point at GitHub and none is origin: ${github.map((r) => `${r.name} (${r.repo})`).join(', ')}. Pass --repo owner/name.`);

  const reason = all.length
    ? `No remote points at github.com (${all.map((r) => r.name).join(', ')}), so there's no Actions history to read`
    : "This checkout has no remote, so there's no Actions history to read";
  return { kind: 'local', root, reason };
};
