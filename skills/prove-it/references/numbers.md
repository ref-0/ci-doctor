<!--
What: how to get a number that means what a claim says: the kind of evidence, like-for-like comparisons, interleaving, controls, the limiter and what else a number measured.
Where: read by a coding agent before it measures a before and after, a benchmark or a cost, and before it quotes the result.
Configure: nothing; a repo's own commands and thresholds come from its facts files.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Numbers

Part of the [`prove-it`](../SKILL.md) skill. The steps are in the skill; this page has the detail behind each.

## Two kinds of evidence

- **A retrospective baseline** uses only the history that exists: logs, records, bills, traces. It costs nothing to collect, and it can't show cause. Mark CPU, memory and the limiter unknown where the records lack them, and take the noise floor from comparable existing runs. Use the target's own observed spread, not another system's band.
- **A causal experiment** runs the thing on purpose: paired runs, a benchmark harness, a probe or telemetry step added for the purpose. It can show cause, and it costs: price it and get it approved first. Where you can't, collect matched later runs beside a control cohort, and say that's what you did.
- **Early evidence is provisional.** Label it so until it has the runs the decision needs.

## The decision and the noise floor

- Write the threshold before the first run: the result that would make you ship, drop or look further.
- Name one field per claim, and say which you expect to move. Wall time, CPU time, summed work, p50, p90, bytes and billed units move independently: summed test time says where the work is, the slowest shard sets how long the tests take, and the end-to-end time is what people wait for.
- Run the unchanged thing several times. Its spread, as a range or an interquartile range, is the floor. An effect inside it isn't one.
- For a benchmark: warm up first, run enough iterations that the timer's resolution doesn't matter, and keep the distribution, not one best run. A process's first run pays for loading, compiling and caches; say whether you're measuring that or past it.

## Like for like

What most often differs between "before" and "after" without anyone noticing:

- **The input:** a different set of files, rows, requests or tests ran. Check the count on each side.
- **The cache:** cold on one side, warm on the other. A build, a query planner, a CDN, a disk cache, a dependency cache or a task cache can replay work instead of doing it.
- **The machine and its load:** another machine type, another core count, other jobs beside it, CPU frequency scaling, a laptop on battery.
- **The hour:** full-run totals swung about 50% between morning and afternoon of one day in the source repo. Compare a thing with its own history at like hours.
- **The neighbour:** pieces of one run can differ as wholes, by 1.35–1.62× between shards of one CI run there. Judge a piece against its own history, not the one beside it.
- **The build:** debug against release, a flag, a dependency version, a different runtime.
- **The command and field:** the same command on both sides, and the time of the work, not the wall time, when setup is shared and not what changed.

## Interleaving and controls

- **Interleave:** before, after, before, after, on the same machine at like load. Sequential blocks, all the befores then all the afters, fold any drift in load, temperature or traffic into the result.
- **A control** is something the change didn't touch, measured over the same window: the untouched files, endpoints, queries or services. In the source repo, untouched test files got faster by about a fifth at the median over one campaign's window, so part of that campaign's drop wasn't its doing.
- **Compare a common cohort:** the items present on both sides. Count observations per item, flag sparse ones (fewer than three), and list new and split items apart.
- **A control misleads** when the change reaches it too: a shared cache warmed by the change, a shared machine it freed, a dependency it upgraded. Then it isn't independent, and subtracting its drift hides part of the effect or invents one. Report the raw changes side by side instead.

## The limiter

Ask why the result isn't double or half, and name what bounds it: CPU, memory, disk, network, a lock, a queue, a rate limit, a timer, one slow piece the rest wait for.

- Take it from a profile, counters, or CPU and memory taken during the run. A sampler starts and stops inside the step it measures and keeps its summary.
- A guess from reading code isn't a limiter, and neither is whatever happened to end last.
- A change that doesn't touch the limiter shouldn't move the number. If it did, look for what else changed.

## What else it measured

Rule out each with evidence before you credit the change:

- errors, retries and timeouts that ended work early or repeated it;
- skipped work, and cached work replayed instead of run;
- code that never ran, such as a path behind a flag, a test filtered out, a branch not taken;
- a different input set, a cold versus warm cache, load on the machine, a different hour;
- a piece too small to matter against the floor.

## Observed, replayed, modelled, guessed

- **Observed:** measured on real runs of the changed thing.
- **Replayed:** real past inputs run through the new rule or graph.
- **Modelled:** computed from measured parts, such as a layout's times packed from per-file records. Check it against real runs before it's believed.
- **Guessed:** an estimate from reading code. A code read in the source repo once put a poll at many times what it measured. A ceiling, a cancelled hold or a step count costs no time.

Overlapping fixes don't add up: two changes that each save a minute on the same wait save one minute together. Give each saving on its own, and the combined one only when measured.

## A cost

- Price a complete, closed window, with every attempt and retry, at list price, and say what's unpriced.
- Give a change as a monthly projection from the measured frequency, with the window it's from.
- Keep raw usage, a list-price projection and the actual bill apart, and say which you quote.
