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

Both allow `CONNECT` to port 443 only. Nothing else, DNS included, leaves the box.

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
3. Root kills every `builder` process left, deletes symlinks under `/work/scene`, and makes `builder`'s files readable.
4. **upload**, as `runner`, with the token: `deployableFiles` (the SDK's default ignores plus `.dclignore`, regular
   files only, never through a symlink), zip, `POST BUILD_RESULT_URL`. Any failure, or a result Virvi refuses, posts
   `BUILD_FAILED_URL` instead.

The wire contract (with `apps/server`'s build routes):

- `GET BUILD_SOURCE_URL` with `Authorization: Bearer <BUILD_TOKEN>` → the source zip.
- Success: `POST BUILD_RESULT_URL`, `Content-Type: application/zip`, body the deployable files (paths relative to the
  scene root), header `X-Build-Log: <base64 of the last 64 KB of the log>`. Exit code 0.
- Failure: `POST BUILD_FAILED_URL`, `Content-Type: text/plain`, body the last 64 KB of the log. Exit code 1.

The log tail has the token and any npm credential line (`//host/:_authToken=…`, `_auth`, `_password`) or
`Authorization:` value redacted. Note that `X-Build-Log` can be about 87 KB, past Node's default 16 KB header limit:
the receiving server must allow it.

`node build.mjs` with no step runs all three in one process in the current directory, for the server's dev-only
`local` runner. It is not isolated at all.

## Build, test and push

```bash
cd apps/scene-builder && npm install && npm test   # node --test: lib.mjs (deployableFiles, the log tail, the extract)

# The image (Fly runs amd64)
docker build --platform linux/amd64 -t virvi-scene-builder:dev apps/scene-builder
```

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
