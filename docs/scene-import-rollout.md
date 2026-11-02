# Scene Import rollout

Owner-run steps to turn Scene Import on in production. Nothing here is done by the code or by an implementer: each step
creates something in a Fly, Cloudflare or Railway account. Until step 5 is finished the feature stays off and uploads
answer 503 (`builds_unavailable`).

Env var names and defaults are in the repository root's `.env.example` and the self-hosting docs
(`apps/docs/src/content/docs/self-hosting/environment-variables.md`). The build image is described in
`apps/scene-builder/README.md`.

An uploaded scene's install scripts and build are a stranger's code. That is why the build app gets its own Fly org and
a token that can touch nothing else.

## 1. Fly app for builds

Create the app in its own org, separate from every other Virvi Fly app, so a token for it cannot reach anything else.

```bash
fly orgs create virvi-scene-builds-org          # skip if the org already exists
fly apps create virvi-scene-builds --org virvi-scene-builds-org
fly tokens create deploy --app virvi-scene-builds --name virvi-server
```

The deploy token is scoped to `virvi-scene-builds` only. Keep it; it goes in `SCENE_BUILD_FLY_TOKEN` (step 5). Do not
use an org or personal token.

## 2. Build and push the image

Fly runs amd64, so build for that platform even on Apple silicon.

```bash
label=$(git rev-parse --short HEAD)
fly auth docker
docker build --platform linux/amd64 -t "registry.fly.io/virvi-scene-builds:$label" apps/scene-builder
docker push "registry.fly.io/virvi-scene-builds:$label"
```

The value for `SCENE_BUILD_IMAGE` is `registry.fly.io/virvi-scene-builds:<label>`. A new image is used only once that
setting changes.

## 3. Smoke test on a real Fly machine

