# Running a real studio worker against a local server

The Docker worker image talks to a server on your machine, with real agents. Everything stays local except the
agents' calls to Anthropic or OpenAI, which spend real money (about $0.15 for one Codex prompt that builds a hat).

1. **A database.** With the dev Postgres running:

   ```bash
   docker exec vlm-dev-postgres-1 psql -U vlm -d postgres -c 'CREATE DATABASE virvi_studio_local'
   cd apps/server && DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/virvi_studio_local pnpm exec drizzle-kit push --force
   ```

2. **The server**, in cloud mode with a file store and no Fly (`STUDIO_MACHINES=external`: you run the worker):

   ```bash
   cd apps/server && VIRVI_MODE=cloud PORT=3010 JWT_SECRET=studio-local-secret STORAGE_PROVIDER=local \
     DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/virvi_studio_local \
     STUDIO_WORKER_IMAGE=vlm-studio-worker:dev STUDIO_S3_URI=file:///tmp/studio-store STUDIO_MACHINES=external \
     PUBLIC_URL=http://host.docker.internal:3010 pnpm exec tsx src/index.ts
   ```

3. **A design and its worker token:**

   ```bash
   cd apps/server && DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/virvi_studio_local JWT_SECRET=studio-local-secret \
     PUBLIC_URL=http://host.docker.internal:3010 VIRVI_MODE=cloud pnpm exec tsx scripts/studio-local-design.ts wearable codex
   ```

   It prints `{designId, workerToken, accessToken}`.

4. **The worker**, built by `apps/studio-worker/e2e/network.sh` (or `docker build -t vlm-studio-worker:dev
   apps/studio-worker`), with the agent keys from `apps/studio-worker/.env`:

   ```bash
   docker run --rm --platform linux/amd64 --cap-add NET_ADMIN --env-file apps/studio-worker/.env \
     -e VIRVI_API_URL=http://host.docker.internal:3010 -e STUDIO_WORKER_TOKEN=<workerToken> \
     -e STUDIO_DESIGN_ID=<designId> -e STUDIO_IDLE_EXIT_SEC=900 vlm-studio-worker:dev
   ```

5. **A prompt**, as the dashboard sends it:

   ```bash
   curl -sS -X POST http://localhost:3010/api/studio/designs/<designId>/prompts \
     -H "authorization: Bearer <accessToken>" -H 'content-type: application/json' \
     -d '{"text": "A rounded cyberpunk cap with a glowing neon visor strip across the front. Make it for both body shapes.", "selectedSlots": ["hat"]}'
   ```

   Then `GET /api/studio/designs/<designId>` shows the reply, the hat's revision and its render URLs (swap
   `host.docker.internal` for `localhost` to open them from your machine). The `virvi_studio` room carries the progress.

## Looking at the page without an agent

`scripts/studio-seed-page.ts` fills the local database and file store with designs to look at the dashboard's
Design Studio page:
- a wearable set: a hat with a spin, two paid revisions (one to download, one to report) and a third to finalize;
  sneakers failing the checker; a conversation ending in a slot proposal, after a stop at the cost limit;
- an emote that plays;
- an empty design.

No agent runs and nothing is spent.

1. Steps 1 and 2 above. For the dashboard on `next dev`, start the server with `PUBLIC_URL=http://localhost:3010`. Add a dummy `STRIPE_SECRET_KEY` to see the payment buttons refuse with
   "Stripe didn’t answer".
2. The seed:

   ```bash
   cd apps/server && DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/virvi_studio_local JWT_SECRET=studio-local-secret \
     STUDIO_S3_URI=file:///tmp/studio-store PUBLIC_URL=http://localhost:3010 VIRVI_MODE=cloud \
     pnpm exec tsx scripts/studio-seed-page.ts
   ```

   It prints `{accessToken, session, designs: {wearable, emote, empty}}`. Each run adds three more designs.
3. The dashboard: `cd apps/web && pnpm dev`. In the browser console on `http://localhost:3000`, sign in with
   `localStorage.setItem('virvi_auth', JSON.stringify(<session>))` and reload, then open **Design Studio**.
