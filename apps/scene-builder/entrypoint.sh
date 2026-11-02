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
tinyproxy -c /opt/scene-builder/tinyproxy.conf
tinyproxy -c /etc/tinyproxy/api.conf

# nftables matches the socket's user natively (no xt_owner needed). Port 8889 is Virvi's API: runner's alone (root
# only probes it below).
nft -f - <<'NFT'
table inet scenebuild {
  chain output {
    type filter hook output priority 0; policy drop;
    oif "lo" tcp dport 8889 meta skuid "runner" accept
    oif "lo" tcp dport 8889 meta skuid 0 accept
    oif "lo" tcp dport 8889 reject
    oif "lo" accept
    # IPv6 neighbor discovery: kernel packets with no user, without which no IPv6 traffic (DNS included) flows
    icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit } accept
    ct state established,related accept
    meta skuid "tinyproxy" accept
    reject
  }
}
NFT

for port in 8888 8889; do
  for _ in $(seq 50); do
    (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null && break
    sleep 0.1
  done
done

npm_proxy=http://127.0.0.1:8888
api_proxy=http://127.0.0.1:8889

if [ $# -gt 0 ]; then
  export HTTPS_PROXY=$npm_proxy HTTP_PROXY=$npm_proxy https_proxy=$npm_proxy http_proxy=$npm_proxy NO_PROXY=localhost,127.0.0.1
  exec "$@"
fi

# Runs a build.mjs step as `user` with only the named variables (plus `name=value` pairs set here), never in argv:
# the subshell unsets the rest, and setpriv drops every capability and forbids gaining new privileges (no setuid).
as_user() {
  local user=$1 keep=$2
  shift 2
  (
    for v in $(compgen -e); do
      case " $keep " in *" $v "*) ;; *) unset "$v" ;; esac
    done
    export HOME=/home/$user USER=$user LOGNAME=$user PATH=/usr/local/bin:/usr/bin:/bin
    exec setpriv --reuid="$user" --regid="$user" --init-groups --no-new-privs --inh-caps=-all --bounding-set=-all \
      -- /usr/local/bin/node --disable-warning=UNDICI-EHPA /opt/scene-builder/build.mjs "$@"
  )
}

# Kills every `builder` process, including any the build left behind or detached
kill_builder() {
  for _ in $(seq 50); do
    pkill -KILL -u builder || return 0
    sleep 0.1
  done
  ! pgrep -u builder > /dev/null
}

log=/work/log/build.log
mkdir -p /work/log /work/scene
chmod 755 /work /work/log
: > "$log"
chmod 644 "$log"
chown runner:runner /work/scene

runner_vars="BUILD_SOURCE_URL BUILD_RESULT_URL BUILD_FAILED_URL BUILD_TOKEN NODE_USE_ENV_PROXY HTTPS_PROXY https_proxy NO_PROXY"
export NODE_USE_ENV_PROXY=1 HTTPS_PROXY=$api_proxy https_proxy=$api_proxy NO_PROXY=localhost,127.0.0.1

outcome=failed
if as_user runner "$runner_vars" fetch >> "$log" 2>&1; then
  chown -R builder:builder /work/scene
  # The scene's own code from here on: no token, no Virvi proxy. The log is opened here, as root; builder only gets the fd.
  if HTTPS_PROXY=$npm_proxy https_proxy=$npm_proxy HTTP_PROXY=$npm_proxy http_proxy=$npm_proxy \
     npm_config_proxy=$npm_proxy npm_config_https_proxy=$npm_proxy npm_config_update_notifier=false CI=true \
     timeout -s KILL 16m bash -c "$(declare -f as_user); as_user builder 'HTTPS_PROXY https_proxy HTTP_PROXY http_proxy NO_PROXY npm_config_proxy npm_config_https_proxy npm_config_update_notifier CI' build" \
     >> "$log" 2>&1 < /dev/null; then
    outcome=ok
  fi
  if ! kill_builder; then
    echo "[scene-builder] The build left processes that would not stop" >> "$log"
    outcome=failed
  fi
  # Let runner read the output: real files and directories the build owns, nothing reached through a link
  find /work/scene -mindepth 1 -type l -delete
  find /work/scene -user builder \( -type d -exec chmod 755 {} + -o -type f -exec chmod 644 {} + \)
fi

as_user runner "$runner_vars" upload "$outcome"
