#!/usr/bin/env bash
# The scene-builder's entrypoint, run as root. Locks outbound traffic to two allowlisting proxies, then runs the build
# in three steps as two users (build.mjs):
#   fetch   as `runner`  (holds BUILD_TOKEN; reaches only VIRVI_API_HOST): download and extract the source
#   build   as `builder` (no token, no Virvi access; reaches only the npm registries): npm install, the scene's build
#   upload  as `runner`, once every `builder` process is dead: POST the result or the failure
# Fails closed: if the firewall can't be set (no NET_ADMIN), nothing runs. IPv4 and IPv6 alike.
# With arguments it runs them instead of the build, behind the same firewall (for network checks).
set -euo pipefail

for v in BUILD_SOURCE_URL BUILD_RESULT_URL BUILD_FAILED_URL BUILD_TOKEN VIRVI_API_HOST; do
  if [ -z "${!v:-}" ] && [ $# -eq 0 ]; then echo "[scene-builder] $v is not set" >&2; exit 1; fi
done

api_host=$(printf '%s' "${VIRVI_API_HOST:-}" | sed -E 's#^[a-zA-Z]+://##; s#[:/].*$##')
if [ -n "$api_host" ] && ! [[ $api_host =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "[scene-builder] VIRVI_API_HOST is not a host name" >&2
  exit 1
fi

# One anchored, escaped regex per host
to_filter() { sed -e 's/#.*//' -e 's/[[:space:]]//g' | { grep -v '^$' || true; } | sort -u | sed -e 's/\./\\./g' -e 's/^/^/' -e 's/$/$/'; }
to_filter < /opt/scene-builder/allowlist.txt > /etc/tinyproxy/filter
printf '%s\n' "$api_host" | to_filter > /etc/tinyproxy/filter-api
sed -e 's/^Port .*/Port 8889/' -e 's#^Filter .*#Filter "/etc/tinyproxy/filter-api"#' \
    -e 's#tinyproxy\.log#tinyproxy-api.log#' -e 's#tinyproxy\.pid#tinyproxy-api.pid#' \
    /opt/scene-builder/tinyproxy.conf > /etc/tinyproxy/api.conf

mkdir -p /var/log/tinyproxy /run/tinyproxy
chown tinyproxy:tinyproxy /var/log/tinyproxy /run/tinyproxy
# The proxies are the one uid with a way out: they start with an empty environment, so never hold the token
env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin tinyproxy -c /opt/scene-builder/tinyproxy.conf
env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin tinyproxy -c /etc/tinyproxy/api.conf

# nftables matches the socket's user natively (no xt_owner needed). On loopback only the proxies are reachable:
# 8888 (npm) by anyone, 8889 (Virvi's API) by runner alone (and root's probe below); nothing else, Docker's
# 127.0.0.11 resolver included. Off the box only tinyproxy's traffic leaves.
nft -f - <<'NFT'
table inet scenebuild {
  chain output {
    type filter hook output priority 0; policy drop;
    ct state established,related accept
    oif "lo" ip daddr 127.0.0.1 tcp dport 8888 accept
    oif "lo" ip daddr 127.0.0.1 tcp dport 8889 meta skuid "runner" accept
    oif "lo" ip daddr 127.0.0.1 tcp dport 8889 meta skuid 0 accept
    oif "lo" meta skuid "tinyproxy" accept
    oif "lo" reject
    # IPv6 neighbor discovery: kernel packets with no user, without which no IPv6 traffic (DNS included) flows
    icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit } accept
    meta skuid "tinyproxy" accept
    reject
  }
}
NFT

for port in 8888 8889; do
  up=0
  for _ in $(seq 50); do
    if (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; then up=1; break; fi
    sleep 0.1
  done
  if [ $up -eq 0 ]; then echo "[scene-builder] The proxy on port $port did not start" >&2; exit 1; fi
done

source /opt/scene-builder/steps.sh

# Nothing untrusted runs until builder provably has no way around the firewall
lock_fly
if ! check_no_side_channels; then
  echo "[scene-builder] Refusing to build: builder can reach something the firewall can't see" >&2
  exit 1
fi

if [ $# -gt 0 ]; then
  export HTTPS_PROXY=$npm_proxy HTTP_PROXY=$npm_proxy https_proxy=$npm_proxy http_proxy=$npm_proxy NO_PROXY=localhost,127.0.0.1
  exec "$@"
fi

node_step=(/usr/local/bin/node --disable-warning=UNDICI-EHPA /opt/scene-builder/build.mjs)
log=/work/log/build.log
mkdir -p /work/log /work/scene
chmod 755 /work /work/log
: > "$log"
chmod 644 "$log"
chown runner:runner /work/scene

outcome=failed
if as_runner "${node_step[@]}" fetch >> "$log" 2>&1; then
  chown -R builder:builder /work/scene
  # The scene's own code from here on: no token, no Virvi proxy. The log is opened here, as root; builder only gets the fd.
  if timeout -s KILL 16m bash -c 'source /opt/scene-builder/steps.sh; as_builder "$@"' _ "${node_step[@]}" build \
     >> "$log" 2>&1 < /dev/null; then
    outcome=ok
  fi
  if ! kill_builder; then
    echo "[scene-builder] The build left processes that would not stop" >> "$log"
    outcome=failed
  fi
  freeze_scene /work/scene
fi

as_runner "${node_step[@]}" upload "$outcome"
