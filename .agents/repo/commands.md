# ref-0/ci-doctor's commands

What the shared skills read for how to check and test `ref-0/ci-doctor`. Run everything from the root.

## Install

pnpm runs the root, `pnpm install --frozen-lockfile`, and the scorer keeps its own npm lock under `scorer/`. The root's `pnpm-lock.yaml` is written at adoption, once `@ref0/workspace`'s version is real.

## Pre-push set

Before every push, from the root. The pre-push hook runs these, as the root `package.json`'s `"ref0-workspace"."prePush"` names them, each through `vp run --cache`. The scorer's own install comes first: `npm ci --prefix scorer`.

1. Format and lint: none of the repo's own. The pre-commit hook runs `vp fmt` on the staged files, not `vp check --fix`: 1,279 lint errors `--fix` can't fix (measured 28 Nov) would refuse commits.
2. Types: `pnpm run check:types`, the scorer's `tsc`. Nothing outside `scorer/` has a type check.
3. Type coverage: none.
4. Docs budget: `pnpm run check`, which is `node scripts/check.ts`; its step 7 checks it.
5. The changed tests: `pnpm run check`; its step 10 runs every test file under `skills/`, `scorer/test/` and `scripts/`. When the push touches `scorer/`, also `pnpm run test:scorer`, the scorer's build and tests.
6. Lint and size tests: none. When the push touches `.github/workflows/`, run `node --test scripts/budgets/` by hand, as `ci-budgets.test.ts` asks.

Report the commands and their results with the head SHA they ran on. `REF0_SKIP_PUSH_CHECKS=1` skips the push checks, and says so.
