#!/usr/bin/env bash
# Downloads the Babylon.js files the scene renderer's page loads into scene_page/vendor/, and refuses any file whose
# SHA-256 isn't the pinned one. The Dockerfile runs it; run it once locally before the scene render tests.
#   bash scripts/fetch_babylon.sh
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
vendor="$here/scene_page/vendor"
mkdir -p "$vendor"
fetch() {  # <npm path> <sha256>
  local name file
  name=$(basename "$1")
  file="$vendor/$name"
  if [ ! -f "$file" ] || ! echo "$2  $file" | sha256sum -c - >/dev/null 2>&1; then
    curl -fsSL -o "$file.part" "https://cdn.jsdelivr.net/npm/$1"
    echo "$2  $file.part" | sha256sum -c - >/dev/null || { rm -f "$file.part"; echo "checksum mismatch: $1" >&2; exit 1; }
    mv "$file.part" "$file"
  fi
}
# Babylon 7.54.3 (2025-03-26), the last 7.x release
fetch babylonjs@7.54.3/babylon.js 420088fc4c31c22591703ce207c7736f15419faa556b0678d28f71dbf7ea523a
fetch babylonjs-loaders@7.54.3/babylonjs.loaders.min.js 02a6782cf71693218165ae87b114697a74b9cb081c8123e3fcc310e159598d6c
echo "babylon ready in $vendor"
