#!/bin/sh
set -eu

hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$hook_dir/.." && pwd)

# Self-sync (kit repo only): the session-start plugin installer overwrites
# .omp/review-kit/ with the installed plugin copy — the hook must evaluate
# with the in-repo canonical runner, not a possibly-stale installed copy.
# The sync is gated on kit-repo identity (package.json name): in consumer
# repos an arbitrary scripts/run-review.mjs is NOT ours to copy.
if [ -f "$root/package.json" ] \
  && [ -f "$root/scripts/run-review.mjs" ] \
  && ! cmp -s "$root/scripts/run-review.mjs" "$root/.omp/review-kit/run-review.mjs" 2>/dev/null \
  && node -e 'try { process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name === "omp-reviewer-kit" ? 0 : 1); } catch { process.exit(1); }' "$root/package.json" 2>/dev/null; then
  mkdir -p "$root/.omp/review-kit"
  cp "$root/scripts/run-review.mjs" "$root/.omp/review-kit/run-review.mjs" 2>/dev/null || true
fi

exec node "$root/.omp/review-kit/run-review.mjs"
