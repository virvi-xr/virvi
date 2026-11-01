#!/usr/bin/env bash
# Runs the network checks and one real prompt pair each for Codex and Grok on a Fly performance-4x machine (Codex's
# also renders the Inspect sphere, the run emote and a clipping fix, printing FRAME thumbnails), then destroys it.
#   bash apps/studio-worker/e2e/fly.sh <image>    e.g. registry.fly.io/vlm-studio-worker:<git sha>
# The app's secrets (ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY) must already be imported by the owner. Spends
# about $3.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
app=vlm-studio-worker
image=${1:?give the image, e.g. registry.fly.io/vlm-studio-worker:<git sha>}
name=e2e-$(date +%s)

files=(--file-local "/opt/e2e/real_prompt.py=$here/e2e/real_prompt.py"
       --file-local "/opt/e2e/network_checks.sh=$here/e2e/network_checks.sh"
       --file-local "/opt/tests/fake_api.py=$here/tests/fake_api.py")
for g in "$here"/tests/fixtures/cap/*.glb; do files+=(--file-local "/fixtures/cap/$(basename "$g")=$g"); done

machine_id() {
  fly machine list -a "$app" --json | python3 -c "
import json, sys; print(next((m['id'] for m in json.load(sys.stdin) if m['name'] == '$name'), ''))"
}
cleanup() {  # destroy takes the machine's id, not its name
  local id
  id=$(machine_id)
  if [ -n "$id" ]; then fly machine destroy --force -a "$app" "$id" >/dev/null; fi
}
trap cleanup EXIT

# The CLI stops waiting for "started" after about a minute, which a fresh host pulling the 1.3 GB image can pass; the
# machine keeps starting, so carry on and follow its logs
fly machine run "$image" -a "$app" --name "$name" --region iad --vm-size performance-4x --restart no --detach \
  "${files[@]}" -- bash -c 'if bash /opt/e2e/network_checks.sh && python3 /opt/e2e/real_prompt.py --agent codex \
    --out /tmp/out --inspect && python3 /opt/e2e/real_prompt.py --agent grok --out /tmp/out-grok; then echo E2E-""PASSED; \
    else echo E2E-""FAILED; fi' \
  || [ -n "$(machine_id)" ] || exit 1

# Follow the logs until the run says how it ended (the quotes keep Fly's echo of the command from matching), or the machine's command exits without saying (a failed
# entrypoint)
fly logs -a "$app" --machine "$(machine_id)" \
  | tee /dev/stderr | grep -m1 -oE 'E2E-(PASSED|FAILED)|Main child exited' > "/tmp/$name.status" || true
status=$(cat "/tmp/$name.status" 2>/dev/null)
cleanup
trap - EXIT
echo "machines left in $app:"
fly machine list -a "$app" --json | python3 -c "import json, sys; print(len(json.load(sys.stdin)))"
echo "${status:-E2E-UNKNOWN}"
[ "$status" = E2E-PASSED ]
