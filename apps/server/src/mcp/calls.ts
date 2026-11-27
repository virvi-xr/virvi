import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { apiKeys, mcpCalls, scenes } from '../db/schema.js'

/** LIV-170: the per-key log of MCP tool calls, for the key's owner. */
export const MCP_CALL_DAYS = 90
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The scene a call named, when its arguments carry one. */
export function sceneOfArgs(args: Record<string, unknown>): string | null {
  const v = args.sceneId
  return typeof v === 'string' && UUID.test(v) ? v : null
}

/** Records one call; never throws (a failed log row never fails the tool). Now and then clears rows past 90 days. */
export async function recordMcpCall(c: { apiKeyId: string; userId: string; tool: string; sceneId: string | null; ok: boolean; error: string | null }): Promise<void> {
  try {
    await db.insert(mcpCalls).values({ ...c, error: c.error ? c.error.slice(0, 300) : null })
    if (Math.random() < 0.02) await db.delete(mcpCalls).where(lt(mcpCalls.at, sql`now() - make_interval(days => ${MCP_CALL_DAYS})`))
  } catch (err) {
    console.error('[mcp] call not logged:', err instanceof Error ? err.message : err)
  }
}

/** A key's last 100 calls, newest first, with each named scene's name; null when the key isn't the user's. */
export async function callsOfKey(userId: string, keyId: string) {
  if (!UUID.test(keyId)) return null
  const [key] = await db.select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
  if (!key) return null
  const rows = await db.select({ tool: mcpCalls.tool, sceneId: mcpCalls.sceneId, sceneName: scenes.name, ok: mcpCalls.ok, error: mcpCalls.error, at: mcpCalls.at })
    .from(mcpCalls).leftJoin(scenes, eq(scenes.id, mcpCalls.sceneId))
    .where(eq(mcpCalls.apiKeyId, keyId)).orderBy(desc(mcpCalls.at)).limit(100)
  return rows
}
