# Design Studio worker

The image a Design Studio design runs on: one Fly machine per design, started by Virvi's server. It restores the
design's workspace from Virvi's API, takes its prompt and render jobs, runs Claude Code or Codex with
`dcl-avatar-skills`, checks and renders the pieces in Decentraland's wearable-preview, and reports back. The browser
only ever gets render frames. Once a revision is paid for, a finalize job builds its package (`studio_worker/finalize.py`:
thumbnail, curation checks, the Builder zip, renders, promo clip and `REPORT.md`) from Virvi's copy of the paid files,
with no agent run; the package is the only model file a customer downloads.

- `CONTRACT.md`: how the worker and Virvi's API talk. The source of truth for both sides.
- `studio_worker/`: the worker (`python3 -m studio_worker`) and `studio-preview`, the command the agent looks at its
  work with.
- `allowlist.txt`, `tinyproxy.conf`, `entrypoint.sh` (nftables): all outbound traffic goes through a proxy that allows only
  the agents' APIs, Virvi's API and the preview's hosts. The entrypoint fails closed without `NET_ADMIN`.
- `spike/`: the measurement spike behind `docs/superpowers/specs/2026-10-24-design-studio-spike-findings.md`. Kept as
  the record; nothing imports it.

## Build and test

```bash
# Unit tests: offline, with fake agent CLIs, a fake API and a stub preview page. Needs Google Chrome for the render
# tests, and a dcl-avatar-skills checkout for the checker tests (STUDIO_SKILLS, default ~/-Decentraland/dcl-avatar-skills).
python3 -m pytest -q apps/studio-worker/tests

# The image (Fly runs amd64), and its tools
docker build --platform linux/amd64 -t vlm-studio-worker:dev apps/studio-worker
docker run --rm --platform linux/amd64 --entrypoint /opt/smoke.sh vlm-studio-worker:dev
```

## End-to-end scripts (by hand)

| Script | What it checks | Costs |
|---|---|---|
| `bash e2e/render_real.sh` | the real wearable-preview renders the fixture cap's spin and the wave emote | nothing |
| `bash e2e/network.sh` | the lockdown: no way out but the allowlist, and `studio-preview` works through it | nothing |
| `e2e/real_prompt.py` | real agents build then tweak a hat through the whole job loop (see its docstring) | about $1 per agent |
| `bash e2e/finalize_real.sh` | a finalize job on the fixture cap with real Blender, wearable-preview, ffmpeg and the skills' checks; prints the package and its report | nothing |
| `bash e2e/fly.sh <image>` | the network checks and a real Codex run on a Fly `performance-4x` machine, which it then destroys | about $1 |

```bash
docker run --rm --platform linux/amd64 --cap-add NET_ADMIN --env-file apps/studio-worker/.env \
  -v $PWD/apps/studio-worker/tests:/opt/tests:ro -v $PWD/apps/studio-worker/e2e:/opt/e2e:ro -v /tmp/real:/out \
  vlm-studio-worker:dev python3 /opt/e2e/real_prompt.py --agent claude [--then codex]
```

## Releasing an image

```bash
cd apps/studio-worker
fly deploy --build-only --push --image-label "$(git rev-parse --short HEAD)"
bash e2e/fly.sh "registry.fly.io/vlm-studio-worker:$(git rev-parse --short HEAD)"
```

Virvi's server starts machines from the image label it is configured with, so a new image reaches designs only when
that setting changes.

**A new skills version:** set `SKILLS_SHA` in the `Dockerfile` to the full commit, rebuild, and run the unit tests
and `e2e/real_prompt.py` before releasing. Every result records the `skillsSha` it ran with. The skills come from the
image, never from a design's saved workspace, so existing designs pick up the new version on their next machine
start. **New agent CLI versions** are the `CLAUDE_CODE_VERSION` and `CODEX_VERSION` build args: their output formats
are what `studio_worker/agent.py` parses, so run `e2e/real_prompt.py` for both agents after changing them.

## Not in git

See `.gitignore`:

- `.env`: `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, for local runs. On Fly they are the app's secrets, which the
  owner imports with `fly secrets import -a vlm-studio-worker < apps/studio-worker/.env`.
- `runs/`: the spike's raw runs.
