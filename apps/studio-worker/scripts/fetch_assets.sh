#!/usr/bin/env bash
# Fills assets/ with the Decentraland base avatar .blend files the image build copies in (git ignores them: this repo
# is public), and refuses any file whose SHA-256 isn't the pinned one. Run it before `fly deploy --build-only`.
#   bash scripts/fetch_assets.sh            # looks in $STUDIO_ASSETS_DIR, then the owner's backup folders
# The files are also inside every built image at /opt/assets/, if every copy below is gone.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
dest="$here/assets"
mkdir -p "$dest"
sources=(
  "${STUDIO_ASSETS_DIR:-}"
  "$HOME/Documents/Virvi/studio-worker-assets"   # iCloud Drive (Desktop & Documents sync)
  "$HOME/-Decentraland"
)
ok() { [ -f "$1" ] && [ "$(shasum -a 256 "$1" | cut -d' ' -f1)" = "$2" ]; }
fetch() {  # <file name> <sha256>
  ok "$dest/$1" "$2" && return
  for dir in "${sources[@]}"; do
    if [ -n "$dir" ] && ok "$dir/$1" "$2"; then cp "$dir/$1" "$dest/$1"; return; fi
  done
  echo "missing $1 (no copy with SHA-256 $2 in: ${sources[*]})" >&2
  exit 1
}
fetch AvatarShape_A.blend 78a7e87f37602efba99ea0c13d8a16a9d0847907bec295aa47c5fbd48987cdf8
fetch AvatarShape_B.blend a26ed56c062d628f8a839acb6246c9eeb39312318851db1d94022d63ecadc800
echo "assets ready in $dest"
