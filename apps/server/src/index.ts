import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { Server: ColyseusServer } = _require('colyseus') as any
const { WebSocketTransport } = _require('@colyseus/ws-transport') as any
import { config, assertProductionSecrets, roomsDistributed } from './config.js'
import { startHookCrons } from './integrations/platform-hooks.js'
import { defineRooms } from './ws/registry.js'
import { runMigrations } from './db/migrate.js'
import { buildApp } from './app.js'
import { startLifecycleSweep } from './venues/lifecycle.js'
import { startDclRedeploySweep } from './services/dcl/redeploy-sweep.js'
import { startDclMapSweep } from './services/dcl/map-status.js'
import { startHostedWorldSweep, SWEEP_INTERVAL_MS } from './hyperfy/sweep.js'
import { startStudioSweep, STUDIO_SWEEP_MS } from './studio/sweep.js'
import { startBuildSweep, BUILD_SWEEP_MS } from './services/import/build-sweep.js'
import { startRetentionSweep, RETENTION_SWEEP_MS } from './services/import/retention.js'
import { startScenePurgeSweep, PURGE_SWEEP_MS, PURGE_AFTER_DAYS } from './scenes/deleted.js'
import { startDurationBackfill } from './media/durations.js'
import { setOnBuildDone } from './services/import/build-runner.js'
import { deployImport } from './services/import/import-deploy.js'
import { hyperfyHosting } from './services/hyperfy/infrastructure.js'
import { startAnalyticsJobs } from './analytics/jobs.js'
import { initBus } from './realtime/bus.js'

async function main() {
  assertProductionSecrets({ mode: config.mode, nodeEnv: process.env.NODE_ENV, jwtSecret: config.jwtSecret })
  console.log(`[virvi-server] Starting in "${config.mode}" mode`)

  // ── Auto-migrate ─────────────────────────────────────────────────────────
  if (config.databaseUrl) {
    try {
      await runMigrations()
    } catch (err) {
      console.warn('[virvi-server] Migration skipped or failed:', (err as Error).message)
      console.warn('[virvi-server] Server will continue — run db:migrate manually if needed')
    }
  }

  // ── Fastify ──────────────────────────────────────────────────────────────
  const app = await buildApp()

  // ── Start HTTP server ────────────────────────────────────────────────────
  // A finished build of a World Virvi may deploy to goes straight out (Ruling R1)
  setOnBuildDone(deployImport)
  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`[virvi-server] HTTP listening on port ${config.port}`)

  // ── Colyseus WebSocket server ────────────────────────────────────────────
  const httpServer = app.server

  const { LocalPresence } = _require('colyseus') as any
  let presence: any
  let driver: any

  if (roomsDistributed()) {
    const { RedisPresence } = _require('@colyseus/redis-presence') as any
    const { RedisDriver } = _require('@colyseus/redis-driver') as any
    presence = new RedisPresence(config.redisUrl)
    driver = new RedisDriver(config.redisUrl)
    console.log(`[virvi-server] Redis presence enabled`)
  } else {
    presence = new LocalPresence()
    console.log(`[virvi-server] In-memory presence (single instance)`)
  }
  initBus(presence)

  const gameServer = new ColyseusServer({
    transport: new WebSocketTransport({
      server: httpServer,
      pingInterval: 5000,
      pingMaxRetries: 3,
    }),
    presence,
    ...(driver ? { driver } : {}),
  })

  // Register rooms
  defineRooms(gameServer)

  console.log(`[virvi-server] Colyseus WebSocket attached`)

  // ── Platform hook crons (cleanup stale callbacks + keepalive ping) ─────
  startHookCrons()
  console.log(`[virvi-server] Platform hook crons started`)
  startLifecycleSweep(config.lifecycleSweepMs)
  console.log(`[virvi-server] Venue lifecycle sweep every ${config.lifecycleSweepMs}ms`)
  if (config.dclRedeploySweepMs > 0) {
    startDclRedeploySweep(config.dclRedeploySweepMs)
    console.log(`[virvi-server] Decentraland redeploy sweep every ${config.dclRedeploySweepMs}ms`)
  }
  if (config.dclMapSweepMs > 0) {
    startDclMapSweep(config.dclMapSweepMs)
    console.log(`[virvi-server] Decentraland map data sweep every ${config.dclMapSweepMs}ms`)
  }
  if (hyperfyHosting().available) {
    startHostedWorldSweep(SWEEP_INTERVAL_MS)
    console.log(`[virvi-server] Hosted Hyperfy world sweep every ${SWEEP_INTERVAL_MS}ms`)
  }
  if (config.studioEnabled) {
    startStudioSweep(STUDIO_SWEEP_MS)
    console.log(`[virvi-server] Design Studio sweep every ${STUDIO_SWEEP_MS}ms`)
  }
  // Always on: a build started before SCENE_BUILD_RUNNER changed still needs timing out
  startBuildSweep(BUILD_SWEEP_MS)
  console.log(`[virvi-server] Scene build sweep every ${BUILD_SWEEP_MS}ms`)
  // Ruling R27: import files 30 days after the import ended, deployed files no deploy keeps (it skips a missing bucket)
  startRetentionSweep(RETENTION_SWEEP_MS)
  console.log(`[virvi-server] Import file retention sweep 5 min after boot, then every ${RETENTION_SWEEP_MS}ms`)
  // LIV-83: deleted scenes are removed for good after their 30 days
  startScenePurgeSweep()
  console.log(`[virvi-server] Deleted scene purge (after ${PURGE_AFTER_DAYS} days) 10 min after boot, then every ${PURGE_SWEEP_MS}ms`)
  startDurationBackfill()
  console.log('[virvi-server] Video length backfill 2 min after boot')
  startAnalyticsJobs()
  console.log('[virvi-server] Analytics jobs started')

  console.log(`[virvi-server] Ready at ${config.publicUrl}`)
}

main().catch((err) => {
  console.error('[virvi-server] Fatal error:', err)
  process.exit(1)
})
