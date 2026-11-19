<!--
What: each kind of test slowness and the fix that kept the test's proof, and what not to build.
Where: read by an agent once it has named what a slow file waits for.
Configure: nothing; your repo's settings and holds go in `.agents/repo/speed-up-tests.md`.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The kinds of slowness and their fixes

Part of the [`speed-up-tests`](../TOPIC.md) topic. Read it once you've named what a slow file waits for. Each kind gives the fix that worked and the rule that kept the test's proof. The examples are from campaigns on a server tested in a local copy of its runtime; durations in them are illustrative. If your stack runs on Cloudflare Workers, [Workers](workers.md) has what's specific to it. Your repo's `.agents/repo/speed-up-tests.md` names its own settings and holds.

## A production period or retry the test inherits

The code waits a period it needs in production: a retry's base, a container's stop bound, a poll, a token's propagation, a receive deadline.

- **Make it a setting,** with production's value where the code is deployed and a shorter one in the test harness, as the repo's `speed-up-tests.md` says. That's legitimate when production has a reason to configure it too; a control only tests use lives in the harness, never as a production export. Where a limits struct already holds the code's bounds, put it there instead.
- **Choose the test's value from the window other tests need,** not the smallest that passes. The smallest retry base that passed left one still-live assertion only a few seconds, so a base twice that was chosen.
- **Keep the shape.** The attempt count, the doubling and the final error stay. Only the first period shrinks.
- **One period per loop.** Pass the value the consumer needs, not another loop's setting times a hidden factor.
- **A value that crosses an RPC boundary is part of the contract,** declared in the repo's shared schemas, not a loose interface.
- **A fake service's period isn't a real one's.** Stops can be short for fake containers and keep production's value where real containers run.
- **Measure that a test waits on it first.** Temporary timers in the candidates showed which periods cost time and which cost none.
- **One test keeps production's value,** on a test clock, so the real number stays proved in milliseconds.
- **A shared period reaches tests your run didn't select.** Find every test that reads the setting or default you shortened and run them: a shortened lane period raced a test its own pull request's run skipped.
- **Helpers that run every due job change meaning.** Once a retry or wake period shrinks, a helper that runs all due work also runs jobs that used to stay pending. If the test concerns one job's decision while another must stay pending, drive the exact selected job through a trigger the test harness already owns; a proof of scheduling itself goes through the production scheduler, as [wait for the effect](../../checks/wait-for-the-effect.md) says. Turn automatic scheduling off before releasing a hold when that order is part of the fixture. Recheck both the explicit-job and the automatic-wake proofs; never restore a delay to hide an ordering error.
- **Outside a deployed service,** where there's no deploy config, the period is a parameter with production's default, or an injected dependency.
- **A deadline the test only survives** is the same kind: a call deadline or a connect bound. Shorten it by setting, and keep a test on each side of it.

## A sleep that arranges a race

A test sleeps so that one thing happens before another. In a shared helper, one sleep reaches every test that calls it: fix it there.

- **Hold the operation the race turns on,** in the test's fake, and release it once the other side is in place. Look for an existing hold with the repo's symbol search before adding one.
- **Scope the hold to the operation the assertion is about,** by its identity, not "the next call": background work can take a hold on the next arbitrary call. Signal that this exact operation reached the hold, after any state it depends on exists, before starting the other side, and assert which call took it. A hold placed too early, before the row it races on exists, leaves the real race unordered.
- **Wait for the progress you need, not for absence.** "No second restore" waits for the close retry to end unconfirmed, then checks, rather than checking at once.
- **Prove it:** delay the other side on purpose. With a deliberately late deploy, the test passed every repetition with the hold and failed every one without it.
- **Hold I/O until the answer you test,** then release it and check both sides.
- **Leave a short wait** when the stronger signal costs as much, or would change what the test records.

## A pace or a floor in production code

The code delays work on purpose: a fixed sleep beside each read, so a walk stays under a service's limit, or a minimum delay before a background job wakes, so a loop can't spin. A test can't shorten it, and every test that reaches the code pays it.

- **Find why it was added** before you change it: `git log -S'<name>'` and the plan that introduced it. One reader's per-read pause came from a bulk graph walk that keeps well under a storage service's rate limit, so people's own calls keep room.
- **Keep it where it protects something,** such as a bulk background walk sharing a limit with interactive traffic, as a setting with a test value.
- **Delete it where it only delays,** such as a few dozen reads a person waits on.
- **A floor that stops a loop spinning** stays above zero in tests. Or a test of a decision drives the job directly, and a few tests keep the automatic wake, to prove it.

