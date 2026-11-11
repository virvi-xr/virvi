# Design Studio worker: headless Blender 4.4, Chrome for Decentraland's wearable-preview, the Claude Code, Codex and
# Grok Build CLIs at the versions the spikes measured, dcl-avatar-skills at a pinned commit, ffmpeg for promo clips, and the
# studio_worker package.
# Build: docker build --platform linux/amd64 -t vlm-studio-worker:dev apps/studio-worker
FROM debian:bookworm-slim

ARG BLENDER_VERSION=4.4.3
ARG BLENDER_SHA256=8d3be07d2bc412b502c6bfe3cfe3e22195a4164076867da987ce148d73c27946
# download.blender.org sits behind a bot check; this is one of its listed mirrors, and the checksum pins the file
ARG BLENDER_MIRROR=https://mirrors.ocf.berkeley.edu/blender/release/Blender4.4
ARG SKILLS_REPO=https://github.com/MetaverseUnknower/dcl-avatar-skills.git
ARG SKILLS_SHA=71a16c413e41cf9fe8e6535ff94f6289109aa36c
# The official base avatars from Decentraland's public Blender toolkit, at the commit whose files the studio was built
# and tested on (later commits ship different, zstd-compressed files)
ARG AVATARS_URL=https://raw.githubusercontent.com/decentraland/dcl-blender-toolkit/06d9fd65561d93b73e6df5cc10c06e9d01332afc/assets
ARG AVATAR_A_SHA256=78a7e87f37602efba99ea0c13d8a16a9d0847907bec295aa47c5fbd48987cdf8
ARG AVATAR_B_SHA256=a26ed56c062d628f8a839acb6246c9eeb39312318851db1d94022d63ecadc800

ENV DEBIAN_FRONTEND=noninteractive PIP_BREAK_SYSTEM_PACKAGES=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg xz-utils python3 python3-pip tinyproxy nftables ffmpeg \
      libxi6 libxxf86vm1 libxfixes3 libxrender1 libgl1 libegl1 libxkbcommon0 libsm6 libice6 libx11-6 libxext6 \
    && rm -rf /var/lib/apt/lists/*

# Blender
RUN curl -fsSL -o /tmp/blender.tar.xz "$BLENDER_MIRROR/blender-$BLENDER_VERSION-linux-x64.tar.xz" \
    && echo "$BLENDER_SHA256  /tmp/blender.tar.xz" | sha256sum -c - \
    && mkdir -p /opt/blender && tar -xJf /tmp/blender.tar.xz -C /opt/blender --strip-components=1 \
    && rm /tmp/blender.tar.xz && ln -s /opt/blender/blender /usr/local/bin/blender

# Chrome (the skills' preview drives the installed Chrome channel) and Node 22
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends google-chrome-stable nodejs \
    && rm -rf /var/lib/apt/lists/*

# Python tools: numpy for the checkers, Playwright for the preview, Pillow for its frames. Pinned: an unpinned
# Playwright 1.65.0 broke the build (its driver needs libatomic1); bump them together and rerun the e2e
RUN pip3 install --no-cache-dir numpy==2.4.6 pillow==13.0.0 playwright==1.64.1 anthropic==2.2.0 && playwright install-deps chromium

# Agent CLIs, pinned: their output formats and usage reporting are what agent.py parses
ARG CLAUDE_CODE_VERSION=2.1.310
ARG CODEX_VERSION=0.164.0
RUN npm install -g @anthropic-ai/claude-code@$CLAUDE_CODE_VERSION @openai/codex@$CODEX_VERSION && npm cache clean --force
# Grok Build is one static binary; the checksum pins it
ARG GROK_VERSION=1.0.70
ARG GROK_SHA256=22d281c5964c5444147328096ba2a221f3f0874c6858e27c825656a80f6e58e9
RUN curl -fsSL -o /usr/local/bin/grok "https://x.ai/cli/grok-$GROK_VERSION-linux-x86_64" \
    && echo "$GROK_SHA256  /usr/local/bin/grok" | sha256sum -c - \
    && chmod 755 /usr/local/bin/grok

# The agents run as an ordinary user (Claude Code refuses to skip its permission prompts as root); the worker is root
# Only the design folder is the agent's: the worker's state for it (/work/design-state) is root's alone
RUN useradd -m -u 1000 agent && mkdir -p /work/design && chown agent /work/design
# The key proxy's own user: it alone holds the API keys (studio_worker/keyproxy.py)
RUN useradd -r -M -s /usr/sbin/nologin keyproxy

# Skills, pinned, installed for both agents into the design workspace. The repo is root-owned and read by `agent`.
RUN git clone "$SKILLS_REPO" /opt/skills && git -C /opt/skills checkout --quiet "$SKILLS_SHA" \
    && git config --system --add safe.directory /opt/skills \
    && bash /opt/skills/install.sh claude codex --project /work/design
# Decentraland's avatar animations, for the clipping check in finalize jobs (fetched at build: the machine can't reach GitHub)
RUN python3 /opt/skills/skills/curating-dcl-wearables/scripts/fetch_dcl_animations.py /opt/dcl-animations \
    && chmod -R a+rX /opt/dcl-animations

# The official base avatars (AvatarShape_A is BaseFemale, B is BaseMale), checked against their SHA-256
RUN mkdir -p /opt/assets \
    && curl -fsSL -o /opt/assets/AvatarShape_A.blend "$AVATARS_URL/AvatarShape_A.blend" \
    && curl -fsSL -o /opt/assets/AvatarShape_B.blend "$AVATARS_URL/AvatarShape_B.blend" \
    && printf '%s  %s\n' "$AVATAR_A_SHA256" /opt/assets/AvatarShape_A.blend "$AVATAR_B_SHA256" /opt/assets/AvatarShape_B.blend \
       | sha256sum -c - \
    && chmod -R a+rX /opt/assets

COPY studio_worker /opt/studio_worker
# The scene renderer's page, and the pinned Babylon.js it loads (checked against its SHA-256 at build)
COPY scene_page /opt/scene_page
COPY scripts/fetch_babylon.sh /opt/scripts/fetch_babylon.sh
RUN bash /opt/scripts/fetch_babylon.sh
ENV PYTHONPATH=/opt
RUN printf '#!/bin/sh\nexec python3 -m studio_worker.render "$@"\n' > /usr/local/bin/studio-preview \
    && chmod 755 /usr/local/bin/studio-preview
COPY smoke.sh entrypoint.sh tinyproxy.conf allowlist.txt /opt/
WORKDIR /work/design
ENTRYPOINT ["/opt/entrypoint.sh"]
