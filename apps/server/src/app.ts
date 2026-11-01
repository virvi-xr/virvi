import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import { withRawJson } from './http/raw-json.js'
import { registerJwt } from './middleware/auth.js'
import authRoutes from './routes/auth.js'
import walletAuthRoutes from './routes/wallet-auth.js'
import authHandoffRoutes from './routes/auth-handoff.js'
import setupRoutes from './routes/setup.js'
import adRoutes from './routes/ads.js'
import { analyticsClaimSignedRoutes } from './routes/analytics-claims.js'
import analyticsReadRoutes from './routes/analytics-read.js'
import sceneRoutes from './routes/scenes.js'
import sceneRoleRoutes from './routes/scene-roles.js'
import sceneLibraryRoutes from './routes/scene-library.js'
import { runStartupBackfill } from './library/scene-library.js'
import eventRoutes from './routes/events.js'
import sceneEventRoutes from './routes/scene-events.js'
import giveawayRoutes from './routes/giveaways.js'
import mediaRoutes from './routes/media.js'
import hookRoutes from './routes/hooks.js'
import assetRoutes from './routes/assets.js'
import catalogRoutes from './routes/catalog.js'
import deployRoutes from './routes/deploy.js'
import commandCenterRoutes from './routes/command-center.js'
import streamingRoutes from './routes/streaming.js'
import billingRoutes from './routes/billing.js'
import companionUploadRoutes from './routes/companion-upload.js'
import organizationRoutes from './routes/organizations.js'
import apiKeyRoutes from './routes/api-keys.js'
import hyperfyWorldRoutes from './routes/hyperfy-worlds.js'
import hyperfyFeedRoutes from './routes/hyperfy-feed.js'
import hyperfyPairingRoutes from './routes/hyperfy-pairing.js'
import arDeviceRoutes from './routes/ar-devices.js'
import arDraftRoutes from './routes/ar-drafts.js'
import arSpaceRoutes from './routes/ar-spaces.js'
import arFeedRoutes from './routes/ar-feed.js'
import arBuilderRoutes from './routes/ar-builder.js'
import roomScanRoutes from './routes/room-scans.js'
import roomSetRoutes from './routes/room-sets.js'
import adminRoutes from './routes/admin.js'
import adminAdsRoutes from './routes/admin-ads.js'
import adminStudioRoutes from './routes/admin-studio.js'
import adSpacesRoutes from './routes/ad-spaces.js'
import advertiserLeadRoutes from './routes/advertiser-leads.js'
import venueRoutes from './routes/venues.js'
import ingestRoutes from './routes/ingest.js'
import wizardRoutes from './routes/wizard.js'
import dclDestinationRoutes from './routes/dcl-destinations.js'
import studioWorkerRoutes from './routes/studio-worker.js'
import studioRoutes from './routes/studio.js'
import { db } from './db/connection.js'
import { sql } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { register, httpRequestsTotal, httpRequestDurationSeconds } from './metrics.js'

/**
 * A pairing code in the URL path is a credential (the API's /claim is polled, and every approve link and QR scan
 * loads the web page /pair/<code>): log the route shape, never the code.
 */
