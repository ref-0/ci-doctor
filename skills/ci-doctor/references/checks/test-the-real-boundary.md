<!--
What: a check that each platform guarantee and outside API a change relies on has been seen through the real boundary.
Where: read by an agent building on a platform limit, an outside API or a timeout.
Configure: your server's runtime and platform, and the probe commands, result archive and authorized environments in `.agents/repo/ci.md`'s Platform probes.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Test a platform's guarantee through its real boundary

**Moment:** build · **Concern:** correctness

## Check

- [ ] Each platform guarantee the change needs has held through the boundary that enforces it, on the real platform.
- [ ] Each outside API's fields and units match a real response before code depends on them.
- [ ] Limits have been checked on later runs and warm instances, as well as the first run.
- [ ] A timeout or cancel stops the work itself while its caller remains alive.
- [ ] The complete path has run on the deployed server before it's called done.

## How

Apply this when the change relies on a platform guarantee or an outside API's shape, not to every change. Read the probes and their raw results first, where ci.md's Platform probes keep them. Run a probe for any assumption still unanswered, only in an environment ci.md authorizes for it, and only once the plan allows it.

Keep the caller alive beyond a timeout and observe whether the remote work continues. Compare fresh and warm instances, and repeat measurements at another hour. A local copy of the server's runtime and CI's containers don't prove the platform's limits or networking. If your stack runs on Cloudflare Workers, [Workers](../../../speed-up-tests/references/workers.md#what-only-the-deployed-platform-shows) has what this meant there.

Read an outside API's real rows as soon as its token works. Record the field names, units and mapping the code uses. Run the whole deployed path and inspect its trace and logs.

## Why

In the source repo, on its serverless platform:

- A module start-up far longer than each local CPU cap it was tried under passed all of them, so a local cap didn't bind where the platform's would. A rule also ran past its deadline while its caller stayed alive.
- A large check passed in fresh instances, but most later checks, on warm ones, exceeded memory. A warm small container also lost the CPU speed its first seconds suggested.
- Platform probes exposed four networking differences hidden by local Docker, including servers crashing on a 64-character hostname.
- The deployed end-to-end run found five bugs that CI and probes had missed.
- The first real bill disproved three of four guessed container meter mappings, and the code was fixed before it merged.

## Pointed at from

- [`test-audit`](../../../test-audit/SKILL.md), validation.
- [`speed-up-tests`](../../../speed-up-tests/references/fakes.md), on what a fake can't prove, and its [Workers page](../../../speed-up-tests/references/workers.md).
