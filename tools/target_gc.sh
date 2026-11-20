#!/usr/bin/env sh
# Build-cache hygiene: prune artifacts untouched for DAYS (default 30) from the
# repo-local Cargo target directory. Cargo regenerates transparently what a later
# build needs; sources and release outputs are never touched.
# Usage: tools/target_gc.sh [days]   (CARGO_TARGET_DIR overrides the cache path)
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target=${CARGO_TARGET_DIR:-$root/.target}
days=${1:-30}
[ -d "$target" ] || { echo "no cache at $target"; exit 0; }
echo "cache before: $(du -sh "$target" 2>/dev/null | cut -f1)"
find "$target" -type f -mtime +"$days" -delete
find "$target" -depth -type d -empty -delete
echo "cache after:  $(du -sh "$target" 2>/dev/null | cut -f1)"
