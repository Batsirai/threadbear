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
# check is running then. A check whose copy was being sent to the host in
# those seconds fails once ("The copy for run ... isn't on"); run it again.
# The old folder is deleted afterwards, in the background on the host.
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
[ -d "$dest" ] || mkdir -p "$dest"
chmod 700 "$dest"
[ -d "$dest" ] && [ -O "$dest" ] || { echo "$dest isn't a folder of this account's own." >&2; exit 1; }
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
  [ "$have_kb" -gt $((need_kb + 4 * 1048576)) ] || { echo "$to has $((have_kb / 1048576)) GiB free, and ~/.cache/$name is $((need_kb / 1048576)) GiB." >&2; exit 1; }
  echo "Copying ~/.cache/$name ($((need_kb / 1048576)) GiB) to $to while it's in use..."
  # A file deleted or changed mid-copy (24) is fine: the last pass catches it.
  rsync -aH "$name/" "$to/" || [ $? = 24 ]
  echo "Waiting for the host's build and check locks for the last pass and the swap..."
  old="$name.moved-$$"
  # perl, as macOS has no flock command. Same order as perf-lock.pl takes them.
  perl -MFcntl=:flock -e '
    for my $f (@ARGV[0, 1]) { open(my $l, ">>", $f) or die "$f: $!\n"; flock($l, LOCK_EX) or die "$f: $!\n"; push @l, $l }
    system(@ARGV[2 .. $#ARGV]); exit($? >> 8)' \
    "$cache/threadbear-perf.lock" "$cache/threadbear-check/lock" \
    bash -c 'set -e; rsync -aH --delete "$1/" "$2/" || [ $? = 24 ]; mv "$1" "$3"; ln -s "$2" "$1"' - "$name" "$to" "$old"
  echo "~/.cache/$name now links to $to."
  # Deleting tens of GB of small files takes minutes: not while holding the
  # locks, and not tied to this ssh.
  nohup rm -rf "$cache/$old" >/dev/null 2>&1 </dev/null &
done
df -h "$HOME" "$dest" | sed 's/^/  /'
HOST
