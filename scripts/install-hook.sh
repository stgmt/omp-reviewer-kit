#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  printf 'Usage: %s <repository>\n' "$0" >&2
  exit 2
fi

kit_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target=$(CDPATH= cd -- "$1" && pwd)

git_hooks="$target/.githooks"
runner_dir="$target/.omp/review-kit"

mkdir -p "$git_hooks" "$runner_dir"
cp "$kit_root/templates/githooks/pre-commit" "$git_hooks/pre-commit"
cp "$kit_root/scripts/run-review.mjs" "$runner_dir/run-review.mjs"
chmod +x "$git_hooks/pre-commit"
git -C "$target" config core.hooksPath .githooks
printf 'Installed omp-reviewer-kit hook in %s\n' "$target"
