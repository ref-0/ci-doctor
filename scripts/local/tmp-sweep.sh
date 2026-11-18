#!/usr/bin/env bash
# tmp-sweep.sh: delete top-level /tmp entries nobody has touched for N days.
#
# Many agents on one machine each leave test fixtures, build output and sockets in /tmp, and a
# reboot is rare, so /tmp fills. This removes only what is the user's own and clearly idle.
#
# An entry is kept if:
#   - anything inside it was modified within N days (mtime), or had metadata
#     changed (ctime) outside node_modules — pnpm hardlinks bump ctime across
#     every checkout sharing a file, so ctime there says nothing about use;
#   - any process uses it: cwd, open fd, mapped file, or a bound unix socket
#     (a listening socket shows up as socket:[inode] in fds, so /proc/net/unix
#     is the only place its path appears);
#   - it's a system/runtime dir, or it isn't owned by the current user;
#   - its name matches the test-slot pool's folder (test-slots.ts), whose lock files a waiting run
#     holds without touching them, or a TMP_SWEEP_KEEP pattern, which adds to that, never replaces it.
#
# Best effort, Linux only: it reads /proc once, at the start, so a process that starts using an
# entry after that snapshot can still lose it, and it sees only the processes this user may read.
# Nothing here proves an entry will stay unused. Read a dry run, and agree what it may delete,
# before you enable --delete on a machine.
#
# Needs: Bash 4+ (associative arrays), GNU coreutils and findutils (stat -c, find -newermt,
# du -b, numfmt), /proc.
#
# Where it runs: a systemd user timer (tmp-sweep.service and .timer), every 6 hours, at the lowest
# CPU and IO priority. Install it as ~/.local/bin/tmp-sweep, or point ExecStart at this file.
#
# Usage: tmp-sweep.sh [--delete] [--days N]    (dry run by default; TMP_SWEEP_ROOT overrides /tmp;
#        TMP_SWEEP_KEEP is a space-separated list of name globs never to delete, such as your
#        coordination or control-plane state)
#
# Reference implementation from a production monorepo; adapt to your repo.
set -u

root=${TMP_SWEEP_ROOT:-/tmp}
root=${root%/}
days=2
delete=0
while [ $# -gt 0 ]; do
  case $1 in
    --delete) delete=1 ;;
    --days) days=${2:-}; shift ;;
    *) echo "usage: tmp-sweep.sh [--delete] [--days N]" >&2; exit 2 ;;
  esac
  shift
done
case $days in ''|*[!0-9]*) echo "tmp-sweep: --days must be a whole number" >&2; exit 2 ;; esac
cutoff="$days days ago"
me=$(id -un)
# Split on spaces without expanding the globs: they match entry names below, not files here.
read -r -a keep <<< "${TMP_SWEEP_KEEP:-}"
keep+=('*-test-slots-*')

declare -A inuse
while IFS= read -r p; do
  t=${p#"$root"/}; t=${t%%/*}
  [ -n "$t" ] && inuse[$t]=1
done < <(
  {
    for d in /proc/[0-9]*; do
      readlink "$d/cwd"
      readlink "$d"/fd/*
      awk '{print $6}' "$d/maps"
    done 2>/dev/null
    awk 'NR > 1 {print $8}' /proc/net/unix
  } | awk -v r="$root/" 'index($0, r) == 1' | sort -u
)

shopt -s dotglob nullglob
count=0
bytes=0
failed=0
for e in "$root"/*; do
  name=${e#"$root"/}
  case $name in
    .X11-unix|.ICE-unix|.XIM-unix|.font-unix|.Test-unix|systemd-private-*|snap-private-tmp|tmux-*|ssh-*) continue ;;
  esac
  kept=0
  for pattern in "${keep[@]}"; do
    # shellcheck disable=SC2254
    case $name in $pattern) kept=1 ;; esac
  done
  [ $kept = 1 ] && continue
  [ "$(stat -c %U -- "$e" 2>/dev/null)" = "$me" ] || continue
  [ -n "${inuse[$name]:-}" ] && continue
  if [ -n "$(find "$e" \( -newermt "$cutoff" -o \( -newerct "$cutoff" -not -path '*/node_modules/*' \) \) -print -quit 2>/dev/null)" ]; then
    continue
  fi

  size=$(du -xsb -- "$e" 2>/dev/null | cut -f1)
  size=${size:-0}
  if [ $delete = 0 ]; then
    echo "would delete: $e ($(numfmt --to=iec "$size"))"
  else
    # Some test fixtures leave read-only dirs behind; make them writable and retry.
    rm -rf -- "$e" 2>/dev/null || { chmod -R u+w -- "$e" 2>/dev/null; rm -rf -- "$e" 2>/dev/null; }
    if [ -e "$e" ] || [ -L "$e" ]; then
      echo "failed: $e"
      failed=$((failed + 1))
      continue
    fi
    echo "deleted: $e ($(numfmt --to=iec "$size"))"
  fi
  count=$((count + 1))
  bytes=$((bytes + size))
done

verb=$([ $delete = 1 ] && echo deleted || echo "would delete")
echo "tmp-sweep: $verb $count entries, $(numfmt --to=iec "$bytes") (older than $days days); $failed failed"
