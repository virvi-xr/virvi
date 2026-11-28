import { createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { and, asc, desc, eq, gte, isNotNull, lte, lt, sql } from 'drizzle-orm'
import { fetch as undiciFetch } from 'undici'
import { db } from '../db/connection.js'
import { events, scenes, webhookDeliveries, webhooks } from '../db/schema.js'
import { config } from '../config.js'
import { assertPublicHttpUrl } from '../net/public-url.js'
import { guardedAgent } from '../net/public-agent.js'
import { withLock } from '../errors/jobs.js'

/**
 * Webhooks (LIV-39): an account registers an https endpoint and the events it wants; Virvi POSTs each event as JSON,
 * signed, and retries a failed delivery with backoff. Delivery runs in the background and never fails the change
 * that caused it. Targets must be public addresses (checked at registration and again at every send).
 */
export const WEBHOOK_EVENTS = ['deployment.finished', 'event.started', 'webhook.test'] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]
/** The events a webhook can subscribe to (the test ping is sent on request, to one webhook). */
export const SUBSCRIBABLE: WebhookEvent[] = ['deployment.finished', 'event.started']
export const MAX_WEBHOOKS = 10
export const DELIVERY_DAYS = 30
/** After a failed try, the next one: 1 min, 5 min, 30 min, 2 h, 6 h, 12 h; then it stays failed. */
export const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000, 12 * 3600_000]
const TIMEOUT_MS = 10_000
/** One connection pool for every delivery, refusing private addresses at connect time too. */
const agent = guardedAgent(undefined, { allowPrivate: () => config.allowPrivateCallbackUrls })

/**
 * A webhook's signing secret: HMAC of its id and salt under a key derived from JWT_SECRET, so nothing secret is stored.
 * Changing JWT_SECRET (which also signs everyone out) changes every webhook's secret.
 */
export function webhookSecret(id: string, salt: string): string {
  const key = Buffer.from(hkdfSync('sha256', config.jwtSecret, 'virvi', 'webhook-signing-v1', 32))
  return `whsec_${createHmac('sha256', key).update(`${id}:${salt}`).digest('hex')}`
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, the Virvi-Signature header. */
export function signature(secret: string, body: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000)
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
}

export async function checkWebhookUrl(url: unknown): Promise<string> {
  if (typeof url !== 'string' || url.length > 500) throw new WebhookError(400, 'bad_url', 'Give the endpoint URL, up to 500 characters.')
  let u: URL
  try { u = new URL(url) } catch { throw new WebhookError(400, 'bad_url', "That isn't a URL.") }
  if (u.protocol !== 'https:' && !config.allowPrivateCallbackUrls) throw new WebhookError(400, 'bad_url', 'Webhook URLs must start with https://.')
  try {
    await assertPublicHttpUrl(url, { allowPrivate: config.allowPrivateCallbackUrls })
  } catch {
    throw new WebhookError(400, 'bad_url', 'That address is not a public website, so Virvi will not send to it.')
  }
  return url
}

export class WebhookError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

/** Queues `event` for each of the user's webhooks that want it, then tries them at once. Never throws. */
export async function emitWebhook(userId: string | null | undefined, event: WebhookEvent, data: Record<string, unknown>, dedupeKey?: string): Promise<void> {
  if (!userId) return
  try {
    const hooks = await db.select({ id: webhooks.id }).from(webhooks)
      .where(and(eq(webhooks.userId, userId), sql`${event} = ANY(${webhooks.events})`))
    if (!hooks.length) return
    const now = new Date()
    const rows = await db.insert(webhookDeliveries).values(hooks.map((h) => ({
      webhookId: h.id, event, dedupeKey: dedupeKey ?? null, nextAttemptAt: now,
      payload: { type: event, createdAt: now.toISOString(), data },
    }))).onConflictDoNothing().returning({ id: webhookDeliveries.id })
    void Promise.allSettled(rows.map((r) => deliver(r.id)))
  } catch (err) {
    console.error('[webhooks] emit failed:', err instanceof Error ? err.message : err)
  }
}

