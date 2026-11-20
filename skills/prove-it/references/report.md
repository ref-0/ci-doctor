<!--
What: the shape of a claim's evidence, for a PR, a plan, a report or a review comment.
Where: filled by a coding agent each time it quotes a number or claims a result.
Configure: nothing; the hub's campaign report template, if you use it, carries the same fields.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The report

Part of the [`prove-it`](../SKILL.md) skill. Fill one per claim. Leave a field empty only with the reason.

```markdown
**Claim:** <what got faster, cheaper, smaller or fixed, in one sentence>
**Kind:** <retrospective baseline | causal experiment>; <provisional | final>
**Decision, written first:** <the result that would change what we do>; threshold <value>
**Field:** <wall time, CPU time, p50, p90, bytes, billed units…>, from <where, collected when, by what>
**Noise floor:** <spread of repeated runs of the unchanged thing>, over <n> runs

| | Before | After |
| --- | --- | --- |
| Runs or samples | <n> | <n> |
| Conditions (machine, load, hour, cache) | <…> | <…> |
| Result: median, and spread | <…> | <…> |

**Raw change:** <before → after, unadjusted>
**Control:** <what the change didn't touch> moved <change> over the same window; <independent, because… | not independent, so not subtracted>
**Limiter:** <what bounds it>, from <profile, counters, CPU during the run>
**Ruled out:** <errors, retries, cached or skipped work, input, cache state, load, hour: each with its evidence>
**Label:** <observed | replayed | modelled | guessed>; <what will observe what's still modelled>
**Left open:** <what this doesn't show>
```

When the number is quoted elsewhere, in a PR title, a summary or a chat message, carry its count, spread and limiter with it: "p50 fell from 41 s to 29 s over 12 interleaved runs each, spread ±2 s, bound by the test database's start", not "30% faster".
