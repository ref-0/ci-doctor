<!--
What: the index of checks: one rule each, with its questions, commands and the incidents behind it.
Where: copy into your repo's agent docs (for example `.agents/checks/`) and link each page from the skills that need it.
Configure: the placeholders listed below, and your own incidents under each page's Why.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Checks

A check is one rule, short enough to read at the moment it applies. A skill says how to do a kind of work. A check says what must be true before you move on. [guide section 17](../docs/pages/17-keeping-agent-knowledge-from-going-stale.md) explains why they're kept apart.

## By moment

| Moment | Check |
| --- | --- |
| Before design | [Read what was tried before changing CI](ci-read-what-was-tried.md) (a template) · [Measure CI before changing it](ci-measure-before-changing-it.md) · [Size a runner by its CPU](ci-size-a-runner-by-its-cpu.md) |
| Build | [Make a regression test fail for the right reason first](make-the-test-fail-first.md) · [Test a platform's guarantee through its real boundary](test-the-real-boundary.md) · [Wait for the effect, not the clock](wait-for-the-effect.md) |
| Build and review | [Check a change to CI against real output](ci-check-a-workflow-change.md) |
| Running the work | [Run only the checks that decide something](run-only-checks-that-decide.md) · [Budget CI at list price](budget-ci-at-list-price.md) |
| When a run is slow | [Keep slow test files out of the shards](ci-keep-slow-files-out-of-the-shards.md) |
| Before merge | [Check what CI ran](check-what-ci-ran.md) |

## A page's shape

```markdown
<!-- What: … Where: … Configure: … -->

# <A rule, as an instruction>

**Moment:** <when it applies> · **Concern:** <tests and CI, cost, correctness…>

## Check
- [ ] <a yes-or-no question, one per line>

## How
<the commands and steps that answer the questions>

## Why
<incidents and their numbers, in order: what went wrong without the rule>

## Pointed at from
<the skills and docs that link here>
```

The source pages also had a "Since" line, naming the date and change that added the rule. It's dropped here, and the examples' dates are given as weeks of the source repo's CI work; in your repo, date both, since a date tells a reader how old the lesson is.

## Adding a check

- Add one when the same mistake has happened twice, or once at real cost. Name the incident and its numbers under Why.
- Keep it to one rule. If two questions need different moments, write two pages.
- Link it from the skill that does the work, and list that link under Pointed at from.
- Before adding, search the existing pages. Generalize a near-match rather than append a new one.

## Placeholders

| Placeholder | Meaning |
| --- | --- |
| `<org>/<repo>` | Your GitHub repository. |
| `<run-id>`, `<job-id>` | A GitHub Actions run's ID, and one job's. |
| `<pr>`, `<head>`, `<base>` | A pull request's number, its head's SHA, and its target branch (`main`, or a stacked PR's parent), or that branch's SHA where a log prints one. |
| `<reviewed-sha>` | The head a review session's last round reviewed. |
| `<status>` | A GitHub Actions run status: `queued`, `in_progress`, `waiting`, `pending` or `requested`. |
| `<workflow-name>` | The workflow's `name:`, as GitHub's and Blacksmith's job records carry it. |
| `<price-per-minute>` | A runner label's list price per started minute, in the unit its provider bills, as `.agents/repo/ci.md` records it. |
| `<app-dir>` | The app or package whose tests a page talks about. |
| `<monthly-cap>` | The month's CI budget you agreed, at list price. |
| `<budget-watcher>` | The command or service that reads spend and, where the user approved it, stops CI at the cap. |
| `<gate-job>` | The one job branch protection requires, which waits for the others. |
| `<test-cmd>` | Your repo's command to run one test file. |
| `<file>`, `<name>`, `<paths>` | A test file, a test's name, and paths to match. |
| `<n>`, `<ms>`, `<table>` | In a quoted log line or query: a count, milliseconds, a table name. |
| `<source-file>` | A changed source file whose related tests should run. |
| `<change>`, `<date>` | A row of the tried-and-dropped table. |

The incidents under each Why are from the source repo, with amounts given relative to its own baseline rather than as its real timings. Keep them as examples, or replace them with your own as they happen, with your own measured numbers.
