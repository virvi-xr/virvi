import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import { withRawJson } from './http/raw-json.js'
import { isDocsPath, registerDocsSite, sendDocsNotFound } from './http/docs-site.js'
import { registerJwt } from './middleware/auth.js'
import authRoutes from './routes/auth.js'
import walletAuthRoutes from './routes/wallet-auth.js'
import trialRoutes from './routes/trial.js'
import authHandoffRoutes from './routes/auth-handoff.js'
import setupRoutes from './routes/setup.js'
import adRoutes from './routes/ads.js'
import { analyticsClaimSignedRoutes } from './routes/analytics-claims.js'
import analyticsReadRoutes from './routes/analytics-read.js'
import sceneRoutes from './routes/scenes.js'
import sceneRoleRoutes from './routes/scene-roles.js'
import sceneLibraryRoutes from './routes/scene-library.js'
import { runStartupBackfill } from './library/scene-library.js'
import { moveMediaModels } from './library/move-media-models.js'
import eventRoutes from './routes/events.js'
import sceneEventRoutes from './routes/scene-events.js'
import giveawayRoutes from './routes/giveaways.js'
import mediaRoutes from './routes/media.js'
import hookRoutes from './routes/hooks.js'
import assetRoutes from './routes/assets.js'
import catalogRoutes from './routes/catalog.js'
import deployRoutes from './routes/deploy.js'
import backupRoutes from './routes/backup.js'
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
import transparencyRoutes from './routes/transparency.js'
import adSpacesRoutes from './routes/ad-spaces.js'
import advertiserLeadRoutes from './routes/advertiser-leads.js'
import venueRoutes from './routes/venues.js'
import ingestRoutes from './routes/ingest.js'
import wizardRoutes from './routes/wizard.js'
import dclDestinationRoutes from './routes/dcl-destinations.js'
import studioWorkerRoutes from './routes/studio-worker.js'
import studioRoutes from './routes/studio.js'
import notificationRoutes from './routes/notifications.js'
import importBuildRoutes from './routes/import-build.js'
import importRoutes from './routes/imports.js'
import brandingRoutes from './routes/branding.js'
import presetScheduleRoutes from './routes/preset-schedules.js'
import { registerDeletedSceneGuard } from './auth/deleted-scene-guard.js'
import sceneDeleteRoutes from './routes/scene-delete.js'
import showingRoutes from './routes/showings.js'
import errorRoutes from './routes/errors.js'
import adminErrorRoutes from './routes/admin-errors.js'
import { recordServerResponse } from './errors/record.js'
import { errorUserHash } from './errors/user-hash.js'
import { db } from './db/connection.js'
import { sql } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { bearerMatches, register, httpRequestsTotal, httpRequestDurationSeconds } from './metrics.js'

/** The server release, reported by the API docs, /api/health and /api/instance. */
const SERVER_VERSION = '2.0.0'

/**
 * A pairing code in the URL path is a credential (the API's /claim is polled, and every approve link and QR scan
 * loads the web page /pair/<code>): log the route shape, never the code.
 */
