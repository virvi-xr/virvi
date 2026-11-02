#!/usr/bin/env bash
# Checks the box's isolation from the inside, with the same functions a build uses (steps.sh). Run it through the
# entrypoint, so the firewall and the side-channel guard are up first:
#   docker run --rm --cap-add NET_ADMIN -e BUILD_TOKEN=smoke-token-0123456789 -e VIRVI_API_HOST=example.com \
#     virvi-scene-builder:dev /opt/scene-builder/smoke.sh
# VIRVI_API_HOST stands in for Virvi's API (any public HTTPS host). One line per check; exits non-zero if any fails.
set -u
source /opt/scene-builder/steps.sh
fail=0
check() { # name, command (succeeds when the check passes)
  if out=$(bash -c "source /opt/scene-builder/steps.sh; $2" 2>&1); then echo "OK   $1${out:+: $(echo "$out" | tail -1)}"
  else echo "FAIL $1: $(echo "$out" | tail -1)"; fail=1; fi
}
[ -n "${BUILD_TOKEN:-}" ] && [ -n "${VIRVI_API_HOST:-}" ] || { echo "FAIL set BUILD_TOKEN and VIRVI_API_HOST"; exit 1; }
export BUILD_TOKEN VIRVI_API_HOST

# fetch through a proxy (or direct with none); prints `HTTP <status>` or `BLOCKED <why>`
probe='fetch(process.argv[1], { signal: AbortSignal.timeout(8000) }).then((r) => console.log("HTTP", r.status), (e) => console.log("BLOCKED", e.cause?.code || e.cause?.message || e.message))'
via() { echo "env NODE_USE_ENV_PROXY=${2:+1} HTTPS_PROXY=$2 https_proxy=$2 node --disable-warning=UNDICI-EHPA -e '$probe' $3 | grep -q '^$1'"; }

check tools "tinyproxy -v && nft -v && setpriv --version && node --version"
check firewall "nft list table inet scenebuild > /dev/null"

