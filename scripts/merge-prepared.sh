#!/bin/sh
# After the owner says go: merges the release that
# `scripts/merge-preview.sh --prepare <dir>` worked out, and puts in the
# clashing files as they were settled under <dir>/files
# (docs/bringing-in-updates.md, section 4). Run it in the thread's own
# worktree. It changes nothing if a settled file still has conflict
# markers or main has moved on since the preview; it leaves the merge
# unfinished, saying which files, if git clashes somewhere the preview
# didn't.
#
# Usage: scripts/merge-prepared.sh <dir> -m "<merge message>"
set -eu
usage='usage: scripts/merge-prepared.sh <dir> -m "<merge message>"'
[ $# -eq 3 ] && [ "$2" = "-m" ] && [ -n "$3" ] || { echo "$usage" >&2; exit 2; }
msg=$3
[ -f "$1/base" ] && [ -f "$1/commit" ] || { echo "$1 isn't a folder scripts/merge-preview.sh --prepare made." >&2; exit 2; }
dir=$(cd "$1" && pwd -P)
[ -f "$dir/clashes" ] || { echo "$dir has no prepared clashes: merge with git merge as usual (docs/bringing-in-updates.md, section 4)." >&2; exit 2; }
base=$(cat "$dir/base")
commit=$(cat "$dir/commit")
for id in "$base" "$commit"; do
  case "$id" in ""|*[!0-9a-f]*) echo "$dir/base or $dir/commit isn't a commit id: run the preview with --prepare again." >&2; exit 2 ;; esac
done
cd "$(git rev-parse --show-toplevel)"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "The worktree has uncommitted changes: commit or drop them first." >&2; exit 1; }

# Every settled file has no markers left before anything changes.
left=""
while IFS= read -r f; do
  [ -f "$dir/files/$f" ] || continue
  if grep -qE '^(<<<<<<<|>>>>>>>)( |$)' "$dir/files/$f"; then left="$left $f"; fi
done < "$dir/clashes"
[ -z "$left" ] || { echo "Still has conflict markers under $dir/files:$left" >&2; exit 1; }

# The settled files are against the main the preview used.
if main=$(git rev-parse -q --verify refs/heads/main) && ! git merge-base --is-ancestor "$main" "$base"; then
  echo "main has moved on since the preview: run scripts/merge-preview.sh --prepare again and settle only what's new." >&2
  exit 1
fi
head=$(git rev-parse HEAD)
if [ "$head" != "$base" ]; then
  # A thread's branch starts from main as it was: catch it up first.
  if git merge-base --is-ancestor "$head" "$base"; then
    git merge -q --ff-only "$base"
  else
    echo "This branch isn't where the preview had main ($base): run scripts/merge-preview.sh --prepare again and settle what changed." >&2
    exit 1
  fi
fi

st=0
out=$(git merge --no-ff -m "$msg" "$commit" 2>&1) || st=$?
unmerged=$(git diff --name-only --diff-filter=U)
if [ "$st" -ne 0 ] && [ -z "$unmerged" ]; then
  printf '%s\n' "$out" >&2
  echo "git merge failed ($st) with no clashing files: see git status." >&2
  exit 1
fi
printf '%s\n' "$unmerged" | while IFS= read -r f; do
  [ -n "$f" ] || continue
  grep -qxF -- "$f" "$dir/clashes" || continue
  [ -f "$dir/files/$f" ] || continue
  # Never through a link: write only the file git left with the clash.
  [ ! -L "$f" ] || continue
  cp "$dir/files/$f" "$f"
  git add -- "$f"
done
still=$(git diff --name-only --diff-filter=U)
if [ -n "$still" ]; then
  echo "Merged, with clashes the preview didn't settle; settle these, then git commit --no-edit:"
  printf '%s\n' "$still" | sed 's/^/  /'
  exit 1
fi
if [ "$st" -ne 0 ]; then git commit -q --no-edit; fi
# A settled file git merged by itself here (a merge attribute in this
# checkout): say so, as what's in it may differ from what was settled.
while IFS= read -r f; do
  printf '%s\n' "$unmerged" | grep -qxF -- "$f" || echo "Note: git merged $f by itself here; the settled copy wasn't used."
done < "$dir/clashes"
echo "Merged $commit with the settled clashes: $(git rev-parse --short HEAD)."