## A rate limit

- **Test the behaviour, never the delay.** The fake answers a 429 when the test asks: the code retries and succeeds, or runs out of tries and fails with its named error. Count what's in flight with holds, so a cap is proved without a clock.
- **Let the service say when.** Back off on its 429, honouring `Retry-After`. Build a limiter of your own only where a 429 costs more than a retry, and pace at the limit, not on every call.

## A poll

- A shorter default interval for test waits saves where many tests wait. Count the queries too: they multiply as the interval falls.
- Change the cadence, never the ceiling: polls got faster in tests while their bounds stayed.
- A caller that sets its own interval gains nothing from the default, so look at the callers first: one campaign found a dozen helpers polling far slower than the default.
- A helper that waits for a job, then sleeps one more interval before it checks, pays the whole interval each time: check at once.
- A poll whose check does the work, such as running the due jobs, isn't overshoot. Measure the sleep past the check that met it before shortening a default ([measuring](measuring.md)).

## A deadline the test proves

- Shrink a synthetic deadline only after measuring the work it bounds, leaving a wide margin over it.
- Keep production's own margins, with room for admission.
- Scale leases and injected delays together, but keep the scheduler's slack absolute.
- A test that steps while a lock is held can double the code's backoff. Observe one busy step, then wait.
- Shorten a deadline only where the real time left still covers the work before it on a busy runner: a faster test clock left one case too little real time and it flaked in CI.

## A wall-clock window

A rate limiter's minute, or a counter keyed by time, made a test wait for a fresh window. Count with a stand-in that has no window, and keep one test on the real binding.

## A fake clock

- Fake only the clock APIs the waited code uses. Faking `setImmediate` as well stopped React's scheduler and another runtime's ([Effect](effect.md#a-fake-clock), if your stack uses it).
- Step it in bounded slices, yielding between them, so async work answers before the next step.
- Don't fake the clock around work it doesn't drive, such as Web Crypto: a test timed out on synthetic time before its request was sent.
- Where a real process outside the test holds the timer, keep real time.
- `vi.waitFor` under fake timers steps the clock by its interval at each check, and waits that interval in real time: an interval five times the step it needed cost seconds across a few tests.

## A long file

A shard can't end before its longest file. Split one past the shard cap ci.md names (about 90 s in the source repo) by what its tests are about, into files named for the source they test, without changing a test body, as the check [keep slow test files out of the shards](../../checks/ci-keep-slow-files-out-of-the-shards.md) says. Stop where the next file would cost another harness start for a few seconds of tests. [Slow runs](../../ci-workflows/references/performance.md#a-long-test-file) says how CI places them.

After a split, replay representative production edits through both the local and the CI selector. A new file that imports only shared helpers may have no production edge to select it: add the explicit coverage mapping and a regression test that the relevant source edit selects it, keeping any intended difference between local and CI reach. Then update proof references and timing estimates. A green direct run doesn't prove later automatic selection.

## An expensive prerequisite

Cache a tool the tests build, such as pinned Git, keyed by its version, its build script, the OS and the architecture. Count the restore's own cost, the misses on a new key and saves that race, and check a hit in a later run.

A skipped suite still runs its file's top-level code, since the runner collects it: create an expensive fixture inside the suite, lazily.

A test that runs a CLI against a seeded Git repo, as the selector's tests do: build the seed once per suite and copy it for each test, point the spawned processes at one shared Node compile cache, and run the CLI once per case, reading every field the assertions need from that one run. Keep each call a real process; running it in-process would mean exporting an entry from a production script only for the test.

## Real work

Many checks with full outputs, a large graph, a tree of tens of thousands of files: smaller would no longer prove the bound. Leave these, or move them to a later tier with the paths they cover ([guide section 5](../../../../../docs/pages/05-tiers-what-runs-where.md)), keeping them honest as [`proof-tiers`](../../../../proof-tiers/SKILL.md) says.

## What not to build

Measure before you build any of these, and add what you drop to [what was tried](../../checks/ci-read-what-was-tried.md):

- a runtime shared between test files, or a watch-mode harness: they saved little a file and broke isolation;
- a resident helper process, such as a kept bundler, that saves a little a file for a lot of memory;
- a setting no test measurably waits on;
- a production API made wider to remove a test's last wait;
- a separate fast command beside the one people already run: make the default do it;
- a test mode in code: keep one code path, and let a period differ by setting;
- a fake made slow to match production's delay or rate limit: prove the behaviour at the limit instead.
