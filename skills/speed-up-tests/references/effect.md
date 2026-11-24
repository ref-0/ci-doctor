<!--
What: what was specific to testing and checking Effect code: running Effects in tests, fake clocks,
property tests from Schema, and Effect's diagnostics in the one type check.
Where: read by an agent writing, speeding up or reviewing tests of Effect code. Skip it on other stacks.
Configure: your test helpers and type checker, in `.agents/repo/speed-up-tests.md` and tools/workspace's config.
Reference implementation from a production monorepo; adapt to your repo.
-->

# If your stack uses Effect

Part of the [`speed-up-tests`](../SKILL.md) skill. The general rules hold; this page says what they meant for code written with [Effect](https://effect.website). Check each API against the Effect version you pin: names move between major versions.

## Run the Effect

A test that returns an Effect must run it. With `@effect/vitest`, use `it.effect` (test services, including a test clock) or `it.live` (the live clock and services), never a plain `it` that returns an Effect it never runs: three tests in the source repo passed in 0 ms with impossible assertions that way. The check [make a regression test fail for the right reason first](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/ci-doctor/references/checks/make-the-test-fail-first.md) has the general rule: every assertion executes.

## A fake clock

- **Inside Effect code, move Effect's own test clock,** under `it.effect`, rather than faking the platform's timers.
- **When you fake the platform's timers,** fake only the APIs the waited code uses. Faking `setImmediate` as well stopped Effect's runtime scheduler, and React's ([fixes](fixes.md#a-fake-clock)).

## Property tests

Schema's `Arbitrary` derives a generator from a schema, so a property can draw the shapes a sender sends. Still plant the bounds and raw bytes the schema refuses, as [`proof-tiers`' properties](https://github.com/ref-0/ci-doctor/blob/v0.3.0/skills/proof-tiers/references/properties.md#generators-that-reach-the-edges) says; a schema-shaped generator alone never reaches the parser's refusals. `@effect/vitest`'s `it.prop` runs a property with the repo's shared seed settings.

## Types and lint

Effect's language-service diagnostics can run inside the one authoritative type check, so no separate framework-only pass is needed. [guide section 9's "If you use Effect"](https://ci-doctor.ref0.dev/guide/docs/pages/09-workspace-tooling.md#if-you-use-effect) has the setup, and [`tools/workspace/`](https://github.com/ref-0/ci-doctor/blob/v0.3.0/tools/workspace/README.md) takes `effect-tsgo tsrs` as its injectable checker.
