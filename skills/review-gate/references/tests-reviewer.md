<!--
What: the tests reviewer: one reader of a PR's test code, in round 1 only.
Where: read by the agent that runs a PR's review, or by the reviewer itself.
Configure: what your repo counts as test code, and any line count under which a small test change needs no review.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The tests reviewer

Part of the [`review-gate`](../SKILL.md) skill. Speed work and flake fixes can quietly weaken what a test proves, so a PR that adds or changes tests, test helpers or test settings gets one reviewer who reads only for that, as [guide section 15](https://ci-doctor.ref0.dev/guide/docs/pages/15-the-agent-workflow-around-ci.md) says. Use a second model where you can. Only a tiny, low-risk test change skips it, with a `No review: low risk` line (20 changed test lines or fewer here). [The skill](../SKILL.md) has the gate; this page is the tests reviewer's own.

## Rounds and findings

The tests reviewer runs in round 1 only, beside the PR's other reviewers; tests check its fixes, so it gets no round 2. Reproduce a finding before acting on it, fix in-scope P0 and P1 findings in the PR, and file, keep or dismiss the rest with a reason, as [the skill](../SKILL.md#run-the-review) and the record's states say.

## The reviewer's question

Will this test fail only when the behaviour it names breaks, on a loaded CI runner, next to every other test that shares its settings?

Trace the changed tests through their production owners, fixtures, helpers and shared settings. Review the untouched siblings those settings reach too.

## What can make a test lie

- **Wall clock.** Flag an assertion on elapsed time or a deadline where an observed state proves the behaviour. A one-second after-restart check can expire under load.
- **Shared test settings.** For a changed timer floor, poll or settle period, ask for a grep of the setting's readers. List every test that reads a state the next tick could change. Each must hold or put off that job before the read. Reading within the window still races, untouched siblings included.
- **Timer order.** A test that turns a scheduled job off does so before it releases work. Trace both steps.
- **Banned fixes.** Flag a retry, a timeout raised alone, a skip, or a production API widened for a test.
- **The environment.** Check assumptions about the runner's `/etc/gitconfig`, `HOME`, keyrings and network. Git fixtures set `GIT_CONFIG_NOSYSTEM`, so a runner's `safe.directory = *` can't change the result.
- **Shared helpers.** When a shared test helper's signature changes, find the open PRs that call it: two PRs once collided at one helper, and a third fixed it.
- **Waits.** Each wait observes the effect itself: it awaits the effect's own event or promise where there is one, and otherwise polls the observed state with a bound, failing with what it saw. [Wait for the effect](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/wait-for-the-effect.md) has the rule.
- **Value.** Where the repo adopted `test-audit`, apply [its authoring gate](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/test-audit/SKILL.md#authoring-gate). Name the behaviour, the credible regression and the proof no other test supplies. Reject a test-only production seam. For a deleted test, show where its coverage remains.
- **Evidence.** A flake fix needs the test repeated with no retry, plus a mutation that reopens the race and fails the test. A passing retry proves no fix. [Make the test fail first](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-doctor/references/checks/make-the-test-fail-first.md) has the rule.

## The report

Name the state, order or environment that makes the test pass or fail wrongly, and the smallest fix. Report only what the trace or reproduction supports, with a priority, P0 to P3.