export const redactPairingCode = (url: string) =>
  url.replace(/^(\/api\/(?:hyperfy|ar)\/pair\/)[^/?#]+/, '$1:code').replace(/^(\/(?:pair\/(?:headset\/)?|s\/))[^/?#]+/, '$1:code')
    // a Design Studio invite link's token is its credential (LIV-159), the page's and the API's
    .replace(/^(\/(?:api\/studio\/invite-links|studio\/invite)\/)[^/?#]+/, '$1:token')
    // ...and the sign-in page's `next` back to it, raw or encoded (the rest of that value goes with it)
    .replace(/([?&]next=(?:\/|%2F)studio(?:\/|%2F)invite(?:\/|%2F))[^&#]*/i, '$1:token')

/** The response header carrying the request ID (Fastify's genReqId) */
export const REQUEST_ID_HEADER = 'x-request-id'

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
  /** Set false to skip the startup data jobs (scene library backfill, moving models out of media) (tests). */
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
    exposedHeaders: [REQUEST_ID_HEADER], // the web app joins its error reports to the server's by it
  })

  // LIV-66: every response carries its request ID; every 5xx is recorded with it (and the exception behind it)
  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id)
  })
  app.addHook('onError', async (request, _reply, error) => {
    ;(request as { thrownError?: unknown }).thrownError = error
  })
  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode < 500 || request.url.startsWith('/api/errors')) return
    const u = request.user as { id?: string; kind?: string; orgId?: string | null; via?: string } | undefined
    const counted = u?.id && !u.via && (u.kind === 'account' || u.kind === 'trial')
    recordServerResponse({
      status: reply.statusCode,
      method: request.method,
      routeTemplate: request.routeOptions?.url || UNMATCHED_ROUTE,
      requestId: request.id,
      userHash: counted ? errorUserHash(u.id!) : null,
      orgId: counted ? u.orgId ?? null : null,
    }, (request as { thrownError?: unknown }).thrownError)
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

  // Every route, with whether it declares a scene-pass resolver and takes Hyperfy or AR passes (AR from a personal headset only) (the scene-pass guard test walks these).
  const registeredRoutes: Array<{ method: string; url: string; scenePass: boolean; hyperfy: boolean; ar: boolean; arPersonal: boolean; trial: boolean }> = []
  app.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method]
    const sp = (r.config as { scenePass?: { hyperfy?: boolean; ar?: boolean | 'personal' } } | undefined)?.scenePass
    for (const m of methods) if (m !== 'HEAD' && m !== 'OPTIONS') registeredRoutes.push({ method: m, url: r.url, scenePass: !!sp, hyperfy: !!sp?.hyperfy, ar: !!sp?.ar, arPersonal: sp?.ar === 'personal', trial: !!(r.config as { trial?: boolean } | undefined)?.trial })
  })
  app.decorate('registeredRoutes', registeredRoutes)
  // LIV-83: routes naming a deleted scene answer 404 (after authenticate)
  registerDeletedSceneGuard(app)

  // Swagger / OpenAPI docs
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Virvi API',
        description: 'Virvi API',
        version: SERVER_VERSION,
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
  // Auth routes. Credential-guessing routes (login, register, password reset/change, wallet verify) set their own
  // CREDENTIAL_RATE_LIMIT and trial start sets its own: a scope onRoute default would run after @fastify/rate-limit's
  // root hook and never apply (LIV-136).
  await app.register(async (scope) => {
    // /api/auth/platform checks the signed body hash against request.rawBody
    withRawJson(scope)
    await scope.register(authRoutes)
    await scope.register(walletAuthRoutes)
    await scope.register(trialRoutes)
    await scope.register(authHandoffRoutes)
  })
  // Ad serve/events are DCL signed fetches: the signed body hash is checked against request.rawBody
  await app.register(async (scope) => {
    withRawJson(scope)
    await scope.register(adRoutes)
  })
  await app.register(sceneRoutes)
  await app.register(sceneDeleteRoutes)
  await app.register(sceneRoleRoutes)
  await app.register(sceneLibraryRoutes)
  await app.register(presetScheduleRoutes)
  await app.register(showingRoutes)
  if (opts.backfill !== false) {
    // Then move 3D models still in Images & Video to 3D Models (LIV-132): every boot, a no-op once none are left
    runStartupBackfill()
      .catch((err) => app.log.warn({ err }, 'scene library backfill failed'))
      .then(() => moveMediaModels())
      .then((n) => { if (n.moved || n.dropped || n.failed) app.log.info(n, 'moved 3D models from media to the asset library') })
      .catch((err) => app.log.warn({ err }, 'moving 3D models out of media failed'))
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
  await app.register(backupRoutes)
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
  await app.register(transparencyRoutes)
  await app.register(adSpacesRoutes)
  await app.register(advertiserLeadRoutes)
  await app.register(venueRoutes)
  await app.register(ingestRoutes)
  await app.register(wizardRoutes)
  await app.register(dclDestinationRoutes)
  await app.register(studioWorkerRoutes)
  await app.register(studioRoutes)
  await app.register(notificationRoutes)
  await app.register(importBuildRoutes)
  await app.register(importRoutes)
  await app.register(errorRoutes)
  await app.register(adminErrorRoutes)

  // GET /api/instance (mode, version, branding) and the admin branding routes
  await app.register(brandingRoutes, { version: SERVER_VERSION })

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
      version: SERVER_VERSION,
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

    // Only with METRICS_TOKEN, sent as `Authorization: Bearer <token>`: the metrics name routes, traffic and
    // internals, so they are never public. Without a token they are counted but not served.
    const metricsToken = config.metricsToken
    if (metricsToken) {
      app.get('/metrics', async (request, reply) => {
        if (!bearerMatches(request.headers.authorization, metricsToken)) return reply.status(401).send({ error: 'unauthorized' })
        const metrics = await register.metrics()
        return reply.type(register.contentType).send(metrics)
      })
      console.log(`[virvi-server] Prometheus metrics at /metrics (METRICS_TOKEN required)`)
    } else {
      console.warn(`[virvi-server] Metrics are on but not served: set METRICS_TOKEN to scrape /metrics`)
    }
  }

  // ── Serve uploaded media files (local storage) ────────────────────────
  // Independent of the dashboard build: local dev runs the dashboard separately but still needs its uploads served
  const uploadsPath = resolve(process.env.LOCAL_STORAGE_PATH || './uploads')
  if (existsSync(uploadsPath)) {
    await app.register(fastifyStatic, {
      root: uploadsPath,
      prefix: '/uploads/',
      decorateReply: false,
      // Files are served with the type they were stored as; browsers must not guess another (e.g. HTML from an image)
      setHeaders: (res) => { res.setHeader('X-Content-Type-Options', 'nosniff') },
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

  // ── Docs (/docs, plus /llms.txt for agents) ───────────────────────────
  const docsServed = await registerDocsSite(app, config.docsDir, config.webAppUrl)
  console.log(`[virvi-server] Docs ${docsServed ? `served at /docs from ${resolve(config.docsDir)}` : `not built (${resolve(config.docsDir)})`}`)

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
    // /studio/index.txt, which the client router fetches, and /studio/index.html. /studio/checkout/ is its own page.
    const studioPage = (request: { params: unknown }, reply: { sendFile: (f: string) => unknown }) => {
      const id = (request.params as { designId?: string }).designId
      return reply.sendFile(!id || id === 'index.html' ? 'studio/index.html' : id === 'index.txt' ? 'studio/index.txt'
        : id === 'checkout' ? 'studio/checkout/index.html' : 'studio/_/index.html')
    }
    app.get('/studio/:designId', studioPage)
    app.get('/studio/:designId/', studioPage)
    // A design's invite link (/studio/invite/<token>, LIV-159): one exported page for every token, at studio/invite/_/
    app.get('/studio/invite/:token', (_request, reply) => reply.sendFile('studio/invite/_/index.html'))
    app.get('/studio/invite/:token/', (_request, reply) => reply.sendFile('studio/invite/_/index.html'))

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
      if (docsServed && isDocsPath(request.url)) return sendDocsNotFound(reply, config.docsDir)
      return reply.sendFile('index.html')
    })
  } else {
    console.log(`[virvi-server] No dashboard directory at ${dashboardPath} — API-only mode`)
    app.setNotFoundHandler(async (request, reply) => {
      if (docsServed && isDocsPath(request.url)) return sendDocsNotFound(reply, config.docsDir)
      return reply.status(404).send({ error: 'Not found' })
    })
  }

  return app
}
