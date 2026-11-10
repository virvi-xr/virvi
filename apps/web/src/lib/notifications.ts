import { categoryLabel } from './studio'

/**
 * The bell (LIV-159): the server's notification shapes (apps/server/src/notifications/notifications.ts) and their copy.
 * A notification carries names and design titles only.
 */
export type NotificationItem = {
  id: string
  kind: 'studio_invite' | 'studio_prompts' | 'studio_package_ready' | 'studio_owner' | string
  data: Record<string, unknown>
  createdAt: string
  updatedAt: string
  readAt: string | null
  /** The invite was answered or ran out, or I'm no longer on the design. */
  gone: boolean
}

/** The unread badge: nothing at 0, the number up to 9, then 9+. */
export function badgeText(count: number): string | null {
  if (!(count > 0)) return null
  return count > 9 ? '9+' : String(Math.floor(count))
}

/** "Sam", "Sam and Alex", "Sam, Alex and 2 others". */
export function senderNames(senders: string[]): string {
  const names = senders.filter((s) => s.trim())
  if (names.length === 0) return 'Someone'
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  const rest = names.length - 2
  return `${names[0]}, ${names[1]} and ${rest} other${rest === 1 ? '' : 's'}`
}

const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v : fallback)

/** A notification's line and where clicking it goes (null when there is nowhere to go). */
export function notificationText(item: Pick<NotificationItem, 'kind' | 'data' | 'gone'>): { text: string; href: string | null } {
  const d = item.data
  const design = str(d.designName, 'a design')
  const designId = typeof d.designId === 'string' && d.designId ? d.designId : null
  if (item.gone) return { text: `${design} is no longer shared with you`, href: null }
  // An invite is answered on the Studio page (or right in the list); the design opens once it is accepted
  if (item.kind === 'studio_invite') return { text: `${str(d.inviterName, 'Someone')} invited you to ${design}`, href: '/studio' }
  const href = designId ? `/studio/${designId}` : null
  switch (item.kind) {
    case 'studio_prompts': {
      const senders = Array.isArray(d.senders) ? d.senders.filter((s): s is string => typeof s === 'string') : []
      const count = Number(d.count) || 1
      if (count > 1) return { text: `${senderNames(senders)} sent ${count} prompts on ${design}`, href }
      return { text: `${senderNames(senders.slice(0, 1))} sent a prompt on ${design}`, href }
    }
    case 'studio_package_ready':
      return { text: `The ${categoryLabel(str(d.category, 'piece'))} package for ${design} is ready to download`, href }
    case 'studio_owner':
      return { text: `You're now the owner of ${design}`, href }
    default:
      return { text: design, href }
  }
}
