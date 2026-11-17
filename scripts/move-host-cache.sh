#!/bin/bash
# Moves a check host's Threadbear caches to a bigger disk, leaving a link in
# their place, so the next checks and builds go on using them from there.
#
#   scripts/move-host-cache.sh <ssh host> <folder on the host>
#   scripts/move-host-cache.sh tinker-desk /Volumes/TinkerSSD/threadbear
#
# What moves: ~/.cache/threadbear-check (scripts/check-remote.sh's runs and
# desktop/scripts/remote.sh's GPUI builds, cargo and rustup with them) and
# ~/.cache/threadbear-parity (the nightly parity run), to check/ and parity/
# in the folder. The lock files in ~/.cache stay where they are.
#
# Why: on 17 Nov Tinker Desk's 460 GB internal disk was 99% full (4.8 GiB
# free), with 59 GB of it in ~/.cache/threadbear-check, while its 2 TB
# external SSD sat empty. GPUI builds waited half an hour and never started.
# The scripts follow the link: check-remote.sh and remote.sh accept it, and
# say so when the disk it points at isn't mounted.
#
# The first copy runs while the host is in use and can take a while. The last
# pass and the swap happen holding both of the host's locks (perf-lock.pl's
# order: the build lock, then the check lock), so no build, measurement or
# check is running then. The old folder is deleted afterwards, in the
# background on the host. Codex's review (17 Nov) shaped the swap:
# - The check lock keeps its identity. A check already waiting on it
#   (check-remote.sh's lockf, which unlike perf-lock.pl never looks again at
#   the file it opened) holds the old file, so the new folder's lock is a link
#   to ~/.cache/threadbear-check.lock, a hard link to that same file. Otherwise
#   that waiter and the next check would each hold "the" lock and run at once.
# - Checks send their files to the mirror and runs/ outside the host's locks,
#   so the new side starts with neither: a check caught mid-send then fails
#   (its files aren't there) rather than checking an older copy. Run it again.
# - Something can make the folder again (a probe's mkdir -p) between moving
#   it aside and making the link; the link is checked, and made again if so.
#
# Only on a host with no other accounts, or a disk that keeps ownership: on
# one that ignores it (an external disk's default, Tinker Desk's SSD), any
# account there could change the build tools these scripts run.
#
# Checkouts from before this script refuse the link ("isn't a folder of this
# account's own"): rebase them on a main that has it.
#
# To undo: on the host, with nothing running, remove the link and move the
# folder back (or just remove both: they're caches, and rebuild from cold).
set -euo pipefail
host="${1:?usage: move-host-cache.sh <ssh host> <absolute folder on the host>}"
dest="${2:?usage: move-host-cache.sh <ssh host> <absolute folder on the host>}"
case "$host" in -*) echo "Not an ssh host: $host" >&2; exit 2 ;; esac
# A plain absolute path, as it's put into a command run over there.
case "$dest" in /*) ;; *) echo "The folder must be an absolute path on $host." >&2; exit 2 ;; esac
case "$dest" in *[!A-Za-z0-9/._-]*) echo "Use a folder name of letters, digits and / . _ - only." >&2; exit 2 ;; esac

# Everything else runs on the host, as one bash script with the folder as $1.
ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=4 "$host" bash -s -- "$dest" <<'HOST'
set -euo pipefail
dest="$1"
cache="$HOME/.cache"
me="$(id -un)"
if [ "$(uname -s)" = Darwin ]; then
  others="$(dscl . list /Users UniqueID | awk -v me="$me" '$2 >= 500 && $1 != me { print $1 }')"
else
  others="$(getent passwd | awk -F: -v me="$me" '$3 >= 1000 && $3 < 60000 && $1 != me { print $1 }')"
fi
[ -d "$dest" ] || mkdir -p "$dest"
chmod 700 "$dest"
[ -d "$dest" ] && [ -O "$dest" ] || { echo "$dest isn't a folder of this account's own." >&2; exit 1; }
if [ -n "$others" ] && mount | grep -F " on $(df -P "$dest" | awk 'END { print $6 }') (" | grep -q noowners; then
  echo "$dest is on a disk that ignores file ownership, and this host has other accounts ($(echo $others)), who could change the build tools kept there. Turn ownership on for that disk (Get Info, or diskutil enableOwnership) and run this again." >&2
  exit 1
fi
cd "$cache"
for name in threadbear-check threadbear-parity; do
  to="$dest/${name#threadbear-}"
  if [ -L "$name" ]; then echo "~/.cache/$name already links to $(readlink "$name")."; continue; fi
  mkdir -p "$to"
  chmod 700 "$to"
  if [ ! -e "$name" ]; then
    ln -s "$to" "$name"
    echo "~/.cache/$name now links to $to (there was nothing to move)."
    continue
  fi
  # How much there is, and whether it fits, before writing any of it.
  # Files come and go under a running build, which du complains about.
  need_kb="$(du -sk "$name" 2>/dev/null | awk '{print $1}')" || true
  have_kb="$(df -Pk "$to" | awk 'END {print $4}')"
  have_kb=$((have_kb + $(du -sk "$to" 2>/dev/null | awk '{print $1}')))
  [ "$have_kb" -gt $((${need_kb:-0} + 4 * 1048576)) ] || { echo "$to has $((have_kb / 1048576)) GiB free, and ~/.cache/$name is $((${need_kb:-0} / 1048576)) GiB." >&2; exit 1; }
  echo "Copying ~/.cache/$name ($((${need_kb:-0} / 1048576)) GiB) to $to while it's in use..."
  # Files vanish and change under running builds; the last pass catches up.
  rsync -aH --delete "$name/" "$to/" 2>/dev/null || true
  echo "Waiting for the host's build and check locks for the last pass and the swap..."
  old="$name.moved-$$"
  # perl, as macOS has no flock command. Same order as perf-lock.pl takes them.
  perl -MFcntl=:flock -e '
    for my $f (@ARGV[0, 1]) { open(my $l, ">>", $f) or die "$f: $!\n"; flock($l, LOCK_EX) or die "$f: $!\n"; push @l, $l }
    system(@ARGV[2 .. $#ARGV]); exit($? >> 8)' \
    "$cache/threadbear-perf.lock" "$cache/threadbear-check/lock" \
    bash -s -- "$name" "$to" "$old" "$cache" <<'SWAP'
set -eu
name="$1" to="$2" old="$3" cache="$4"
# 23 and 24: files that vanished or couldn't be read as it went. Anything
# else (a full disk) stops before the swap.
rc=0; rsync -aH --delete "$name/" "$to/" || rc=$?
case "$rc" in 0|23|24) ;; *) echo "The last copy failed (rsync exit $rc); nothing was swapped." >&2; exit 1 ;; esac
rm -rf "$to/mirror" "$to/runs"
if [ "$name" = threadbear-check ]; then
  ln -f "$name/lock" "$cache/threadbear-check.lock"
  rm -f "$to/lock"
  ln -s "$cache/threadbear-check.lock" "$to/lock"
fi
mv "$name" "$old"
for try in 1 2 3 4 5; do
  ln -s "$to" "$name" 2>/dev/null || true
  [ -L "$name" ] && [ "$(readlink "$name")" = "$to" ] && exit 0
  # Made again in between: it holds nothing yet but what was just made.
  [ -L "$name/${to##*/}" ] && rm -f "$name/${to##*/}"
  mv "$name" "$old.again-$try" 2>/dev/null || true
done
echo "Couldn't put the link in place; ~/.cache/$old is the old folder." >&2
exit 1
SWAP
  echo "~/.cache/$name now links to $to."
  # Deleting tens of GB of small files takes minutes: not while holding the
  # locks, and not tied to this ssh.
  nohup bash -c 'rm -rf "$@"' - "$cache/$old" "$cache/$old".again-* >/dev/null 2>&1 </dev/null &
done
df -h "$HOME" "$dest" | sed 's/^/  /'
HOST
