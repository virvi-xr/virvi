/**
 * Starts a real studio worker in Docker for every design with a queued job, so a local server (STUDIO_MACHINES=external)
 * works like the hosted one: the dashboard or the Decentraland studio scene sends a prompt and a worker picks it up.
 * Local development only. See scripts/studio-local.md, "Playing the studio scene locally".
 *
 *   DATABASE_URL=... PUBLIC_URL=http://localhost:3010 VIRVI_MODE=cloud \
 *   STUDIO_LOCAL_WORKER_IMAGE=registry.fly.io/vlm-studio-worker:<tag> STUDIO_LOCAL_WORKER_ENV=<path to .env with agent keys> \
 *   pnpm exec tsx scripts/studio-local-workers.ts
 */
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { eq, sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesigns } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { hashWorkerToken } from '../src/studio/machines.js'

if (!/localhost|127\.0\.0\.1|host\.docker\.internal/.test(config.publicUrl)) {
  throw new Error('studio-local-workers is for a local server only')
}
const IMAGE = process.env.STUDIO_LOCAL_WORKER_IMAGE
const ENV_FILE = process.env.STUDIO_LOCAL_WORKER_ENV
if (!IMAGE || !ENV_FILE) throw new Error('set STUDIO_LOCAL_WORKER_IMAGE and STUDIO_LOCAL_WORKER_ENV')
const API = process.env.STUDIO_LOCAL_WORKER_API ?? `http://host.docker.internal:${process.env.PORT ?? '3010'}`
const name = (designId: string) => `studio-local-${designId}`

function running(): Set<string> {
  const out = execFileSync('docker', ['ps', '--filter', 'name=studio-local-', '--format', '{{.Names}}'], { encoding: 'utf8' })
  return new Set(out.split('\n').filter(Boolean))
}

async function tick(): Promise<void> {
  const rows = await db.execute<{ design_id: string }>(sql`SELECT DISTINCT design_id FROM studio_jobs WHERE status = 'queued'`)
  const live = running()
  for (const { design_id: designId } of rows as unknown as { design_id: string }[]) {
    if (live.has(name(designId))) continue
    const token = randomBytes(32).toString('base64url')
    await db.update(studioDesigns).set({ machineId: 'local', workerTokenHash: hashWorkerToken(token) }).where(eq(studioDesigns.id, designId))
    execFileSync('docker', [
      'run', '-d', '--rm', '--name', name(designId), '--platform', 'linux/amd64', '--cap-add', 'NET_ADMIN',
      '--env-file', ENV_FILE!, '-e', `VIRVI_API_URL=${API}`, '-e', `STUDIO_WORKER_TOKEN=${token}`,
      '-e', `STUDIO_DESIGN_ID=${designId}`, '-e', 'STUDIO_IDLE_EXIT_SEC=600', IMAGE!,
    ], { stdio: 'ignore' })
    console.log(`[studio-local-workers] started a worker for design ${designId}`)
  }
}

console.log(`[studio-local-workers] watching for queued studio jobs (image ${IMAGE})`)
for (;;) {
  try { await tick() } catch (err) { console.error('[studio-local-workers]', (err as Error).message) }
  await new Promise((r) => setTimeout(r, 3000))
}
