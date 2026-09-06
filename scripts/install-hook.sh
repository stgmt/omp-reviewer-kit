#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  printf 'Usage: %s <repository>\n' "$0" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  printf 'Error: Node.js is required but was not found on PATH.\n' >&2
  exit 1
fi

kit_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target=$(CDPATH= cd -- "$1" && pwd)

exec node "$kit_root/scripts/setup-hook.mjs" "$target"
