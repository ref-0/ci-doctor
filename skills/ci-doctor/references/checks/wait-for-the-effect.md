<!--
What: a check that test fixtures keep the real code's invariants, and that each wait observes its own effect.
Where: read by an agent writing or reviewing a test that seeds state or waits on asynchronous work.
Configure: your repo's ID factories, job triggers and lease and timer sources, in `.agents/repo/speed-up-tests.md`'s Fixtures and timers.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Use real invariants in fixtures, and wait for the effect itself

**Moment:** build · **Concern:** tests and CI

## Check

- [ ] Fixtures use the server's real paths, or preserve every invariant those paths establish.
- [ ] Seeded IDs pass the real decoders, and each test reads records by its own key.
- [ ] Each wait observes the effect's own result, not a state already true before it ran: it awaits the effect's event or promise where there is one, and otherwise polls the observed state with a bound.
- [ ] Requests succeed before polling starts, and an exhausted wait fails with a clear timeout that prints what it saw.
- [ ] A proof of scheduling goes through the production scheduler; a proof of what one job decides drives that job through a trigger the test harness already owns. Neither adds a production export, flag or hook that only tests use.
- [ ] Restart, timer and deadline tests allow for the actual lease or asynchronous work they cross.

## How

- Read what the real creation path writes before seeding rows. Make typed IDs with the repo's own ID factories, as speed-up-tests.md names them. After tightening a row decoder, search every test folder for `INSERT INTO <table>`.
- When the test proves scheduling, waking or ordering, run the job through the scheduler production uses, with the harness's own control for running due jobs now. When it proves what one job decides, drive that job through an existing harness trigger, as [the fixes](../speed-up-tests/references/fixes.md#a-production-period-or-retry-the-test-inherits) say. After a restart, wait for the woken process's own run.
- Shorten a production period only through a setting production has its own reason to configure; a control only tests need lives in the test harness.
- Wait for the storage key to disappear, the outbox delivery to arrive or the job to finish: await its signal where the code gives one, or poll with a bound. For a job queue, check both running rows and pending rows that are due now. A harness reload can leave a job leased for its full lease, as speed-up-tests.md's lease and timer sources say (60 s in the source repo).
- Follow [test-audit](../../../test-audit/SKILL.md)'s rule against fixtures that supply the ordering or receipts the code must produce. Run each touched test file whole before review.

## Why

In the source repo:

- CLI tests answered the API themselves and hid a broken token for hours.
- Records seeded straight into storage lacked three things the real creation path writes, and the code failed on each in turn.
- A container test read events before the scheduled job sent them. The race existed on `main` too.
- A test read a storage key before its removal ran, while restart tests mistook the 60 s job lease for a failure.

## Pointed at from

- [`test-audit`](../../../test-audit/SKILL.md), on fixtures that supply the expected ordering.
- [The tests reviewer](../../../code-review/references/tests-reviewer.md), on waits.
- [`speed-up-tests`](../speed-up-tests/TOPIC.md).
