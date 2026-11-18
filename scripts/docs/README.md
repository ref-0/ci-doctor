# Docs and type coverage: checks that keep agents' context small and every file checked

Three static checks. One keeps the docs agents load within byte budgets, so bloat you cut can't grow back. Another makes sure no TypeScript file escapes the type check or lint. The third fails on any broken link or anchor. Why: [guide section 17](../../docs/pages/17-keeping-agent-knowledge-from-going-stale.md) for the docs budget, and [guide section 9](../../docs/pages/09-workspace-tooling.md) for workspace checks.

## Files

| File | What it does | Where it runs |
| --- | --- | --- |
| `docs-budget.ts` | Reads the Markdown the repo tracks. It fails on: a skill description over 320 characters; your own `SKILL.md` over 10 KB; root `AGENTS.md` over 12 KB; any other `AGENTS.md` or the shared rules file over 8 KB; a table in `GLOSSARY.md`, or an entry over 400 characters; and dated history lines such as "Changed 15 Oct 2026". Upstream skill copies are held only to the description budget. Those are skills `skills-lock.json` names, or that match `upstreamPrefixes`. | CI's static job, and before a push |
| `docs-budget.test.ts` | Each budget at and one past its limit, history, upstream copies, and the command on a throwaway repo. | Anywhere |
| `check-links.ts` | Every relative link and `#anchor` in the repo's Markdown, outside code: the file must exist and the heading must too, slugged as GitHub does. Exits nonzero on any break. `--mentions` also checks bare repo paths in code and YAML comments; it's advisory, because a path that's relative to a skill or only exists once installed shows up too. | CI's static job, before a push, and after moving or renaming any file |
| `check-links.test.ts` | Files, folders, headings and duplicate headings pass; a missing file or heading fails; code is ignored; a stale path mention is found. | Anywhere |
| `type-coverage.ts` | Follows the root `tsconfig.json`'s references, and each project's own, with `tsc --showConfig`. Names every tracked `.ts`, `.tsx`, `.mts` or `.cts` file no project includes. With `lintFilesCommand` set, it also names each tracked file lint doesn't read, other than generated ones. | CI's static job |
| `type-coverage.test.ts` | The check on a throwaway workspace with nested references and a stand-in lint. It needs `typescript`: set `TYPE_COVERAGE_NODE_MODULES` to a `node_modules` holding it, or it skips. | Anywhere |

## Wire it in

Add these once the user approves the plan ([PROMPT, "Before approval"](../../PROMPT.md#before-approval-read-only)).

```yaml
# In CI's static job, after the install
- run: node scripts/docs/docs-budget.ts
- run: node scripts/docs/type-coverage.ts
- run: node scripts/docs/check-links.ts
```

- **Docs budget.** Set `budgets` from what your docs hold after you compact them, with headroom. Set `layout.skillPath` if your skills live elsewhere (e.g. `.claude/skills/`). Set `upstreamPrefixes` for vendor skills you copy in by hand, and `rules` to your shared rules file, or `undefined`.
- **Type coverage.** Your root `tsconfig.json` should list every project in `references` (often with `"files": []`). Set `lintFilesCommand` to a command that prints the files your linter reads, one per line. Vite+ has `vp lint --debug=files`. For ESLint or others, write a short script that does the same. `generated` matches what a tool writes, which lint may ignore.

The type check itself is `tsc --build` on the root, or your workspace's equivalent. This script only makes sure it sees every file.

## Placeholders

None. Every value is a default in the config block at the top of each script, ready to change.
