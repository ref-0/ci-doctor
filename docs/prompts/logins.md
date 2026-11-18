[Start: PROMPT.md](../../PROMPT.md)

# Logins and tools

What the user signs in to, and the tools some options need. Phase 0 checks what exists; the plan lists only what the approved items need.

## Logins and rights

You sign in yourself, after the plan is approved and only for what it selected. Agents check with status commands only, and never read credential files. The spend watcher's steps are in [`scripts/budgets/README.md`](../../scripts/budgets/README.md#3-the-spend-watcher), step 1, and the remote cache's in [`cache/remote/README.md`](../../cache/remote/README.md#set-it-up-step-by-step).

| Tool | Check | You run | Needed for |
|---|---|---|---|
| `gh` | `gh auth status` | `gh auth login` | Reading runs and logs, for the survey. After approval, and only where the plan needs them: setting repo secrets, Actions write on watched repos (an external spend watcher disables workflows and cancels jobs), issue write and workflow dispatch on an alerts repo. A classic OAuth token needs the `workflow` scope to push workflow files. |
| `blacksmith` (only on Blacksmith) | `blacksmith auth status` | Install with `curl -fsSL https://get.blacksmith.sh \| sh` or [Blacksmith's docs](https://docs.blacksmith.sh), then `blacksmith auth login` | Spend, job CPU and runner comparisons. Check it shows the intended org. |
| `wrangler` (only for the self-hosted Vite+ cache) | `wrangler whoami` | `wrangler login` | Deploying the remote cache, with `CLOUDFLARE_ACCOUNT_ID` set to the account you mean. |
| `cf`, [Cloudflare's CLI](https://developers.cloudflare.com/cf/get-started/) (only if you deploy with Workers Builds) | `cf auth whoami` | Install with `npm install --global cf`, then `cf auth login` (add `--no-browser` over SSH). It keeps its own login, apart from Wrangler's | Reading build logs Wrangler can't: `CLOUDFLARE_ACCOUNT_ID=<cloudflare-account-id> cf builds logs get <build-id>`. `cf cli search "<task>"` finds other commands. Keep downloaded logs private. |
| Each model CLI (only for scheduled or parallel agents) | Its auth-status command | Its sign-in, in the config home the agent will use | Record the executable, provider, config home, status command and account capacity. A host timer must run as the same user with that config home, or it runs signed out. A cloud job needs its own identity and scoped credentials ([`docs/harnesses.md`](../harnesses.md)). |

## Only if you use them

- **Shared local test slots** ([`scripts/local/`](../../scripts/local/README.md)): Perl with `Fcntl`/`flock`. Without it the slot script warns and runs unbounded. Check that a second caller waits behind a held slot.
- **Housekeeping timers and the spend watcher:** Linux `/proc`, Bash 4+, GNU coreutils and findutils, a working systemd user manager, and a service `PATH` that holds the CLIs they call. Enable lingering (`loginctl enable-linger`) if they must survive logout. On another OS, adapt the scheduler or skip them.
- **Local Rust builds:** `sccache` ([guide section 14](../pages/14-local-speed-and-many-agents-on-one-machine.md#fast-local-feedback)).
