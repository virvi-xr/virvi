#!/usr/bin/env bash
# The worker image's entrypoint. Locks outbound traffic to the allowlisting proxy, then runs the given command, or
# the worker. Fails closed: if the firewall can't be set (no NET_ADMIN), nothing runs. IPv4 and IPv6 alike.
set -euo pipefail
# When the machine's entrypoint began (epoch seconds): the worker's boot event counts from here
export STUDIO_BOOT_AT="${STUDIO_BOOT_AT:-$(date +%s.%N)}"

filter=/etc/tinyproxy/filter
{
  sed -e 's/#.*//' -e 's/[[:space:]]//g' /opt/allowlist.txt
  if [ -n "${VIRVI_API_URL:-}" ]; then echo "$VIRVI_API_URL" | sed -E 's#^[a-z]+://##; s#[:/].*$##'; fi
} | grep -v '^$' | sort -u | sed -e 's/\./\\./g' -e 's/^/^/' -e 's/$/$/' > "$filter"

mkdir -p /var/log/tinyproxy /run/tinyproxy
chown tinyproxy:tinyproxy /var/log/tinyproxy /run/tinyproxy
tinyproxy -c /opt/tinyproxy.conf

# nftables, not iptables: Fly's kernel has no xt_owner, but nftables matches the socket's user natively
nft -f - <<'NFT'
table inet studio {
  chain output {
    type filter hook output priority 0; policy drop;
    oif "lo" accept
    # IPv6 neighbor discovery: kernel packets with no user, without which no IPv6 traffic (Fly's DNS included) flows
    icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit } accept
    ct state established,related accept
    meta skuid "tinyproxy" accept
    reject
  }
}
NFT

for _ in $(seq 50); do
  (exec 3<>/dev/tcp/127.0.0.1/8888) 2>/dev/null && break
  sleep 0.1
done

export HTTPS_PROXY=http://127.0.0.1:8888 HTTP_PROXY=http://127.0.0.1:8888 NO_PROXY=localhost,127.0.0.1
export https_proxy=$HTTPS_PROXY http_proxy=$HTTP_PROXY no_proxy=$NO_PROXY

# The key proxy holds the API keys, as its own user; the agents talk to it on loopback with a placeholder key.
# It gets only the variables it needs, through the environment (never argv, which every user can read).
(
  for v in $(compgen -e); do
    case $v in ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|HTTPS_PROXY|PATH|PYTHONPATH) ;; *) unset "$v" ;; esac
  done
  exec runuser -u keyproxy -- python3 -m studio_worker.keyproxy
) &
for port in 8890 8891 8892; do
  for _ in $(seq 50); do
    (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null && break
    sleep 0.1
  done
done
# Nothing after this point holds a key
unset ANTHROPIC_API_KEY OPENAI_API_KEY XAI_API_KEY
if [ $# -gt 0 ]; then exec "$@"; fi
exec python3 -m studio_worker
