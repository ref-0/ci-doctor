<!--
What: the five graphs that decide how far a change reaches and how long CI waits, and how to check each.
Where: read by a coding agent in Phase 1, when it maps the repo, and before it changes packages, exports, folders, tasks or jobs.
Configure: nothing; the package-graph checker is in tools/workspace/, configured by the repo's workspace-tools.json and package-graph.json.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Graphs

Selection and reuse can only be as narrow as the graphs they walk. [Guide section 21](../../../../docs/pages/21-optimize-all-of-your-graphs.md) has the why, what it cost and what it saved; this topic is what to check. Before approval, everything here is reading and counting, with no installs and no runs ([the hub's rule](../../SKILL.md#before-approval-read-only)).

## Map all five in Phase 1

For each graph, record in the stack map where it's declared, whether a check holds it, and one measured width. Mark a graph not applicable only with a reason, such as "one package".

| Graph | Where it's declared | Is it held? | Count |
|---|---|---|---|
| Package dependencies | Manifests; any import-boundary lint config or graph file | A check fails an import no edge allows, a relative path out of a package and an import of an app | Edges; imports no manifest lists |
| Package export paths | Each shared package's `exports` and its entry files | Entry files re-export by name; a check fails an entry the edge doesn't list | Entries per shared package; whether a root barrel re-exports most of it; test files one module's edit selects |
| Layers inside a package | Folder conventions, any layer config | A check fails an import beside or above; exceptions can only shrink | Folder cycles in the largest packages |
| Workspace tasks | The task runner's config | Each cached task's inputs and outputs declared or tracked (guide section 6) | Keys a one-line edit moves |
| CI jobs | Workflow `needs:` and waits | A plan job gates the others (guide section 3) | The critical path; blocked and queued time per job |

Counting the first three takes the repo's imports, read without running anything: a parser over tracked files, or the test runner's own listing where it lists without running (`vitest list --filesOnly --changed` builds the import graph but runs no test; ask before you run it if the plan isn't approved). [`scripts/graph/`](../../../../scripts/graph/README.md#measure-the-graphs) measures graphs 1–4 from committed trees, with nothing installed or run, and replays recent merges through them; paste its headline into the stack map. Graph 5 comes from CI's jobs API, as Phase 2 collects it.

## What to propose

Only for a graph whose width bears on the measured limiter. In the order guide section 21's [adoption steps](../../../../docs/pages/21-optimize-all-of-your-graphs.md#adopt-them-in-a-repo-that-has-none) give:

1. **No check on the package graph:** declare the current graph as it is and hold it in CI, with [`tools/workspace/`'s `package-graph`](../../../../tools/workspace/README.md#the-package-graph). That narrows nothing by itself; it stops the graph widening.
2. **One module's edit selects most of a package's importers:** split the root barrel into entry points, by a script, one package per change, with the selection measured before and after. Name the modules you'll measure in the plan.
3. **Cycles inside a large package make near selection climb to most of it:** layers, with today's imports as exceptions, then moves.
4. **Keys or the critical path:** guide sections 6 and 7, through the [`ci-workflows`](../ci-workflows/TOPIC.md) topic.

Each is a change to the user's code, not their CI, so it goes in the plan as its own step with its own yes.
