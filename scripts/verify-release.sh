#!/usr/bin/env bash
# Check that a Virvi site runs the code in the public repo (LIV-165). Needs git, docker, curl, node and the GitHub CLI.
#   bash scripts/verify-release.sh                       # virvi.io
#   WEB=https://my.host API=https://my.host bash scripts/verify-release.sh   # a self-hosted install built by its own CI
#
# 1. Asks the server which commit it runs (/api/transparency).
# 2. Checks GitHub's signed build record: the image was built by this repo's CI from that commit.
# 3. Rebuilds the website from that commit in Docker, with the same public build settings, and compares every file's
#    SHA-256 with the manifest the site serves and with the files the site actually serves.
set -euo pipefail

WEB="${WEB:-https://virvi.io}"
API="${API:-https://api.virvi.io}"
REPO="${REPO:-virvi-xr/virvi}"
for tool in git docker curl node gh; do command -v "$tool" >/dev/null || { echo "Needs $tool"; exit 2; }; done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail=0

echo "1. What ${API} says it runs"
curl -fsS "${API}/api/transparency" > "$work/info.json"
field() { node -e "const v=require('$work/info.json')$1; process.stdout.write(v==null?'':String(v))"; }
commit="$(field .commit)"
image="$(field .image)"
if [ -z "$commit" ] || [ "$(field .verified)" != "true" ]; then
  echo "   FAIL: the server wasn't built by public CI (release $(field .release)), so there's nothing to check it against"
  exit 1
fi
echo "   commit ${commit}"

echo "2. GitHub's signed build record for ${image}"
if gh attestation verify "oci://${image}" --repo "$REPO" >/dev/null 2>"$work/attest.err"; then
  echo "   PASS: built by ${REPO}'s CI"
else
  echo "   FAIL: no valid attestation"; sed 's/^/   /' "$work/attest.err"; fail=1
fi

echo "3. Rebuilding the website from that commit"
git clone -q "https://github.com/${REPO}.git" "$work/src"
git -C "$work/src" checkout -q "$commit"
args=()
while IFS= read -r kv; do [ -n "$kv" ] && args+=(--build-arg "$kv"); done < <(node -e "
  const a=require('$work/info.json').buildArgs||{}; for (const [k,v] of Object.entries(a)) console.log(k+'='+v)")
docker build -q --target builder ${args[@]+"${args[@]}"} --build-arg "VIRVI_COMMIT=${commit}" -t "virvi-verify:${commit:0:12}" "$work/src" >/dev/null
cid="$(docker create "virvi-verify:${commit:0:12}")"
docker cp "$cid:/app/apps/web/out/release-manifest.json" "$work/rebuilt.json" >/dev/null
docker rm "$cid" >/dev/null

curl -fsS "${WEB}/release-manifest.json" > "$work/live.json"
cat > "$work/compare.js" <<'EOF'
const [rebuiltPath, livePath, web] = process.argv.slice(2)
const { createHash } = require('node:crypto')
const rebuilt = require(rebuiltPath).files, live = require(livePath).files
const names = [...new Set([...Object.keys(rebuilt), ...Object.keys(live)])].sort()
const differ = names.filter((n) => rebuilt[n] !== live[n])
if (differ.length) {
  console.log(`   FAIL: the site's manifest differs from the rebuild in ${differ.length} file(s):`)
  for (const n of differ.slice(0, 50)) console.log(`     ${n}`)
  process.exit(1)
}
console.log(`   PASS: the site's manifest matches the rebuild (${names.length} files)`)
;(async () => {
  console.log('4. Checking the files the site actually serves')
  const bad = []
  for (const n of names) {
    const res = await fetch(`${web}/${n}`)
    const hash = res.ok ? createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex') : `HTTP ${res.status}`
    if (hash !== rebuilt[n]) bad.push(`${n} (${hash.startsWith('HTTP') ? hash : 'different bytes'})`)
  }
  if (bad.length) { console.log(`   FAIL: ${bad.length} served file(s) differ:`); for (const b of bad.slice(0, 50)) console.log(`     ${b}`); process.exit(1) }
  console.log(`   PASS: every served file matches (${names.length})`)
})()
EOF
node "$work/compare.js" "$work/rebuilt.json" "$work/live.json" "$WEB" || fail=1

[ "$fail" -eq 0 ] && echo "PASS: ${WEB} runs commit ${commit} of github.com/${REPO}" || { echo "FAIL: see above"; exit 1; }
