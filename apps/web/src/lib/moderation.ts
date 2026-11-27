/** Moderation wording (LIV-34). */
import type { AssetAppeal } from './api'

/** Where the owner's appeal stands, in a sentence. */
export function appealLine(a: Pick<AssetAppeal, 'status' | 'response'>): string {
  if (a.status === 'open') return "You appealed. We'll email you when we've looked at it."
  if (a.status === 'restored') return 'Your appeal was accepted.'
  return `Your appeal was turned down${a.response ? `: ${a.response}` : '.'}`
}

const ACTION: Record<string, string> = {
  taken_down: 'Took down', dismissed: 'Dismissed a report on', restored: 'Restored', appeal_rejected: 'Turned down an appeal for',
  resolved: 'Resolved a Spaces report', reopened: 'Reopened a Spaces report',
}
/** One line of the admin Moderation log. */
export function logLine(l: { action: string; targetType: string; owner: string | null }): string {
  const what = ACTION[l.action] ?? l.action
  if (l.targetType === 'ar_report') return what
  return `${what} ${l.owner ? `${l.owner}'s model` : 'a model'}`
}
