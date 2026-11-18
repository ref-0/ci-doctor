<!--
What: how to write a bounded model check that stays true to the code, and how to maintain it when covered code changes or the check fails.
Where: read by an agent writing a model, or when covered code changed or a model's check fails.
Configure: your model checker and where models live, in `.agents/repo/proof-tiers.md`.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Bounded models

Part of the [`proof-tiers`](../SKILL.md) skill. A model check is only worth what it describes. Any model checker works: TLA+ with TLC or a TypeScript port of it, Alloy, P, a hand-written explicit-state search in the test suite. The repo's `.agents/repo/proof-tiers.md` names its own.

## Write one

1. **Choose the target:** where a miss loses or strands work and tests rarely reach the order that breaks it, such as a lost wake, a queue waiting on itself or a write sent out of order.
2. **List what it covers:** the files and functions, by path. Find every writer of the state the model guards, such as with a symbol search, so no path that reaches it is left out.
3. **Model each step as the code's indivisible unit.** One lock held, one database transaction, or in an event loop the code between two `await`s. Name each action for the function it stands for, with the code's own names, so a reviewer can open it.
4. **State each rule in one plain sentence,** with the harm it prevents.
5. **Write a break for every rule:** one changed thing, as the code could change, such as a wait removed or two steps reordered. Register it where `proof-tiers.md` says, with the rule it must trip and the failure it should print. The model's test asserts that the model as it is passes and that each break fails on the rule it guards. A bug that was fixed stays as a break, named for the fix.
6. **Bound it to run in seconds** on one worker in CI, measured. Breaks run at the smallest bound that finds each. Say how much larger a bound is worth checking by hand.
7. **Record its scope:** the bound, the assumptions, what it leaves out, and the commit it was last checked against.
8. **Prove the wiring.** A standalone model doesn't read the code, so a scratch edit to the code can't fail it: mutate the model action that stands for the code instead, and assert the named rule fails. Where the check is linked to the source, importing or running it, make a scratch break in the code: the check must fail on the expected rule. Then remove it.

## When covered code changed, or the check fails

Give each check one outcome: **in sync**, **updated**, **bug** (the model describes the code and the code breaks a rule) or **blocked** (say exactly why). It can be updated and a bug.

1. **Run it as it is,** and record the result. A pass says only that the old description still holds. Don't decide drift or bug yet.
2. **Read every change to covered code** since the recorded commit: `git log -p <sync>..HEAD -- <covered files>`. Look for covered functions renamed, split or moved, and new code that writes the guarded state. Sort each: no effect; the model no longer describes the code (a step split in two, a branch added, a guard moved); the promise changed on purpose (cite the evidence); or the promise may be broken.
3. **Update from the code, not from the result,** before you rerun. Change a rule only for a promise that changed on purpose, with its old and new wording. Keep the bound unless the change makes it wrong, and say why if you lower it. Add a break for each new guard, and move breaks with the code they break.
4. **Rerun and judge.** On a pass, break the new behaviour the way a rule guards against, in the model action or, for a source-linked check, the code, and confirm the check catches it. On a failure, replay the counterexample against the code step by step: if a step can't happen, the model drifted: fix it and say what was wrong. If every step can, it's a bug: name the commit that brought it, tell the steps in the code's words and the harm in a sentence, and file it.
5. **Move the recorded commit** to the one you checked. Not for a blocked check.

A check that passed before an update and fails after was passing on a stale description. Put model updates in a pull request of their own, apart from a product fix, unless the product change is what moved them.

## Report

For each check: the outcome and the commits read; what changed in the model and why; the rerun and the break that shows it still fails; each bug in plain words, as numbered steps, never a dump of states; and what the model still doesn't cover.
