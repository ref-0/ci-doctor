<!--
What: how to build property tests' generators that reach the edges, keep a maintained break per property, and how CI runs them: a fixed seed on a PR, a new seed and more cases in main's sweep.
Where: read by an agent writing a property test, when a break is missed, when covered code changes, or reading a property failure in CI.
Configure: your property library, seed, count and size variables, the sweep's depth, generators' module and break runner, in your test setup and `.agents/repo/proof-tiers.md`.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Properties

Part of the [`proof-tiers`](../SKILL.md) skill. A property checks a rule against generated inputs, then shrinks the first that breaks it. Give one to code that reads bytes or text from outside, code that writes what another part reads back, code that must agree with another implementation, and code that reads in chunks. Any library works: fast-check, Hypothesis, proptest, QuickCheck; if your stack uses Effect, see [Effect](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/speed-up-tests/references/effect.md#property-tests). The repo's `.agents/repo/proof-tiers.md` names its library, setup file, seed, count and size variables and its property files. [guide section 5](https://ci-doctor.ref0.dev/guide/docs/pages/05-tiers-what-runs-where.md) places them in the tiers.

## Write one

1. Read the function and its callers. Write down what it promises and what a caller can send it. The caller decides what's credible input.
2. Put generators in the package's testing module, reusing what's there.
3. Name the rule in the test's name, as the code promises it.
4. Register a break for the property in the repo's break runner, and run it: it must be caught.
5. Add the file to the repo's list of property files.

## Generators that reach the edges

Random values rarely land where code goes wrong, so generate them there.

- **Shape it as the sender does, and also feed it raw bytes.** Valid messages alone never reach the parser's refusals; random bytes alone rarely pass its first check. Generate both.
- **Plant each bound:** lengths and counts at, just under and just past each limit, where a carry or an off-by-one lives.
- **Split chunks everywhere.** For code that reads in chunks, try every cut, or arbitrary partitions, not one random cut: where the chunks break must change nothing.
- **Draw related values together.** A path drawn apart from its pattern seldom matches it; draw half of them from the pattern.
- **Count what a generator draws before a break run.** Make a scratch property that fails at its last case and prints how many draws hit each edge that matters. Reshape the generator until they do.

## A maintained break per property

- **A credible break:** a guard removed, a bound off by one, a chunk read twice. The runner applies it, runs the property file and restores the code. Each must be caught. A timeout counts as caught only with evidence that the property ran the mutated code and its own bound fired there, such as the case it was on; a hang in start-up or teardown proves nothing.
- **A missed break is a gap in the generators,** not a pass: fix the generator until it's caught.
- **Rerun the breaks** whenever code a property covers changes. A break that no longer applies means the code moved: move the break with it.
- **An equivalent break** changes no output, only cost or order. Say why, and keep it out of the list.

## Findings and replay

- **Findings stay findings.** When a property fails on the code as it is, shrink it, replay the shrunk input against the code and report it in the code's words. Narrow a generator only for an input no caller can send, and say which caller and why.
- **A bug a property found** stays as a fixed case in the module's own test file.
- **This page owns seeds and replay;** [`fix-flaky-test`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/fix-flaky-test/SKILL.md) owns intermittent failures. A fixed seed replays the same inputs, but scheduling, a changing oracle or a timeout can still fail them only sometimes. Replay the exact inputs and environment, seed, count, size and versions, to tell a counterexample in the code from a nondeterministic harness.
- **Replay tokens are transient.** Use a library's replay token or a pinned seed only while you work, never in a commit: the seeded settings replay a CI failure.
- **Write no regression file** such as `proptest-regressions`: the seed replays it.

## How CI runs them

- **A PR runs one fixed seed,** at normal depth, from the repo's shared settings. A retry or a rerun draws the same inputs, so a failure that doesn't repeat on them points at the harness, not at the generator.
- **Main's sweep runs them deeper from a new seed,** taken from the run's ID: in the source repo, 2,000 cases in TypeScript and 1,000 in Rust. A retry keeps the run's seed, so it repeats the same cases. The log prints the seed.
- **A failure in the sweep is a finding,** not a flake. Set the logged seed and the sweep's count to see it again locally. A bisect can use a run-seeded check only with the recorded seed, count, size and versions held fixed at every step.
- **Put a property that plays a run of steps in its own property file** (for example `<module>.fuzz.test.ts`), so the sweep runs it deeper. A property over a few small values may stay in the module's test file.
- **Give a slow property a timeout** of its case count times its measured time a case, with room for the sweep's slower runner, and state it beside it. The timeout scales only by the count, never by a guess.
- **A lint rule can hold every property to the shared seeded settings,** so PR runs reproduce while the sweep picks fresh seeds ([guide section 9](https://ci-doctor.ref0.dev/guide/docs/pages/09-workspace-tooling.md#custom-lint-rules-that-guard-the-shortcuts)).
