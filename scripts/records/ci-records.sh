#!/usr/bin/env bash
# ci-records.sh: keeps CI's records before GitHub drops the logs they're read from, after 90 days.
#
# Where it runs: on a maintainer's machine, from the systemd user timer `ci-records.timer`, each
# night at 03:30. Never from agents' sessions: they share the login's API quota.
#
#   bash ci-records.sh              the last 21 days up to yesterday, oldest first, in UTC
#   bash ci-records.sh <YYYY-MM-DD> that day only
#   bash ci-records.sh install      links the service and timer, and starts the timer
#
# Configure: the block below, or the same names as environment variables.
#
# Each day goes into its ISO week's file, <records-dir>/<YYYY-Www>.jsonl.gz, one record per attempt
# of each run of the workflow (see ci-records.ts). Only attempts a file doesn't hold yet, or holds
# incomplete, are read, so a night that stopped early, or a night the machine was off, is caught up
# on the nights after. A night spends about 1,500 API calls in all: each day's collection writes the
# calls it made, and the next day gets what's left. The collector stops itself once fewer than
# 1,000 of the hour's calls are left for everything else on the login.
#
# It runs the default branch's collector, not a working checkout's: it copies ci-records.ts from
# <remote>/<branch> into a cache folder first. So before installing the timer, commit and push
# your configured collector to that branch, and run one day by hand (`bash ci-records.sh
# <YYYY-MM-DD>`): see the week's file appear and its journal line name the attempts. The collector
# imports nothing outside Node, so one file is enough. If yours grows imports, copy them too: a
# copied script missing a new import once stopped collection silently for days. Check the newest
# week's file before believing a quiet week.
#
# Reference implementation from a production monorepo; adapt to your repo.
set -euo pipefail

# ---- Config -------------------------------------------------------------------------------------
# A clone of the repo whose CI is recorded.
checkout=${CI_RECORDS_CHECKOUT:-<checkout-dir>}
# The remote and branch whose collector runs: your default branch.
remote=${CI_RECORDS_REMOTE:-origin}
branch=${CI_RECORDS_BRANCH:-main}
# The repository whose runs to read, <org>/<repo>. Empty uses the collector's REPO.
repo=${CI_RECORDS_REPO:-}
# The collector's path inside that repo.
collector=${CI_RECORDS_COLLECTOR:-scripts/records/ci-records.ts}
# Where the weekly files go: a folder in a private repo, or any directory you back up.
records=${CI_RECORDS_DIR:-<records-dir>}
# Commit and push each night's new files when the records folder is in a git repo: 1 or 0.
commit=${CI_RECORDS_COMMIT:-0}
# The night's API calls, shared by its days.
calls=${CI_RECORDS_CALLS:-1500}
# How many days back a night looks, so a week the machine was off is caught up.
lookback=${CI_RECORDS_DAYS:-21}
# Where the copied collector runs from.
runner=${XDG_CACHE_HOME:-$HOME/.cache}/<project>/ci-records
# -------------------------------------------------------------------------------------------------

here=$(dirname "$(readlink -f "$0")")

if [ "${1:-}" = install ]; then
  mkdir -p "$HOME/.config/systemd/user"
  ln -sf "$here/ci-records.service" "$HOME/.config/systemd/user/ci-records.service"
  ln -sf "$here/ci-records.timer" "$HOME/.config/systemd/user/ci-records.timer"
  systemctl --user daemon-reload
  systemctl --user enable --now ci-records.timer
  exit 0
fi

case "$checkout$records$runner" in
  *'<'*) echo "ci-records.sh: fill in the config block first" >&2; exit 2 ;;
esac

if [ -n "${1:-}" ]; then
  days=("$1")
else
  days=()
  for back in $(seq "$lookback" -1 1); do days+=("$(date -u -d "$back days ago" +%F)"); done
fi

git -C "${checkout:?}" fetch -q "$remote" "$branch"
mkdir -p "${runner:?}" "${records:?}"
git -C "$checkout" show "$remote/$branch:$collector" > "$runner/ci-records.ts"
repo_args=()
[ -z "$repo" ] || repo_args=(--repo "$repo")

status=0
changed=()
for day in "${days[@]}"; do
  [ "$calls" -gt 0 ] || break
  name=$(date -u -d "$day" +%G-W%V).jsonl.gz
  out=$records/$name
  week=$runner/week.jsonl
  rm -f -- "${week:?}"
  [ ! -f "$out" ] || gzip -dc "$out" > "$week"
  # A line cut short, with no newline at its end, is dropped, and its attempt is read again: a full
  # disk once cut one, and every night after failed to read the file until someone noticed.
  if [ -s "$week" ] && [ -n "$(tail -c 1 "$week")" ]; then
    sed -i '$d' "$week"
    echo "ci-records.sh: dropped a line cut short at the end of $name"
  fi
  before=$( [ -f "$week" ] && wc -l < "$week" || echo 0)
  before_sum=$( [ -f "$week" ] && md5sum < "$week" || echo none)

  # The collector appends as it goes, so keep what it got even when it stops early.
  rm -f -- "$runner/used"
  node "$runner/ci-records.ts" "${repo_args[@]}" --since "$day" --until "$day" --out "$week" --calls "$calls" --used "$runner/used" || status=$?
  after=$( [ -f "$week" ] && wc -l < "$week" || echo 0)
  # The calls it made, as it counted them. A collector that died before writing them costs the
  # rest of the night, rather than a guess.
  used=$(cat "$runner/used" 2> /dev/null || echo "$calls")
  calls=$((calls - used))
  # Changed: new attempts, or incomplete ones read again in place.
  if [ "$( [ -f "$week" ] && md5sum < "$week" || echo none)" != "$before_sum" ]; then
    # Beside the file, then moved over it, so a write that fails leaves the old file whole.
    gzip -9c "$week" > "$out.new"
    mv -f -- "$out.new" "$out"
    changed+=("$name")
  fi
  echo "ci-records.sh: $day, $((after - before)) new attempts, $after in $name"
  rm -f -- "$week"
  [ "$status" = 0 ] || break
done

if [ "$commit" = 1 ] && [ "${#changed[@]}" -gt 0 ]; then
  (
    cd "$records"
    git add -- $(printf '%s\n' "${changed[@]}" | sort -u)
    git commit -q -m "CI records to $day"
    git push -q
  )
fi
# Exit 3 is the collector stopping at the budget or GitHub's limit, which the next night goes on from.
[ "$status" = 3 ] && exit 0
exit "$status"
