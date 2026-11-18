-- Your namespace and its budget. 0001 and 0002 are upstream's, as vendor/README.md says.
--
-- Fill in every <placeholder> before the first `wrangler d1 migrations apply`, then never edit this
-- file again: change a setting with a new migration. The OIDC check compares GitHub's numeric IDs,
-- not the repository's name, so a rename keeps working and a recreated repository doesn't.
--   <project>               the namespace: the URL's /projects/<project>, and NAMESPACE in wrangler.jsonc
--   <worker-url>            the Worker's origin, such as https://task-cache.example.com, no trailing slash
--   <org>/<repo>            the repository, for people reading the table
--   <github-repository-id>  gh api repos/<org>/<repo> --jq .id
--   <github-owner-id>       gh api repos/<org>/<repo> --jq .owner.id
--   <branch>                the default branch, usually main
--
-- pull_requests = 0, the default here, lets only pushes to <branch> write: pull requests and runs
-- by hand read. Set it to 1 to let same-repository pull requests into <branch>, and runs by hand on
-- the repository's branches, write too. GitHub sends no writing token to a fork's pull request.
-- Keep 0 if your repository allows forks that could otherwise get one. Match the task-cache
-- action's branch-writes input to it, and src/policy.test.ts's `chosen`.
--
-- Every writer here can supply a result main replays, and OIDC proves who wrote it, not that the
-- computation was honest. Decide the trust policy in README.md, "Trust", before applying this.
--
-- Size: Vite Task keeps one result for each task's key, not one for each commit, but a change to
-- the lockfile, the workspace or the root config gives every task a new key. In one monorepo, main
-- made 72 of those in 14 days, a first limit of 2,000 entries filled within about a day, and the
-- cache then refused every upload with 503, since it never evicts before a result's retention is
-- up. Kept results averaged 0.67 MB of value and 0.14 MB of output, so 100,000 entries is about
-- 80 GB, under the 100 GB cap. Results are kept 7 days.
UPDATE deployment SET byte_limit = 100000000000, entry_limit = 100000, association_limit = 100000;
INSERT INTO scopes (
  scope_id, endpoint, repository, repository_id, repository_owner_id, branch, pull_requests,
  retention_seconds, byte_limit, entry_limit, association_limit
) VALUES (
  '<project>', '<worker-url>/projects/<project>', '<org>/<repo>', '<github-repository-id>',
  '<github-owner-id>', 'refs/heads/<branch>', 0, 604800, 100000000000, 100000, 100000
);
