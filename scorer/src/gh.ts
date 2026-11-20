// Every GitHub read goes through `gh api`, so it carries the caller's own sign-in and a private repo reads the
// same as a public one. Nothing here uses unauthenticated HTTP.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from './errors.ts';

const DAY = 24 * 3600e3;
const NOT_SIGNED_IN = "gh isn't signed in. Run `gh auth login`, then run this again.";

export interface ReadOptions {
  /** HTTP statuses that mean "there's nothing here", answered as undefined instead of failing. */
  absentOn?: number[];
  /** Ask for the file's raw bytes, for `contents/` reads. */
  raw?: boolean;
  /** Never cache this answer, such as a job's log. */
  noCache?: boolean;
  /** Send this GraphQL query, to the `graphql` path. */
  query?: string;
}

/** API answers kept on disk, only when asked, under one gh account's folder. */
export class ApiCache {
  readonly dir: string;
  readonly maxAgeMs: number;

  constructor(dir: string, maxAgeMs = DAY) {
    this.dir = dir;
    this.maxAgeMs = maxAgeMs;
  }

  get(key: string): { body: string; readAt: number } | undefined {
    const file = this.file(key);
    if (!existsSync(file)) return undefined;

    const entry = JSON.parse(readFileSync(file, 'utf8')) as { key: string; readAt: number; body: string };
    if (entry.key !== key || Date.now() - entry.readAt > this.maxAgeMs) return undefined;
    return entry;
  }

  set(key: string, body: string) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file(key), JSON.stringify({ key, readAt: Date.now(), body }), { mode: 0o600 });
  }

  private file(key: string) {
    return join(this.dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  }
}

interface ExecError {
  code?: string;
  status?: number | null;
  stderr?: string;
}

const statusOf = (stderr: string) => Number(stderr.match(/HTTP (\d{3})/)?.[1]) || undefined;

export class Gh {
  calls = 0;
  fromCache = 0;
  oldestCachedAt: number | undefined;
  readonly cache: ApiCache | undefined;
  private readonly startedAt = Date.now();
  // One run asks for some answers twice, such as a run's jobs or a workflow file; it reads them once, in memory. An
  // absent answer (a status in `absentOn`) is remembered too, as undefined.
  private readonly memo = new Map<string, string | undefined>();
  // gh 2.97 and later escape control characters unless told not to; logs and files are wanted as they are.
  private escapesFlag = true;

  /** A token to read with instead of gh's own sign-in, such as a GitHub App's, passed to gh as GH_TOKEN. */
  private readonly token: string | undefined;
  // Cached answers are keyed by a hash of the token they were read with, never the token, so two clients that share a
  // cache folder never see each other's answers, such as a private repo's files. Without a token, gh's sign-in reads,
  // and the CLI keeps each signed-in account's cache in its own folder.
  private readonly scope: string;

  constructor(cache?: ApiCache, token?: string) {
    this.cache = cache;
    this.token = token;
    const credential = token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    this.scope = credential ? `${createHash('sha256').update(credential).digest('hex').slice(0, 32)}:` : '';
  }

  /** One API answer as text; undefined only for a status in `absentOn`. Any other failure throws. */
  text(path: string, options: ReadOptions = {}): string | undefined {
    const key = options.query !== undefined ? `graphql:${options.query}` : `${options.raw ? 'raw' : 'api'}:${path}`;
    if (!options.noCache && this.memo.has(key)) return this.memo.get(key);

    const hit = options.noCache ? undefined : this.cache?.get(this.scope + key);
    if (hit) {
      // Only answers from an earlier run count toward how stale this one is.
      if (hit.readAt < this.startedAt) {
        this.fromCache++;
        this.oldestCachedAt = Math.min(this.oldestCachedAt ?? hit.readAt, hit.readAt);
      }
      this.memo.set(key, hit.body);
      return hit.body;
    }

    const body = this.fetch(path, options);
    // An empty body is a 202 still being computed; keeping it would hide the real answer next time.
    if (body === undefined && !options.noCache) this.memo.set(key, undefined);
    if (body !== undefined && body.trim() !== '' && !options.noCache) {
      this.memo.set(key, body);
      this.cache?.set(this.scope + key, body);
    }
    return body;
  }

  json(path: string, options: ReadOptions = {}): any {
    return this.parse(path, this.text(path, options));
  }

  /** One GraphQL query's answer, cached and remembered as a GET is. GitHub counts these against their own hourly points. */
  graphql(query: string): any {
    return this.parse('graphql', this.text('graphql', { query }));
  }

  private parse(path: string, text: string | undefined): any {
    // GitHub answers 202 with no body while it computes statistics: unknown for now, like an absent answer.
    if (text === undefined || text.trim() === '') return undefined;

    try {
      return JSON.parse(text);
    } catch {
      throw new CliError(`GitHub's answer to ${path} wasn't JSON.`);
    }
  }

  /** The signed-in account's login, to keep cached answers and reports apart per account. */
  login(): string {
    const login = this.json('user', { noCache: true })?.login;
    if (typeof login !== 'string' || !/^[\w-]+$/.test(login)) throw new CliError("Couldn't tell which GitHub account gh is signed in as.");
    return login;
  }

  private fetch(path: string, options: ReadOptions): string | undefined {
    // --hostname pins every read to github.com, which the remote named, whatever GH_HOST says.
    const args = () => [
      'api',
      '--hostname=github.com',
      ...(this.escapesFlag ? ['--allow-escape-sequences'] : []),
      ...(options.raw ? ['-H', 'Accept: application/vnd.github.raw'] : []),
      path,
      ...(options.query !== undefined ? ['-f', `query=${options.query}`] : []),
    ];
    const run = () => {
      this.calls++;
      return execFileSync('gh', args(), {
        encoding: 'utf8',
        maxBuffer: 512 << 20,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(this.token ? { GH_TOKEN: this.token } : {}), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_TELEMETRY: 'false' },
        windowsHide: true,
      });
    };

    for (let attempt = 1; ; attempt++) {
      try {
        return run();
      } catch (e) {
        const err = e as ExecError;
        if (err.code === 'ENOENT') throw new CliError("gh isn't installed or isn't on PATH. Install it from https://cli.github.com, then run `gh auth login`.");
        if (err.status === 4) throw new CliError(NOT_SIGNED_IN);

        const stderr = String(err.stderr ?? '').trim();
        // gh before 2.97 has no --allow-escape-sequences, and prints answers as they came; ask again without it.
        if (this.escapesFlag && /unknown flag: --allow-escape-sequences/.test(stderr)) {
          this.escapesFlag = false;
          attempt--;
          continue;
        }

        const status = statusOf(stderr);
        // A rate limit or a 429 says nothing about whether the answer exists, so it's never read as absent.
        const throttled = status === 429 || /rate limit/i.test(stderr);
        if (status !== undefined && !throttled && options.absentOn?.includes(status)) return undefined;
        if (status === 401) throw new CliError(`${NOT_SIGNED_IN} (GitHub answered 401 to ${path}.)`);

        // A 5xx or a dropped connection gets one more try; a 4xx won't change.
        const transient = status === undefined || status >= 500;
        if (transient && attempt < 2) continue;

        const said = stderr.split('\n')[0]?.replace(/^gh:\s*/, '') || `gh exited ${err.status}`;
        const hint = throttled
          ? " GitHub's rate limit for this account ran out; try again once it resets."
          : status === 403 || status === 404 ? ' Your gh account may lack access: a private repo needs the `repo` scope (`gh auth refresh -s repo`).' : '';
        throw new CliError(`Couldn't read ${path}: ${said}.${hint}`);
      }
    }
  }
}
