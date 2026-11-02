# Scene builder

The image an imported Decentraland scene is built in: one short-lived machine per build, started by Virvi's server
(`SCENE_BUILD_RUNNER=fly`, from the image in `SCENE_BUILD_IMAGE`). It downloads the scene's source from Virvi, runs
`npm install` and the scene's build, and posts back the files a deploy ships. Install scripts and the build are a
stranger's code, so the box is the security boundary: it holds nothing worth stealing but a one-build token, and the
scene's code can't reach that token or anything but the npm registry.

## What the box can reach

All outbound traffic is dropped by nftables except a forward proxy's; `entrypoint.sh` fails closed (nothing runs)
when the firewall can't be set, i.e. without `NET_ADMIN`. There are two proxies, both tinyproxy on loopback:

| Port | Hosts | Who may connect |
|---|---|---|
| 8888 | `allowlist.txt`: `registry.npmjs.org`, `registry.yarnpkg.com` | anyone (the scene's `npm install` and build) |
| 8889 | `VIRVI_API_HOST` only | the `runner` user only (nftables rejects everyone else) |

Both allow `CONNECT` to port 443 only, and start with an empty environment, so they never hold the token. On
loopback nothing but `127.0.0.1:8888`/`8889` is reachable (no Docker `127.0.0.11` resolver), and only the proxies'
own traffic leaves the box: no DNS, no direct connections.

nftables can't see Unix sockets, so before anything untrusted runs, the entrypoint removes Fly's Machines API socket
`/.fly/api` and locks `/.fly` to root. Then, as `builder`, it tries every listening Unix socket in the box (abstract
ones included) and `/.fly`. If any of them answers, it exits 1 without building.

## How a build runs

The box gets exactly `BUILD_SOURCE_URL`, `BUILD_RESULT_URL`, `BUILD_FAILED_URL`, `BUILD_TOKEN` and `VIRVI_API_HOST`.
`entrypoint.sh` (root) runs `build.mjs` in three steps, as two users, each with only the variables it needs (passed
through the environment, never argv) and with every capability dropped and `no_new_privs` set:

1. **fetch**, as `runner`, with the token: `GET BUILD_SOURCE_URL`, extract the zip into `/work/scene` with fflate
   (never `unzip`/`tar`; every entry's path is checked, nothing outside the scene root is written).
2. **build**, as `builder`, with no token and no route to Virvi: `npm install --no-audit --no-fund` (5 minutes), then
   `npx sdk-commands build --production` when the install brought `@dcl/sdk-commands`, else the package's `build`
   script (10 minutes). Each step runs in its own process group, which is killed whole at its limit; the whole step
   also has a 16-minute hard stop. The log file is opened by root; `builder` only gets the descriptor.
3. Root kills every `builder` process left (`kill -KILL -1` as `builder`), deletes symlinks under `/work/scene`, and makes `builder`'s files readable.
4. **upload**, as `runner`, with the token: `deployableFiles` (the SDK's default ignores plus `.dclignore`, regular
   files only, never through a symlink), zip, `POST BUILD_RESULT_URL`. Any failure, or a result Virvi refuses, posts
   `BUILD_FAILED_URL` instead.

The wire contract (with `apps/server`'s build routes):

- `GET BUILD_SOURCE_URL` with `Authorization: Bearer <BUILD_TOKEN>` → the source zip.
- Success: `POST BUILD_RESULT_URL`, `Content-Type: application/zip`, body the deployable files (paths relative to the
  scene root), header `X-Build-Log: <base64 of the last 8 KB of the log>` (Ruling R9: about 11 KB, inside ordinary header
  limits). Exit code 0.
- Failure: `POST BUILD_FAILED_URL`, `Content-Type: text/plain`, body the last 64 KB of the log. Exit code 1.

The log tail has the token and any npm credential line (`//host/:_authToken=…`, `_auth`, `_password`) or
`Authorization:` value redacted. If the result POST fails on the network, the box still posts the failure, so Virvi
should ignore a failure report that arrives after it has taken a result. A `503` to the result POST means Virvi is busy
with other imports and read nothing (`imports_busy`): the box sends it again, up to 8 times, 15 s apart.

`node build.mjs` with no step runs all three in one process in the current directory, for the server's dev-only
`local` runner. It is not isolated at all.

## Build, test and push

```bash
cd apps/scene-builder && npm install && npm test   # node --test: lib.mjs (deployableFiles, the log tail, the extract)

# The image (Fly runs amd64)
docker build --platform linux/amd64 -t virvi-scene-builder:dev apps/scene-builder

# The isolation, checked from inside with the same functions a build uses (steps.sh). Any public HTTPS host stands
# in for Virvi's API. Add --cap-add SYS_PTRACE to also check the proxies' environment.
docker run --rm --cap-add NET_ADMIN -e BUILD_TOKEN=smoke-token-0123456789 -e VIRVI_API_HOST=example.com \
  virvi-scene-builder:dev /opt/scene-builder/smoke.sh
```

The smoke script checks:
- the token is in no environ or cmdline that `builder` can read;
- `builder` reaches the npm registry and nothing else: not 8889, `::1`, other hosts, direct IPs or DNS;
- `runner` reaches only the API host;
- the side-channel guard catches open, abstract and `/.fly/api` sockets, and `lock_fly` closes `/.fly`;
- symlinks are dropped before packaging;
- detached `builder` processes are killed.

On a new Fly setup, also run it once on a real machine. Its `/.fly` is the one that matters.

To release, push the image to the build app's registry and point the server at it:

```bash
label=$(git rev-parse --short HEAD)
fly auth docker
docker build --platform linux/amd64 -t "registry.fly.io/virvi-scene-builds:$label" apps/scene-builder
docker push "registry.fly.io/virvi-scene-builds:$label"
# then on virvi-server: SCENE_BUILD_IMAGE=registry.fly.io/virvi-scene-builds:<label>
```

Builds start from the image `SCENE_BUILD_IMAGE` names, so a new image is used only once that setting changes.

This package is not part of the pnpm workspace (`pnpm-workspace.yaml` excludes it): the image installs its two
dependencies, `fflate` and `ignore`, with `npm ci` from its own lockfile.
