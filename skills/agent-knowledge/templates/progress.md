<!--
What: where the work stands, so a new session or a compacted one picks up where the last one stopped.
Where: before approval, next to the plan in the scratch location the user approved. After approval, where the authorization record says, such as `.agents/ci-doctor/progress.md` in the repo.
Configure: the placeholders below. Rewrite it at the end of each phase, and before a session ends.
Reference implementation from a production monorepo; adapt to your repo.
-->

# CI work: progress

- **Updated:** `<date and time, UTC>`
- **Playbook:** ci-doctor `<version or tag>`, and how it's installed
- **Phase:** `<0–6>`, `<its name>`
- **Plan:** `<path to the plan>`; approved `<date>` by `<who>`, or not yet
- **Authorization record:** `<path, or the plan's section>`
- **Where this file lives:** `<path>`. Say it in the plan, so the next session finds it.

## Done

One line each, with its evidence: a run, a PR, a measurement file.

- `<what>`: `<evidence>`

## Next

The first item is what the next session does first.

1. `<action>`, `<within which line of the authorization record>`

## Waiting on

- `<what the user, a run or a review owes, and since when>`

## Open questions

- `<question>`: `<what each answer would change>`