/** One try of one delivery: sends it if it's still pending, then records the outcome and schedules any retry. */
export async function deliver(deliveryId: string, now = new Date()): Promise<void> {
  const [d] = await db.select({ d: webhookDeliveries, h: webhooks }).from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.status, 'pending')))
  if (!d) return
  // Claim this try: a concurrent sweep that read the same row loses
  const [claimed] = await db.update(webhookDeliveries).set({ attempts: d.d.attempts + 1, nextAttemptAt: null })
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.attempts, d.d.attempts), eq(webhookDeliveries.status, 'pending')))
    .returning({ id: webhookDeliveries.id })
  if (!claimed) return
  const body = JSON.stringify({ id: d.d.id, ...d.d.payload })
  let status: number | null = null
  let error: string | null = null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    await assertPublicHttpUrl(d.h.url, { allowPrivate: config.allowPrivateCallbackUrls })
    const res = await undiciFetch(d.h.url, {
      method: 'POST', body, redirect: 'manual', signal: controller.signal,
      dispatcher: agent,
      headers: {
        'content-type': 'application/json', 'user-agent': 'Virvi-Webhooks/1',
        'virvi-event': d.d.event, 'virvi-delivery': d.d.id, 'virvi-signature': signature(webhookSecret(d.h.id, d.h.salt), body, now),
      },
    })
    status = res.status
    await res.body?.cancel().catch(() => {})
    if (!res.ok) error = `HTTP ${res.status}`
  } catch (err) {
    error = err instanceof Error ? (err.name === 'AbortError' ? 'Timed out after 10 s' : err.message).slice(0, 200) : 'Failed'
  } finally {
    clearTimeout(timer)
  }
  const tries = d.d.attempts + 1
  if (!error) {
    await db.update(webhookDeliveries).set({ status: 'delivered', responseStatus: status, lastError: null, deliveredAt: new Date() }).where(eq(webhookDeliveries.id, deliveryId))
  } else {
    const wait = RETRY_MS[tries - 1]
    await db.update(webhookDeliveries).set({
      status: wait === undefined ? 'failed' : 'pending', responseStatus: status, lastError: error,
      nextAttemptAt: wait === undefined ? null : new Date(now.getTime() + wait),
    }).where(eq(webhookDeliveries.id, deliveryId))
  }
}

/** Retries whatever is due, oldest first (a few at a time), and clears deliveries past 30 days. */
export async function deliverDue(now = new Date()): Promise<number> {
  const due = await db.select({ id: webhookDeliveries.id }).from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, 'pending'), isNotNull(webhookDeliveries.nextAttemptAt), lte(webhookDeliveries.nextAttemptAt, now)))
    .orderBy(asc(webhookDeliveries.nextAttemptAt)).limit(50)
  for (let i = 0; i < due.length; i += 5) await Promise.allSettled(due.slice(i, i + 5).map((d) => deliver(d.id, now)))
  await db.delete(webhookDeliveries).where(lt(webhookDeliveries.createdAt, new Date(now.getTime() - DELIVERY_DAYS * 86_400_000)))
  return due.length
}

/** event.started for events whose start passed in the last 10 minutes (once per event start, by dedupeKey). */
export async function sweepEventStarts(now = new Date()): Promise<number> {
  const started = await db.select({ id: events.id, ownerId: events.ownerId, name: events.name, startTime: events.startTime, endTime: events.endTime })
    .from(events).where(and(gte(events.startTime, new Date(now.getTime() - 10 * 60_000)), lte(events.startTime, now)))
  for (const e of started) {
    await emitWebhook(e.ownerId, 'event.started', { eventId: e.id, name: e.name, startTime: e.startTime?.toISOString() ?? null, endTime: e.endTime?.toISOString() ?? null }, `event.started:${e.id}:${e.startTime?.toISOString()}`)
  }
  return started.length
}

