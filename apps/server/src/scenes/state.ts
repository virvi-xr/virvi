import { and, count, eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { sceneState, scenes } from '../db/schema.js'
import { publishVenueEvent } from '../realtime/bus.js'

/**
 * Scene state (LIV-158): a small key-value store per scene that scene code reads and writes. It's kept in Postgres, so
 * it survives restarts and reconnects, and every connected copy of the scene hears each change (the venue bus).
 *
 * Who may write is the scene's `state_writes`: 'staff' (default: scene editors, in-world or through the REST API) or
 * 'everyone' (any visitor's scene code too, so treat the values as untrusted).
 */
export const STATE_MAX_KEYS = 100
export const STATE_MAX_BYTES = 4096
export const STATE_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/
export const STATE_WRITES = ['staff', 'everyone'] as const
export type StateWrites = (typeof STATE_WRITES)[number]

export type StateError = 'bad_key' | 'bad_value' | 'value_too_large' | 'too_many_keys'
export const STATE_ERROR_MESSAGES: Record<StateError, string> = {
  bad_key: 'A state key is 1 to 64 letters, digits, or _ . : -',
  bad_value: 'A state value must be JSON: a string, number, boolean, null, array or object',
  value_too_large: `A state value can be up to ${STATE_MAX_BYTES} bytes as JSON`,
  too_many_keys: `A scene can keep up to ${STATE_MAX_KEYS} state keys; delete one first`,
}

export async function getSceneState(sceneId: string): Promise<Record<string, unknown>> {
  const rows = await db.select({ key: sceneState.key, value: sceneState.value }).from(sceneState).where(eq(sceneState.sceneId, sceneId))
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

export async function stateWritesFor(sceneId: string): Promise<StateWrites> {
  const row = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { stateWrites: true } })
  return row?.stateWrites === 'everyone' ? 'everyone' : 'staff'
}

/** The checks a key and value must pass; null when they're fine. */
export function checkState(key: unknown, value?: unknown, checkValue = true): StateError | null {
  if (typeof key !== 'string' || !STATE_KEY_RE.test(key)) return 'bad_key'
  if (!checkValue) return null
  if (value === undefined || typeof value === 'function') return 'bad_value'
  let json: string
  try {
    json = JSON.stringify(value)
  } catch {
    return 'bad_value'
  }
  if (json === undefined) return 'bad_value'
  if (Buffer.byteLength(json, 'utf8') > STATE_MAX_BYTES) return 'value_too_large'
  return null
}

export async function setSceneState(sceneId: string, key: string, value: unknown): Promise<{ ok: true } | { ok: false; error: StateError }> {
  const bad = checkState(key, value)
  if (bad) return { ok: false, error: bad }
  // Round-trip through JSON so what's stored is what every reader gets (no undefined fields, no Dates)
  const stored = JSON.parse(JSON.stringify(value))
  const result = await db.transaction(async (tx) => {
    const existing = await tx.query.sceneState.findFirst({ where: and(eq(sceneState.sceneId, sceneId), eq(sceneState.key, key)), columns: { key: true } })
    if (!existing) {
      const [{ n }] = await tx.select({ n: count() }).from(sceneState).where(eq(sceneState.sceneId, sceneId))
      if (Number(n) >= STATE_MAX_KEYS) return { ok: false as const, error: 'too_many_keys' as const }
    }
    await tx
      .insert(sceneState)
      .values({ sceneId, key, value: stored, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [sceneState.sceneId, sceneState.key], set: { value: stored, updatedAt: new Date() } })
    return { ok: true as const }
  })
  if (result.ok) await publishVenueEvent({ type: 'state_changed', sceneId, key, value: stored, deleted: false }).catch(() => {})
  return result
}

/** True when the key existed. */
export async function deleteSceneState(sceneId: string, key: string): Promise<boolean> {
  const gone = await db.delete(sceneState).where(and(eq(sceneState.sceneId, sceneId), eq(sceneState.key, key))).returning({ key: sceneState.key })
  if (gone.length) await publishVenueEvent({ type: 'state_changed', sceneId, key, value: null, deleted: true }).catch(() => {})
  return gone.length > 0
}
