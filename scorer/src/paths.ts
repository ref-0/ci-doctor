// Where --cache and --save write: the platform's per-user cache folder, never npm's cache or the package's own
// folder, with one subfolder per gh account so two accounts never share answers.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const baseDir = (env = process.env, platform = process.platform, home = homedir()) => {
  if (env.CI_DOCTOR_CACHE_DIR) return env.CI_DOCTOR_CACHE_DIR;
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ci-doctor');
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'ci-doctor');
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'ci-doctor');
};

export const accountDir = (login: string, base = baseDir()) => join(base, login);
export const apiCacheDir = (login: string, base?: string) => join(accountDir(login, base), 'api');
export const reportFile = (login: string, repo: string, date: string, base?: string) =>
  join(accountDir(login, base), 'reports', repo.replace('/', '__'), `${date}.json`);
