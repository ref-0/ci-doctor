/**
 * tasks.ts: a workspace's task graph at one commit, from the task runner's config and the
 * packages' scripts: each task's dependencies, its declared inputs and outputs, and whether a
 * cache keys it at all.
 *
 * It reads, statically and without installing anything:
 * - Turborepo: `turbo.json` (`tasks`, or v1's `pipeline`), packages' `turbo.json`, `globalDependencies`;
 * - Nx: `nx.json` (`targetDefaults`, `namedInputs`, `cacheableOperations`), `project.json` targets;
 * - Vite+: `run.tasks` and `run.cache` in `vite.config.*`, when they're plain object literals;
 * - package scripts that call each other: `pnpm run x`, `npm run x`, `yarn x`, `bun run x`,
 *   `run-s`/`run-p`, `pre`/`post` scripts, and recursive runs (`-r`, `--filter`, `turbo run`,
 *   `nx run-many`, `vp run -r`), which fan out to every package with that script.
 *
 * Inputs a runner infers at run time (Vite+'s automatic tracking, Nx plugins' inferred targets)
 * aren't visible here; they're counted, and auto-tracked inputs are approximated by the package's
 * own files.
 *
 * The reader itself is shared with the scorer, which reads the same configs from GitHub:
 * `scorer/src/graph-core.ts`. This file feeds it one commit's tree.
 *
 * Reference implementation from a production monorepo; adapt to your repo.
 */
import { readTaskGraph } from '../../scorer/src/graph-core.ts';
import type { TaskGraph } from '../../scorer/src/graph-core.ts';
import type { FileGraph, Git } from './read.ts';

export { objectLiteral, readTaskGraph, scriptCalls, taskFiles, vitePlusRun } from '../../scorer/src/graph-core.ts';
export type { How, InputMode, Runner, Task, TaskEdge, TaskGraph } from '../../scorer/src/graph-core.ts';

/** The task graph at a file graph's commit. */
export const readTasks = (git: Git, graph: FileGraph): TaskGraph =>
  readTaskGraph({
    paths: graph.files.keys(),
    text: (path) => {
      const id = graph.files.get(path);
      return id === undefined ? undefined : git.blobs([id]).get(id);
    },
    packages: graph.packages,
    owner: graph.owner,
    imports: graph.edges,
  });
