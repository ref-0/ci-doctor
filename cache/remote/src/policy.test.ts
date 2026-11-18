/**
 * The policy your `migrations/0003_project.sql` registers, against the one you chose in README.md's
 * "Trust". Edit `chosen` below when you choose: `pull_requests: 0` (the example's) for writes from
 * pushes to the registered branch only, 1 for same-repository pull requests and runs by hand too. The values here
 * are the example migration's, so this passes unfilled; it fails when the migration and your
 * choice disagree. The invariant tests in `worker.test.ts` don't depend on it.
 *
 * Run with `npm test` from this folder, with no Cloudflare account. Reference implementation from a
 * production monorepo; adapt to your repo.
 */
import { afterEach, expect, it } from 'vitest';

import { harness } from './testing/harness.ts';

// ---- Your policy ------------------------------------------------------------------------------
const chosen = {
  pull_requests: 0,
  retention_seconds: 604_800,
  byte_limit: 100_000_000_000,
  entry_limit: 100_000,
  association_limit: 100_000,
};
// -----------------------------------------------------------------------------------------------

let open: Awaited<ReturnType<typeof harness>> | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

it('registers the policy you chose', async () => {
  open = await harness();

  expect(open.policy).toEqual(chosen);
});