The local Docker smoke test cannot see Fly's own `/.fly`, which is the part that matters. Run it once on a real machine
(any new Fly setup, and again after changing the image's entrypoint or firewall):

```bash
fly machine run "registry.fly.io/virvi-scene-builds:$label" /opt/scene-builder/smoke.sh \
  --app virvi-scene-builds --region <region> --rm \
  -e BUILD_TOKEN=smoke-token-0123456789 -e VIRVI_API_HOST=example.com
fly logs --app virvi-scene-builds     # every check must pass; the script exits non-zero otherwise
```

Then, on a machine from the same image, check as the `builder` user that Fly's Machines API socket is out of reach. The
image has no `curl`, so use Node, which it does have:

```bash
fly machine run "registry.fly.io/virvi-scene-builds:$label" sleep 600 --app virvi-scene-builds --region <region>
fly ssh console --app virvi-scene-builds --machine <machine-id>
# inside the machine:
su builder -s /bin/sh -c "node -e \"require('http').get({socketPath:'/.fly/api',path:'/v1/apps'},r=>console.log(r.statusCode)).on('error',e=>console.log(e.code))\""
```

It passes when it prints an error code: `ENOENT` (no socket), `EACCES` (permission denied) or `ECONNREFUSED`. Any
number (an HTTP status such as `200` or `401`) means the socket answered, and it fails. `smoke.sh` above also probes
`/.fly`, so this is the second look, not the only one.

Also confirm that locking `/.fly` does not break the machine: it still starts, `fly machine status <machine-id>` reports
it healthy, and a one-shot machine still exits and is destroyed normally (the smoke run above, with `--rm`, shows this).
Clean up with `fly machine destroy <machine-id> --force`.

Builds stay `SCENE_BUILD_RUNNER=off` until all of this passes. If the check prints a status code, or `/.fly` locking stops
the machine from running, stop here and do not go on.

## 4. Private R2 bucket

Create a bucket with no public access: in the Cloudflare dashboard, R2, create the bucket (for example
`virvi-scene-imports`), leave "Public access" disabled (no `r2.dev` URL, no custom domain), and create an API token with
Object Read and Write on that bucket only.

```bash
# or with wrangler
npx wrangler r2 bucket create virvi-scene-imports
```

`SCENE_IMPORT_S3_URI` has the form `s3://<access-key-id>:<secret-access-key>@<account-id>.r2.cloudflarestorage.com/<bucket>`,
for example `s3://AKIA...:wJal...@0123456789abcdef.r2.cloudflarestorage.com/virvi-scene-imports`. URL-encode any `/`, `+`
or `=` in the secret.

## 5. Server

**Set `SCENE_IMPORT_S3_URI` before, or together with, deploying the Scene Import code.** From that code on, every World
deploy (the wizard and the HUD too, not just imports) keeps its files in that bucket, and every "Download what went
live" reads them from it. Without the bucket each World deploy logs "could not keep deployed files" and downloads fail.

`PUBLIC_URL` must be the server's public `https` address on port 443, reachable from Fly machines: the build box's proxy
allows `CONNECT` to port 443 only, and the host it may reach (`VIRVI_API_HOST`) is taken from `PUBLIC_URL`. Nothing in
front of the API (a Cloudflare bot challenge, a WAF rule) may challenge `/api/imports/build/*`, or every build fails.

Set the variables on the Railway service `virvi-server`, leaving the runner off:

```bash
railway variables --service virvi-server \
  --set "SCENE_IMPORT_S3_URI=s3://<key>:<secret>@<account>.r2.cloudflarestorage.com/virvi-scene-imports" \
  --set "SCENE_BUILD_IMAGE=registry.fly.io/virvi-scene-builds:<label>" \
  --set "SCENE_BUILD_FLY_APP=virvi-scene-builds" \
  --set "SCENE_BUILD_FLY_TOKEN=<token from step 1>" \
  --set "SCENE_BUILD_RUNNER=off"
```

Check the boot log of that deploy for the schema change: `drizzle-kit push` must not print
`drizzle-kit push failed, trying raw SQL fallback...`. If it does, the fallback still creates the `scene_imports` table,
its enum and `dcl_world_destinations.pending_import_id` (look for `[virvi-server] scene_imports ensured`), but not the
changed delete rules on existing tables (`scene_deployments.deployed_by`); fix the push before relying on account
deletion.

Once the deploy is healthy and step 3 has passed, turn builds on:

```bash
railway variables --service virvi-server --set "SCENE_BUILD_RUNNER=fly"
```

The server refuses to start on a `SCENE_BUILD_RUNNER` other than `fly`, `local` or `off`. Never use `local` in production
(it builds on the server with no isolation, and cloud mode refuses it).

## 6. First import

With a test World you own, upload a small scene zip on the Import page and check:

- **Build:** the import goes uploaded, building, built; a build log is shown, and a Fly machine appears and is gone again
  afterwards (`fly machines list --app virvi-scene-builds` shows nothing left running).
- **Deploy:** deploy the built scene to the test World (a sign-mode World signs in the wallet; a granted Virvi-mode World
  deploys by itself) and open the World to see the scene.
- **Download:** download the built scene and check it opens and contains the expected files.

Also upload a scene with a failing build and check the error and log are shown.

## Retention

Ruling R27, decided by the owner. Five minutes after boot, then once a day, the server (`services/import/retention.ts`) deletes:

- `imports/<id>/` (source.zip, built/, build.log) 30 days after the import ended: status `deployed` or `failed` (a
  superseded upload included), by its `updated_at`. The `scene_imports` row stays with `files_deleted_at` set; the Import
  page and `GET /api/imports/:id/log` (410 `files_expired`) say the files were deleted after 30 days.
- `deployed/<hash>` objects that no destination's current live deployment and no deployment from the last 30 days lists in
  its `assetBundle.content`, and that are over an hour old. Older downloads fall back to the Worlds server, and answer
  `files_gone` once it no longer has a file either.
- `imports/<id>/` with no `scene_imports` row and nothing newer than an hour. Deleting an account or a scene already
  deletes its imports' files; this catches a delete that failed or a crash in between.

Nothing needs setting up. The sweep logs `[retention] deleted the files of N imports and M deployed files` when it
deletes anything.

## 7. Rollback

```bash
railway variables --service virvi-server --set "SCENE_BUILD_RUNNER=off"
```

Uploads then answer 503 `builds_unavailable`. Imports already built, deployed or downloaded are unaffected; a build in
flight is not cancelled by this. To go back to an earlier image, set `SCENE_BUILD_IMAGE` to its label.
