# Scene builder: builds one imported Decentraland scene in a box that reaches only the npm registries and Virvi's API.
# One container per build, started by Virvi's server with the five BUILD_*/VIRVI_API_HOST variables and NET_ADMIN.
# Build: docker build --platform linux/amd64 -t virvi-scene-builder:dev apps/scene-builder
FROM node:22.23.3-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates nftables tinyproxy procps \
    && rm -rf /var/lib/apt/lists/*

# runner: the trusted steps, which hold the token. builder: the scene's own install and build, which never do.
RUN useradd -m -u 1001 -s /usr/sbin/nologin runner && useradd -m -u 1002 -s /usr/sbin/nologin builder \
    && mkdir -p /work && chmod 755 /work
# Nothing setuid or setgid: a build that found a way into one would get no further than its own user
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + || true

COPY package.json package-lock.json /opt/scene-builder/
RUN cd /opt/scene-builder && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY lib.mjs build.mjs entrypoint.sh tinyproxy.conf allowlist.txt /opt/scene-builder/
RUN chmod -R a+rX,go-w /opt/scene-builder && chmod 755 /opt/scene-builder/entrypoint.sh
WORKDIR /work
ENTRYPOINT ["/opt/scene-builder/entrypoint.sh"]
