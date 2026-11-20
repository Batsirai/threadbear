#!/bin/sh
# Works out how a commit (Mike's release) would merge into main, without
# checking anything out or running anything from it
# (docs/bringing-in-updates.md, section 2). Prints the merged tree, then
# any files that clash and what git said, then what the release changes.
#
# The merge is done in a throwaway bare repo that borrows this repo's
# objects and has no config of its own, with no global, system or
# attributes files: no merge driver, merge.default, diff or textconv
# program from anywhere can run on the release's files while git works it
# out (Codex's review, 9 Nov 2026: this repo's own config can name one).
# Needs git 2.40 or later (merge-tree --write-tree, --attr-source).
#
# Usage: scripts/merge-preview.sh <commit> [<base>, main by default]
set -eu
commit=${1:?usage: scripts/merge-preview.sh <commit> [base]}
base=${2:-refs/heads/main}
top=$(git rev-parse --show-toplevel)
objects=$(cd "$top" && git rev-parse --path-format=absolute --git-path objects)
format=$(git -C "$top" rev-parse --show-object-format 2>/dev/null || echo sha1)
base_id=$(git -C "$top" rev-parse --verify "$base^{commit}")
commit_id=$(git -C "$top" rev-parse --verify "$commit^{commit}")
tmp=$(mktemp -d "${TMPDIR:-/tmp}/tb-merge-preview.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM
# Nothing of anyone's config: not this repo's, the user's or the system's.
bare() {
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_CONFIG_PARAMETERS -u GIT_CONFIG_COUNT -u GIT_TEMPLATE_DIR \
    HOME="$tmp" XDG_CONFIG_HOME="$tmp" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 \
    git "$@"
}
# No template either: init.templateDir or GIT_TEMPLATE_DIR could copy in a
# config and info/attributes naming a driver (Codex's third look).
bare init -q --bare --template= "--object-format=$format" "$tmp/r"
printf '%s\n' "$objects" > "$tmp/r/objects/info/alternates"
clean() {
  bare -C "$tmp/r" -c core.attributesFile=/dev/null -c merge.default=text "$@"
}
empty=$(clean hash-object -t tree /dev/null)
status=0
clean --attr-source="$empty" merge-tree --write-tree --name-only --messages "$base_id" "$commit_id" > "$tmp/out" || status=$?
cat "$tmp/out"
tree=$(head -n 1 "$tmp/out")
echo
if [ "$status" -eq 1 ]; then echo "It clashes in the files above."; elif [ "$status" -ne 0 ]; then echo "git merge-tree failed ($status)."; exit "$status"; else echo "It merges cleanly."; fi
echo
echo "What it changes against main:"
clean --attr-source="$empty" diff --no-ext-diff --no-textconv --stat "$base_id" "$tree"

# A format commit in the release (.git-blame-ignore-revs, "# format-subject:"
# lines; runner/src/format-replay.ts) that main doesn't have clashes with
# every change main made to the files it formatted, though only formatting
# differs. Nothing formats here (that would run the release's toolchain), so
# say so, and show the real clashes: merging the commit before it.
list=$(clean show "$commit_id:.git-blame-ignore-revs" 2>/dev/null || true)
[ -n "$list" ] || exit 0
printf '%s\n' "$list" | sed -n 's/^#[[:space:]]*format-subject:[[:space:]]*//p' | while IFS= read -r subject; do
  [ -n "$subject" ] || continue
  f=$(clean log --no-merges --format='%H%x09%s' "$commit_id" | awk -F '\t' -v s="$subject" '$2 == s { print $1; exit }')
  [ -n "$f" ] || continue
  if clean merge-base --is-ancestor "$f" "$base_id"; then continue; fi
  echo
  echo "The release has a format commit main doesn't: $f ($subject)."
  echo "Clashes in the files it formatted are formatting only: after they say go, merge with"
  echo "scripts/replay-over-format.sh --merge $commit_id (docs/bringing-in-updates.md, section 4),"
  echo "which settles those by itself. The real clashes up to it, merging the commit before it:"
  st=0
  clean --attr-source="$empty" merge-tree --write-tree --name-only "$base_id" "$f^" > "$tmp/before" || st=$?
  if [ "$st" -eq 0 ]; then echo "  none"; else sed -n '2,/^$/p' "$tmp/before" | sed '/^$/d; s/^/  /'; fi
done