/** A deployment went live or failed: the scene's owner hears it. */
export async function emitDeploymentFinished(d: { deploymentId: string; sceneId: string; status: 'deployed' | 'failed'; entityId?: string | null; error?: string | null }): Promise<void> {
  try {
    const [s] = await db.select({ ownerId: scenes.ownerId, name: scenes.name }).from(scenes).where(eq(scenes.id, d.sceneId))
    if (!s) return
    await emitWebhook(s.ownerId, 'deployment.finished', {
      deploymentId: d.deploymentId, sceneId: d.sceneId, sceneName: s.name, platform: 'decentraland', status: d.status,
      ...(d.entityId ? { entityId: d.entityId } : {}), ...(d.error ? { error: d.error } : {}),
    }, `deployment.finished:${d.deploymentId}:${d.status}`)
  } catch (err) {
    console.error('[webhooks] deployment event failed:', err instanceof Error ? err.message : err)
  }
}

/** Every 30 s on one instance: retries due, and event starts (the first after 20 s). */
export function startWebhookJobs(): () => void {
  if (!config.webhooksEnabled) return () => {}
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await withLock('webhooks', async () => { await sweepEventStarts(); await deliverDue() })
    } catch (err) {
      console.error('[webhooks] sweep failed:', err instanceof Error ? err.message : err)
    } finally {
      running = false
    }
  }
  const timers = [setInterval(tick, 30_000), setTimeout(tick, 20_000)]
  for (const t of timers) t.unref()
  return () => { for (const t of timers) clearTimeout(t) }
}

// ── the account's own webhooks ──────────────────────────────────────────────

const view = (h: typeof webhooks.$inferSelect) => ({ id: h.id, url: h.url, events: h.events, createdAt: h.createdAt })

export async function listWebhooks(userId: string) {
  return (await db.select().from(webhooks).where(eq(webhooks.userId, userId)).orderBy(desc(webhooks.createdAt))).map(view)
}

export async function createWebhook(userId: string, body: { url?: unknown; events?: unknown }) {
  const url = await checkWebhookUrl(body.url)
  const wanted = body.events
  if (!Array.isArray(wanted) || !wanted.length || !wanted.every((e) => (SUBSCRIBABLE as string[]).includes(e as string))) {
    throw new WebhookError(400, 'bad_events', `Choose one or more of: ${SUBSCRIBABLE.join(', ')}.`)
  }
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(webhooks).where(eq(webhooks.userId, userId))
  if (n >= MAX_WEBHOOKS) throw new WebhookError(409, 'too_many_webhooks', `An account can have up to ${MAX_WEBHOOKS} webhooks.`)
  const [row] = await db.insert(webhooks).values({ userId, url, events: [...new Set(wanted as string[])], salt: randomBytes(16).toString('hex') }).returning()
  return { webhook: view(row), secret: webhookSecret(row.id, row.salt) }
}

async function own(userId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const [row] = await db.select().from(webhooks).where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
  return row ?? null
}

export async function deleteWebhook(userId: string, id: string): Promise<boolean> {
  if (!(await own(userId, id))) return false
  await db.delete(webhooks).where(eq(webhooks.id, id))
  return true
}

/** Queues a webhook.test delivery to this one webhook and sends it now. */
export async function testWebhook(userId: string, id: string): Promise<{ deliveryId: string } | null> {
  const h = await own(userId, id)
  if (!h) return null
  const now = new Date()
  const [row] = await db.insert(webhookDeliveries).values({ webhookId: h.id, event: 'webhook.test', nextAttemptAt: now, payload: { type: 'webhook.test', createdAt: now.toISOString(), data: { message: 'A test from Virvi' } } }).returning({ id: webhookDeliveries.id })
  await deliver(row.id, now)
  return { deliveryId: row.id }
}

export async function deliveriesOf(userId: string, id: string) {
  if (!(await own(userId, id))) return null
  return db.select({ id: webhookDeliveries.id, event: webhookDeliveries.event, status: webhookDeliveries.status, attempts: webhookDeliveries.attempts, responseStatus: webhookDeliveries.responseStatus, lastError: webhookDeliveries.lastError, createdAt: webhookDeliveries.createdAt, deliveredAt: webhookDeliveries.deliveredAt })
    .from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, id)).orderBy(desc(webhookDeliveries.createdAt)).limit(50)
}

