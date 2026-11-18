/**
 * Each file changed since this branch left the default branch, committed or not.
 *
 * Runs locally: a "tests near my change" command (run before pushing) feeds these paths to the
 * planner's rules, so a person or an agent runs what CI's ready run will, plus uncommitted work.
 * Configure `DEFAULT_BRANCH`. Reference implementation from a production monorepo; adapt to your
 * repo.
 */
import { execFileSync } from 'node:child_process';

// ---- Configure ------------------------------------------------------------------------------
const DEFAULT_BRANCH = 'origin/main';
// ---------------------------------------------------------------------------------------------

const git = (root: string, ...args: Array<string>): Array<string> =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

/** Each file changed since this branch left `DEFAULT_BRANCH`, committed or not, from `root`. */
export const changedFiles = (root: string): Array<string> => {
  const [base = DEFAULT_BRANCH] = git(root, 'merge-base', DEFAULT_BRANCH, 'HEAD');

  return [
    // Deleted files are left out: nothing can run them.
    ...git(root, 'diff', '--name-only', '--diff-filter=d', base),
    ...git(root, 'ls-files', '--others', '--exclude-standard'),
  ];
};
