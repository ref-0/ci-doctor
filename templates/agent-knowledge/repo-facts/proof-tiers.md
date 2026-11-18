<!--
What: the facts about one repo's deep proofs that the proof-tiers skill reads: its models, property library, seeds and commands.
Where: copy to `.agents/repo/proof-tiers.md` in your repo. Delete it if the repo has neither models nor property tests.
Configure: replace every <placeholder>, or mark a section "not applicable" with why.
Reference implementation from a production monorepo; adapt to your repo.
-->

# <repo>'s proof tiers

What the shared `proof-tiers` skill reads about this repo. Point at the files that hold each value.

## Bounded models

| Model | Covers (files, functions) | Bound | Breaks | Last checked at |
| --- | --- | --- | --- | --- |
| `<model file>` | `<paths>` | `<bound CI runs>` | `<n>` | `<commit>` |

- Checker: `<tool and where it's pinned>`. Models live in `<folder>`.
- Run one: `<command>`. Run its breaks: `<command>`.
- Which tier runs them: `<PR when covered paths change / sweep>`, as `<selector-script>` says.
- Breaks are registered in `<file or folder>`. Each names the rule it breaks and the failure the checker must print (`<the expected signal, such as an invariant's name>`).
- Assumptions and exclusions (what each model leaves out, and why): `<where they're written>`.
- Replay a counterexample: `<command, or the trace file the checker writes>`.

## Property tests

- Library: `<library>`, set up in `<setup file>`.
- Seed, count and size: `<seed variable>`, `<count variable>`, `<size variable>`; a PR uses `<fixed seed>`, the sweep `<seed source and count>`.
- Generators: `<testing module>`.
- Property files: `<glob, such as *.fuzz.test.ts>`, listed in `<inventory file>`.
- Replay one failure locally: `<command with the seed and count>`.
- Run the breaks: `<break-runner command>`; each prints caught or missed. Breaks are registered in `<file>`, each naming the property it breaks and the failure expected.
- Assumptions and exclusions (input ranges, what the generators leave out): `<where they're written>`.

<!-- Example:
- Seeds come from FUZZ_SEED and FUZZ_RUNS; a PR runs seed 42 at 100 cases, the sweep the run's ID at 2,000.
- `node <root>/skills/proof-tiers/scripts/run-breaks.ts --config .agents/repo/breaks.json [words]` applies each break registered there, runs its test, prints CAUGHT, UNCLEAR, HUNG, MISSED or SKIP, and restores the code.
-->
