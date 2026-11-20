---
name: proof-tiers
description: "Writes and maintains bounded model checks and property tests, and which CI tier runs them. Use when testing state machines, retries, queues, leases, parsers or wire formats, fuzzing, or when a model check or property test fails. Not for a test's value (test-audit); CI's jobs and tiers (ci-doctor)."
---

<!--
What: the rules that keep the two deep proofs honest: bounded models of ordering, and property tests of inputs.
Where: read by a coding agent writing or maintaining either, or moving one between CI's tiers.
Configure: your repo's `.agents/repo/proof-tiers.md`, from the agent-knowledge skill's templates/repo-facts/proof-tiers.md.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Proof tiers

Two kinds of proof cost more than an ordinary test, so they often run deeper in a slower tier than a pull request: a **bounded model** checks every order of a model's steps up to a bound, and a **property test** checks the real code against many generated inputs. Either can pass while proving nothing: a rule weakened until it passes, a bound cut until nothing happens, a generator that never reaches the edge. Moving a proof to a slower tier must keep it honest, so the rules here hold in every tier.

A stack with neither can skip this skill. Read the repo's `.agents/repo/proof-tiers.md` first (template: [`repo-facts/proof-tiers.md`](https://github.com/ref-0/ci-doctor/blob/next/skills/agent-knowledge/templates/repo-facts/proof-tiers.md)): its models and covered files, its property library, seeds and commands. Use whatever model checker or property library the stack already has; nothing here needs a particular one.

## Which proof

- **Ordering, retries, crashes, leases, queues, state machines:** a bounded model. Read [bounded models](references/bounded-models.md), also when a model's check fails.
- **Bytes or text from outside, code whose output another part reads back, code that must agree with another implementation, code that reads in chunks:** a property test of the real code. Read [properties](references/properties.md). A model of a parser proves nothing about the parser.
- **A property that must hold at every size:** a proof, which needs a person's yes.

## Rules for both

- **True to the code.** A model's step names the function it stands for; a property imports the function it checks.
- **Able to fail.** Each rule or property has a registered break, a credible change that it must catch, mapped to the rule it trips and the failure it prints, where `proof-tiers.md` says. Run the breaks in CI's cheap tier or by hand after every change to covered code, with [run-breaks.ts](scripts/run-breaks.ts) or the repo's own runner. A hang or a failure for another reason isn't a catch.
- **Findings stay findings.** Report a counterexample in the code's words. Never weaken a rule, lower a bound, narrow a generator or filter an input until it passes.
- **Honest about scope.** Record what each proof covers, under which bound and assumptions, and what it leaves out. A pass covers the model within its bound, not the system.
- **Kept in step.** Record the files each proof covers and the commit at which someone last confirmed it describes them. A pull request that changes covered code updates the proof, or says in its body why it still holds.
- **Cheap where every PR pays.** The PR tier runs a fixed seed or a small bound in seconds; the sweep runs deeper. Measure before you set either.
- **Reviewed by someone else.** A change to a rule, a break or a bound gets an independent review, as [`review-gate`](https://github.com/ref-0/ci-doctor/blob/next/skills/review-gate/SKILL.md) says if the repo adopted it, or by the repo's own review process.

## Moving one to a slower tier

Follow [the tiers](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-workflows/references/tiers.md). Keep a cheap run on the pull requests that touch what it covers, keep its breaks running there, and say in the PR which bound or count moved and how long a fault it would catch can now sit on `main`.

## Related

- [`speed-up-tests`](https://github.com/ref-0/ci-doctor/blob/next/skills/speed-up-tests/SKILL.md): a slow proof's waits.
- [How CI runs them](references/properties.md#how-ci-runs-them): seeds on a PR and in the sweep.
- [`ci-merge-workflow`](https://github.com/ref-0/ci-doctor/blob/next/skills/ci-merge-workflow/SKILL.md), if the repo adopted it: reading a property failure in a PR's run.
- [`test-audit`](https://github.com/ref-0/ci-doctor/blob/next/skills/test-audit/SKILL.md), if the repo adopted it: whether a test is worth keeping.