export const redactPairingCode = (url: string) =>
  url.replace(/^(\/api\/(?:hyperfy|ar)\/pair\/)[^/?#]+/, '$1:code').replace(/^(\/(?:pair\/(?:headset\/)?|s\/))[^/?#]+/, '$1:code')

/** The metric label for a request no route matched (404s, the SPA fallback): fixed, so a url never becomes a label. */
export const UNMATCHED_ROUTE = 'unmatched'

// Same fields as Fastify's default req serializer, with the url redacted.
function serializeReq(request: FastifyRequest) {
  return {
    method: request.method,
    url: redactPairingCode(request.url ?? ''),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  }
}

export interface BuildAppOptions {
  rateLimit?: boolean
  /** Set false to skip the one-time scene library backfill at startup (tests). */
  backfill?: boolean
  logger?: boolean
  /** Test hook: capture log output. */
  logStream?: { write(msg: string): void }
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel, serializers: { req: serializeReq }, ...(opts.logStream ? { stream: opts.logStream } : {}) },
    trustProxy: config.trustProxyHops, // request.ip = real client behind the proxy (per-IP ingest limits)
    genReqId: () => randomUUID(),
    bodyLimit: config.maxUploadSize, // default 100MB, set MAX_UPLOAD_MB to override
  })

  // CORS: any origin, never credentials. Every API caller (the dashboard, a Hyperfy HUD in someone's world) sends a bearer
  // token or a secret in the request itself; no route reads a cookie, so no origin can ride on a browser's ambient login.
  await app.register(fastifyCors, {
    origin: true,
    credentials: false,
  })

  // Rate limiting (global): API calls only. The dashboard's own files, uploads and well-known files don't count, or a
  // couple of page loads (every script chunk, icon and thumbnail) would use up a person's whole minute.
  if (opts.rateLimit !== false) {
    await app.register(import('@fastify/rate-limit'), {
      max: config.rateLimitMax,
      timeWindow: '1 minute',
      allowList: (request) => !request.url.startsWith('/api/'),
    })
  }

  // JWT
  await registerJwt(app, config.jwtSecret)

  // Every route, with whether it declares a scene-pass resolver and takes Hyperfy or AR passes (the scene-pass guard test walks these).
  const registeredRoutes: Array<{ method: string; url: string; scenePass: boolean; hyperfy: boolean; ar: boolean }> = []
  app.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method]
    const sp = (r.config as { scenePass?: { hyperfy?: boolean; ar?: boolean } } | undefined)?.scenePass
    for (const m of methods) if (m !== 'HEAD' && m !== 'OPTIONS') registeredRoutes.push({ method: m, url: r.url, scenePass: !!sp, hyperfy: !!sp?.hyperfy, ar: !!sp?.ar })
  })
  app.decorate('registeredRoutes', registeredRoutes)

  // Swagger / OpenAPI docs
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Virvi API',
        description: 'Virvi API',
        version: '2.0.0',
      },
      servers: [{ url: config.publicUrl }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'JWT access token or API key (virvi_...)',
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  })

  await app.register(fastifySwaggerUi, {
    routePrefix: '/api/docs',
  })

  console.log('[virvi-server] API docs available at /api/docs')

  // ── API Routes ───────────────────────────────────────────────────────────
  // Auth routes get stricter rate limits to mitigate brute-force attacks
  await app.register(async (scope) => {
    scope.addHook('onRoute', (routeOptions) => {
      routeOptions.config = {
        ...((routeOptions.config as Record<string, unknown>) || {}),
        rateLimit: { max: 20, timeWindow: '1 minute' },
      }
    })
    // /api/auth/platform checks the signed body hash against request.rawBody
    withRawJson(scope)
    await scope.register(authRoutes)
    await scope.register(walletAuthRoutes)
    await scope.register(authHandoffRoutes)
  })
  // Ad serve/events are DCL signed fetches: the signed body hash is checked against request.rawBody
  await app.register(async (scope) => {
    withRawJson(scope)
    await scope.register(adRoutes)
  })
  await app.register(sceneRoutes)
  await app.register(sceneRoleRoutes)
  await app.register(sceneLibraryRoutes)
  if (opts.backfill !== false) {
    runStartupBackfill().catch((err) => app.log.warn({ err }, 'scene library backfill failed'))
  }
  await app.register(analyticsClaimSignedRoutes)
  await app.register(setupRoutes)
  await app.register(analyticsReadRoutes)
  await app.register(eventRoutes)
  await app.register(sceneEventRoutes)
  await app.register(giveawayRoutes)
  await app.register(mediaRoutes)
  await app.register(hookRoutes)
  await app.register(assetRoutes)
  await app.register(catalogRoutes)
  await app.register(deployRoutes)
  await app.register(commandCenterRoutes)
  await app.register(streamingRoutes)
  // Stripe signs the exact raw body, so billing keeps request.rawBody too
  await app.register(async (scope) => {
    withRawJson(scope)
    await scope.register(billingRoutes)
  })
  await app.register(companionUploadRoutes)
  await app.register(organizationRoutes)
  await app.register(apiKeyRoutes)
  await app.register(hyperfyWorldRoutes)
  await app.register(hyperfyFeedRoutes)
  await app.register(hyperfyPairingRoutes)
  await app.register(arSpaceRoutes)
  await app.register(arFeedRoutes)
  await app.register(arBuilderRoutes)
  await app.register(arDeviceRoutes)
  await app.register(arDraftRoutes)
  await app.register(roomScanRoutes)
  await app.register(roomSetRoutes)
  await app.register(adminRoutes)
  await app.register(adminAdsRoutes)
  await app.register(adminStudioRoutes)
  await app.register(adSpacesRoutes)
  await app.register(advertiserLeadRoutes)
  await app.register(venueRoutes)
  await app.register(ingestRoutes)
  await app.register(wizardRoutes)
  await app.register(dclDestinationRoutes)
  await app.register(studioWorkerRoutes)
  await app.register(studioRoutes)

  // Health check
  app.get('/api/health', async (_request, reply) => {
    let postgresStatus = 'ok'
    try {
      await db.execute(sql`SELECT 1`)
    } catch (err) {
      postgresStatus = `error: ${(err as Error).message}`
    }

    let redisStatus: string
    if (config.useRedisPresence && config.redisUrl) {
      redisStatus = 'configured'
    } else {
      redisStatus = 'not_configured'
    }

    const isHealthy = postgresStatus === 'ok'

    const body = {
      status: isHealthy ? 'ok' : 'degraded',
      mode: config.mode,
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      checks: {
        postgres: postgresStatus,
        redis: redisStatus,
        storage: config.storageProvider,
      },
      uptime: process.uptime(),
    }

    return reply.status(isHealthy ? 200 : 503).send(body)
  })

  // ── Prometheus Metrics ─────────────────────────────────────────────────────
  if (config.metricsEnabled) {
    // Request counting & duration hooks (skip /metrics to avoid recursion)
    app.addHook('onRequest', async (request) => {
      if (request.url === '/metrics') return
      ;(request as any).__metricsStart = process.hrtime.bigint()
    })

    app.addHook('onResponse', async (request, reply) => {
      if (request.url === '/metrics') return
      const start: bigint | undefined = (request as any).__metricsStart
      const route = request.routeOptions?.url || UNMATCHED_ROUTE
      const method = request.method
      const statusCode = String(reply.statusCode)

      httpRequestsTotal.inc({ method, route, status_code: statusCode })

      if (start !== undefined) {
        const durationNs = Number(process.hrtime.bigint() - start)
        httpRequestDurationSeconds.observe({ method, route }, durationNs / 1e9)
      }
    })

    app.get('/metrics', async (_request, reply) => {
      const metrics = await register.metrics()
      return reply.type(register.contentType).send(metrics)
    })

    console.log(`[virvi-server] Prometheus metrics enabled at /metrics`)
  }

  // ── Serve uploaded media files (local storage) ────────────────────────
  // Independent of the dashboard build: local dev runs the dashboard separately but still needs its uploads served
  const uploadsPath = resolve(process.env.LOCAL_STORAGE_PATH || './uploads')
  if (existsSync(uploadsPath)) {
    await app.register(fastifyStatic, {
      root: uploadsPath,
      prefix: '/uploads/',
      decorateReply: false,
    })
  }

  // Android app links: claims virvi.io/s/<code> for the Quest app. Registered before the static handler and SPA
  // fallback so neither answers it. No fingerprints yet means [], so nothing claims links before the app is signed.
  app.get('/.well-known/assetlinks.json', (_request, reply) => {
    const fingerprints = config.androidCertSha256
    return reply.type('application/json').send(fingerprints.length === 0 ? [] : [{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: config.androidAppPackage,
        sha256_cert_fingerprints: fingerprints,
      },
    }])
  })

  // ── Static Dashboard ─────────────────────────────────────────────────────
  const dashboardPath = resolve(config.dashboardDir)
  console.log(`[virvi-server] Dashboard path: ${dashboardPath} (exists: ${existsSync(dashboardPath)})`)
  if (existsSync(dashboardPath)) {
    console.log(`[virvi-server] Serving dashboard from ${dashboardPath}`)
    await app.register(fastifyStatic, {
      root: dashboardPath,
      prefix: '/',
      // The hand-off page URL carries a single-use sign-in code: never leak it via Referer.
      setHeaders: (res, path) => {
        if (path.includes('/auth/handoff')) res.setHeader('Referrer-Policy', 'no-referrer')
      },
    })

    // Companion upload links (/u/<code>): the static export has one page for every code, at u/_/
    app.get('/u/:code', (_request, reply) => reply.sendFile('u/_/index.html'))
    app.get('/u/:code/', (_request, reply) => reply.sendFile('u/_/index.html'))
    // Design Studio pages (/studio/<designId>): one exported page for every design, at studio/_/
    // '/studio/' itself also matches here with an empty id (the designs list), and so does the list's RSC payload,
    // /studio/index.txt, which the client router fetches
    const studioPage = (request: { params: unknown }, reply: { sendFile: (f: string) => unknown }) => {
      const id = (request.params as { designId?: string }).designId
      return reply.sendFile(!id ? 'studio/index.html' : id === 'index.txt' ? 'studio/index.txt' : 'studio/_/index.html')
    }
    app.get('/studio/:designId', studioPage)
    app.get('/studio/:designId/', studioPage)

    // AR space pages (/s/<code>): the static export has one page for every code, at s/_/
    app.get('/s/:code', (_request, reply) => reply.sendFile('s/_/index.html'))
    app.get('/s/:code/', (_request, reply) => reply.sendFile('s/_/index.html'))

    // Headset pairing approval links (/pair/headset/<code>): own page at pair/headset/_/
    app.get('/pair/headset/:code', (_request, reply) => reply.sendFile('pair/headset/_/index.html'))
    app.get('/pair/headset/:code/', (_request, reply) => reply.sendFile('pair/headset/_/index.html'))

    // Hyperfy pairing approval links (/pair/<code>): same single page, at pair/_/ (the API lives under /api/hyperfy/pair)
    app.get('/pair/:code', (_request, reply) => reply.sendFile('pair/_/index.html'))
    app.get('/pair/:code/', (_request, reply) => reply.sendFile('pair/_/index.html'))

    // SPA fallback: serve index.html for unmatched non-API routes.
    // The client-side Next.js router handles routing from there.
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: 'Not found' })
      }
      return reply.sendFile('index.html')
    })
  } else {
    console.log(`[virvi-server] No dashboard directory at ${dashboardPath} — API-only mode`)
    app.setNotFoundHandler(async (_request, reply) => {
      return reply.status(404).send({ error: 'Not found' })
    })
  }

  return app
}
