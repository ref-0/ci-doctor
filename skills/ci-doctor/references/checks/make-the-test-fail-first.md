<!--
What: a check that a regression test fails, for the reason it names, before the fix goes in.
Where: read by an agent writing a regression test or proving a flake's fix.
Configure: your test command and test framework's helpers.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Make a regression test fail for the right reason first

**Moment:** build · **Concern:** tests and CI

## Check

- [ ] The regression test fails with the fix absent, or with the intended behaviour broken on purpose.
- [ ] Its failure identifies the defect it names, rather than an earlier guard, a wrong kind or an unrelated rejection.
- [ ] Its assertions execute, including the effect or promise a test returns.
- [ ] A refusal test asserts the exact refusal, HTTP response or unchanged state.
- [ ] The test environment can expose the defect, including production's default collation for sort tests.
- [ ] A flake's fix is proved by repeating the test with no retry, plus a mutation that reopens the race and fails it.

## How

Use [test-audit](../../../test-audit/SKILL.md#authoring-gate)'s authoring gate. Run the one test, such as `<test-cmd> <file> -t '<name>'`, with only the intended fix removed or broken. Read the failure, restore that change and rerun. Preserve other work while doing so.

Run lazy values for real: return or await a promise, and run any deferred computation a test returns, rather than returning it unrun. If your stack uses Effect, [Effect](../speed-up-tests/references/effect.md#run-the-effect) says how. Assert an exact refusal with a helper that names it. Make a guard test reach that guard, with another holder of the same kind when ownership is what it tests.

For `@ts-expect-error` examples, widen the API and confirm the directive becomes unused for the intended assignment. For collation, use the production database's locale (such as ICU `en-US`) in the test database, and confirm the test fails without the explicit `COLLATE "C"` it checks.

## Why

In the source repo:

- A merge-base test compared ancestors on one history and accepted a superset, so it could never fail.
- Three tests passed in 0 ms with impossible assertions, because each returned a lazy computation the test runner never ran.
- An audit of 316 test files found about 35 tests unable to detect the defects they named.
- The test database's bytewise collation let a collation test pass without its fix, until the test template moved to ICU `en-US`.

## Pointed at from

- [`test-audit`](../../../test-audit/SKILL.md).
- [The tests reviewer](../../../code-review/references/tests-reviewer.md), on evidence.
- [`speed-up-tests`](../speed-up-tests/references/flakes.md), on proving a flake's fix.
