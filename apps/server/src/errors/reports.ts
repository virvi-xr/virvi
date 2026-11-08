import { sql } from 'drizzle-orm'
import type { ReportScreenshot } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { getImportStore } from '../storage/private-store.js'
import { processSceneThumbnail, ThumbnailError, type ThumbnailRules } from '../scenes/thumbnail.js'
import { reportAckEmail, sendEmail } from '../services/email.js'
import { DayBudget, ERROR_BUDGETS, anonLimit, type Trust } from './limits.js'
import { errorUserHash } from './user-hash.js'

/**
 * A user's report (LIV-66 §4): the optional screenshot (checked by its bytes, re-encoded without metadata, kept 30
 * days in the private store under `error-reports/<report id>.<ext>`), and the thank-you email to accounts.
 */

const rowsOf = <T>(r: unknown) => r as unknown as T[]

/** Any shape, at least 16 × 16, scaled down to fit 1920 × 1920; at most 2 MB in and out. */
const SCREENSHOT_RULES: ThumbnailRules = { shape: 'any', min: { width: 16, height: 16 }, max: { width: 1920, height: 1920 } }

export class ScreenshotError extends Error {
  constructor(public status: number, public code: string) { super(code) }
}

export interface Screenshot { data: Buffer; contentType: 'image/png' | 'image/jpeg'; ext: 'png' | 'jpg' }

/** The screenshot as it will be stored, or ScreenshotError (400 too small, 413 too big, 415 not a PNG, JPEG or WebP). */
export async function prepareScreenshot(s: ReportScreenshot): Promise<Screenshot> {
  try {
    const t = await processSceneThumbnail(Buffer.from(s.data, 'base64'), SCREENSHOT_RULES)
    return { data: t.data, contentType: t.contentType, ext: t.ext }
  } catch (err) {
    if (err instanceof ThumbnailError) throw new ScreenshotError(err.status, `screenshot_${err.code}`)
    throw err
  }
}

/**
 * Whether today's screenshot budgets have room for this one: the address's and the user's 5, and 100 (60 for
 * anonymous senders) and 100 MB in all. Takes from all or none.
 */
export async function takeScreenshotBudget(who: { ipHash: string | null; userHash: string | null; trust: Trust }, bytes: number): Promise<boolean> {
  const B = ERROR_BUDGETS
  const limits: Array<[string, number, number]> = [['shot:*', 1, B.screenshotsPerDay], ['shotb:*', bytes, B.screenshotBytesPerDay]]
  if (who.ipHash) limits.push([`shot:${who.ipHash}`, 1, B.screenshotsPerIpDay])
  if (who.userHash) limits.push([`shot:u:${who.userHash}`, 1, B.screenshotsPerUserDay])
  if (who.trust === 'anon') limits.push(['anon:shot:*', 1, anonLimit(B.screenshotsPerDay)], ['anon:shotb:*', bytes, anonLimit(B.screenshotBytesPerDay)])
  const budget = await DayBudget.load(limits.map(([k]) => k))
  if (!budget.takeAllOf(limits)) return false
  await budget.save()
  return true
}

export const screenshotKey = (reportId: string, ext: string) => `error-reports/${reportId}.${ext}`

export async function storeScreenshot(reportId: string, s: Screenshot): Promise<string> {
  const key = screenshotKey(reportId, s.ext)
  await getImportStore().put(key, s.data, s.contentType)
  return key
}

/** The account that sent a report, if it still exists (a deleted account's token sends as no one: M8). */
export async function reportAccount(userId: string | null): Promise<{ id: string; email: string | null; displayName: string | null; trial: boolean } | null> {
  if (!userId) return null
  const [u] = rowsOf<{ id: string; email: string | null; display_name: string | null; is_trial: boolean }>(await db.execute(sql`
    SELECT id, email, display_name, is_trial FROM users WHERE id = ${userId}::uuid`))
  return u ? { id: u.id, email: u.email, displayName: u.display_name, trial: !!u.is_trial } : null
}

/**
 * The thank-you email (the LIV-50 stand-in): accounts with an email only, at most 3 a day each. Sent in the
 * background; true when one was sent off.
 */
export async function sendReportAck(account: { id: string; email: string | null; displayName: string | null; trial: boolean } | null): Promise<boolean> {
  if (!account?.email || account.trial) return false
  const key = `ack:${errorUserHash(account.id)}`
  const budget = await DayBudget.load([key])
  if (!budget.takeAll([[key, ERROR_BUDGETS.reportAcksPerUserDay]])) return false
  await budget.save()
  const { subject, html } = reportAckEmail(account.displayName)
  void sendEmail(account.email, subject, html).catch((err) => console.error('[errors] report thank-you email failed:', err instanceof Error ? err.message : err))
  return true
}

/** Deletes screenshots past screenshotDays (the reports stay). */
export async function purgeScreenshots(now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - ERROR_BUDGETS.screenshotDays * 86_400_000).toISOString()
  const old = rowsOf<{ id: string; screenshot_key: string }>(await db.execute(sql`
    SELECT id, screenshot_key FROM error_reports WHERE screenshot_key IS NOT NULL AND created_at < ${before}::timestamptz LIMIT 1000`))
  if (!old.length) return 0
  await getImportStore().deleteKeys(old.map((r) => r.screenshot_key))
  await db.execute(sql`UPDATE error_reports SET screenshot_key = NULL, screenshot_type = NULL, screenshot_bytes = NULL
    WHERE id IN (${sql.join(old.map((r) => sql`${r.id}::uuid`), sql`, `)})`)
  return old.length
}