# The token
check "builder env has no BUILD_*" "as_builder env | { ! grep -q '^BUILD_'; }"
check "token in no builder-readable environ or cmdline" "as_builder node -e '
  const fs = require(\"fs\"), hits = []
  for (const p of fs.readdirSync(\"/proc\").filter((d) => /^\d+\$/.test(d)))
    for (const f of [\"environ\", \"cmdline\"]) { try { if (fs.readFileSync(\"/proc/\" + p + \"/\" + f, \"utf8\").includes(process.argv[1] + process.argv[2])) hits.push(p + \"/\" + f) } catch {} }
  if (hits.length) { console.log(hits.join(\" \")); process.exit(1) }' \"\${BUILD_TOKEN:0:8}\" \"\${BUILD_TOKEN:8}\""
# Reading another uid's environ needs CAP_SYS_PTRACE, which Docker withholds; add it to run this one
if tr '\0' '\n' 2> /dev/null < /proc/$(pgrep -u tinyproxy | head -1)/environ > /dev/null; then
  check "proxies hold no token" "for p in \$(pgrep -u tinyproxy); do tr '\\0' '\\n' < /proc/\$p/environ | grep -q BUILD_TOKEN && exit 1; done; true"
else
  echo "SKIP proxies hold no token (needs --cap-add SYS_PTRACE)"
fi

# builder's network
check "builder: npm registry via 8888" "as_builder $(via HTTP http://127.0.0.1:8888 https://registry.npmjs.org/fflate)"
check "builder: other host via 8888 denied" "as_builder $(via BLOCKED http://127.0.0.1:8888 https://www.google.com/)"
check "builder: Virvi host via 8888 denied" "as_builder $(via BLOCKED http://127.0.0.1:8888 https://$VIRVI_API_HOST/)"
check "builder: 8889 refused" "as_builder $(via BLOCKED http://127.0.0.1:8889 https://$VIRVI_API_HOST/)"
check "builder: ::1 refused" "as_builder $(via BLOCKED 'http://[::1]:8888' https://registry.npmjs.org/fflate)"
check "builder: direct to an IP refused" "as_builder $(via BLOCKED '' https://1.1.1.1/)"
check "builder: DNS fails" "as_builder node -e 'require(\"dns\").promises.resolve4(\"registry.npmjs.org\").then(() => process.exit(1), () => {})'"
check "builder: DNS to 127.0.0.11 fails" "as_builder node -e '
  const r = new (require(\"dns\").promises.Resolver)({ timeout: 2000, tries: 1 }); r.setServers([\"127.0.0.11\"])
  r.resolve4(\"registry.npmjs.org\").then(() => process.exit(1), () => {})'"

# runner's network
check "runner: Virvi host via 8889" "as_runner $(via HTTP http://127.0.0.1:8889 https://$VIRVI_API_HOST/)"
check "runner: npm registry via 8889 denied" "as_runner $(via BLOCKED http://127.0.0.1:8889 https://registry.npmjs.org/fflate)"
check "runner: direct refused" "as_runner $(via BLOCKED '' https://1.1.1.1/)"

# Unix sockets nftables can't see: the guard must catch an open one, and lock_fly must close Fly's
# A root-owned listening Unix socket anyone may connect to; `@name` is an abstract one
serve() {
  node -e 'const p = process.argv[1], path = p.startsWith("@") ? "\0" + p.slice(1) : p
    require("net").createServer().listen(path, () => { if (!p.startsWith("@")) require("fs").chmodSync(p, 0o777) })' "$1" > /dev/null 2>&1 &
  echo $!
}
check "guard passes on a clean box" "check_no_side_channels"
pid=$(serve /tmp/smoke.sock); sleep 0.5
check "guard catches an open Unix socket" "! check_no_side_channels"
kill "$pid"; rm -f /tmp/smoke.sock
pid=$(serve @smoke-abstract); sleep 0.5
check "guard catches an abstract socket" "! check_no_side_channels"
kill "$pid"
mkdir -p /.fly && echo secret > /.fly/oidc-token && chmod 644 /.fly/oidc-token && chmod 755 /.fly
pid=$(serve /.fly/api); sleep 0.5
check "guard catches /.fly/api" "! check_no_side_channels"
lock_fly
check "lock_fly removes /.fly/api and locks /.fly" "test ! -e /.fly/api && ! as_builder cat /.fly/oidc-token 2> /dev/null && check_no_side_channels"
kill "$pid"; rm -rf /.fly

# The output tree: links dropped, unreadable files opened up, nothing outside reached
rm -rf /work/smoke && mkdir -p /work/smoke && chown builder:builder /work/smoke
as_builder bash -c 'cd /work/smoke && mkdir bin models && echo "{\"main\":\"bin/index.js\"}" > scene.json && echo ok > bin/index.js \
  && ln -s /proc/self/environ models/env.glb && ln -s /proc/self linkdir && echo glb > models/real.glb && chmod 000 models/real.glb'
freeze_scene /work/smoke
check "symlinks gone after freeze" "test -z \"\$(find /work/smoke -type l)\""
check "runner packages only real files" "as_runner node --disable-warning=UNDICI-EHPA --input-type=module -e '
  import { deployableFiles } from \"/opt/scene-builder/lib.mjs\"
  const files = deployableFiles(\"/work/smoke\", null).join(\",\")
  if (files !== \"bin/index.js,models/real.glb,scene.json\") { console.log(files); process.exit(1) }'"
rm -rf /work/smoke

# Leftover processes
as_builder setsid sleep 300 > /dev/null 2>&1 < /dev/null &
sleep 0.5
check "kill_builder kills detached builder processes" "pgrep -u builder > /dev/null && kill_builder && ! pgrep -u builder > /dev/null"

exit $fail
