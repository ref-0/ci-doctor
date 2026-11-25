<!--
What: when a test earns properties over generated input instead of hand-picked cases.
Where: read by an agent writing a test of a parser, a wire format, a limit or code that must agree with another implementation.
Configure: whether your repo adopted proof-tiers.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Generated input

Part of the [`test-audit`](../SKILL.md) skill: when hand-picked cases are not enough. Read it when the test covers a parser, a wire format, a limit or code that must agree with another implementation.

A test of a parser, a wire format, a limit or code that must agree with another
implementation may earn properties over generated input, since a hand-picked case
covers only the inputs someone thought of. Where the repo has property tests and adopted
[`proof-tiers`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/proof-tiers/SKILL.md), it decides where generated coverage pays for
its cost, and how it runs.
