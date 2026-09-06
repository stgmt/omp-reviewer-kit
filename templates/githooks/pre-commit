#!/bin/sh
set -eu

hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$hook_dir/.." && pwd)
exec node "$root/.omp/review-kit/run-review.mjs"
