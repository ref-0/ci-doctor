<!--
What: the `blacksmith` CLI: install, sign-in, and the commands that answer cost, CPU, log, disk and cache questions.
Where: read by an agent measuring CI on Blacksmith, or before it asks a person to sign in.
Configure: your org (<org>). The CLI's sign-in is a person's.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The Blacksmith CLI

Part of the [`blacksmith`](../SKILL.md) skill. Check each command's flags with `--help`: they change between versions.

## Install and sign in

- **Install:** `curl -fsSL https://get.blacksmith.sh | sh`, or as [Blacksmith's docs](https://docs.blacksmith.sh) say.
- **Sign in:** the user runs `blacksmith auth login`, which opens a browser. Pass `--org <org>` if they belong to more than one. Check with `blacksmith auth status`, and that it shows the intended org.
- **A machine agent,** such as the spend watcher, uses an org token an org admin mints: `blacksmith org-token create --label <label>`. It's consumed with `blacksmith auth login --api-token - --non-interactive --organization <org>`, the token on stdin, never on the command line.
- **Agents never read the CLI's credential file,** `~/.blacksmith/credentials`.

## Commands

| Question | Command |
| --- | --- |
| Spend by job | `blacksmith usage --since 30d --breakdown-by workflow_job --format json` |
| One job's CPU and memory | `blacksmith jobs stats <job-id> --format json`, at `.vm_metrics.cpu.aggregates` |
| Runner choices compared | `blacksmith jobs aggregate --since 7d --group-by job_name,runner_label` |
| A workflow's billed jobs | `blacksmith jobs list --repo <org>/<repo> --workflow "<workflow-name>" --since 7d --format json`, paged with `--cursor` |
| Logs across the org | `blacksmith logs` |
| Sticky disks: list, inspect, clear | `blacksmith stickydisk` |
| Actions cache entries | `blacksmith cache` |
| CI against local changes on a warm runner | `blacksmith testbox`; the source repo hadn't relied on it yet |

- **Read jobs one by one** for CPU: aggregate views had no metrics for most jobs when this was measured. The sizing rule, resize only when three runs agree, is in [`ci-runners`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/ci-runners/references/sizing.md).
- **`jobs list`'s `billable_minutes` are vCPU-minutes,** started minutes times vCPUs. Its records name a run and a job by name; `ci-time.ts --bill blacksmith` joins them to GitHub's jobs that way.
- **Match the org and repo** to the one you mean before you trust a total: a login can see several.
