import { categoryLabel, pieceLabel } from './studio'

/** A finished package's piece in a sentence: a scene piece by its own name ("round table"), never its folder. */
const packageWord = (category: string) => (category === 'building' || category.startsWith('furniture_') ? pieceLabel(category).toLowerCase() : categoryLabel(category))

/**
 * The bell (LIV-159): the server's notification shapes (apps/server/src/notifications/notifications.ts) and their copy.
 * A notification carries names and design titles only.
 */
export type NotificationItem = {
  id: string
  kind: 'studio_invite' | 'studio_prompts' | 'studio_package_ready' | 'studio_owner' | 'studio_support_note' | 'studio_help' | 'scene_update' | 'model_taken_down' | 'model_appeal' | string
  data: Record<string, unknown>
  createdAt: string
  updatedAt: string
  readAt: string | null
  /** The invite was answered or ran out, or I'm no longer on the design. */
  gone: boolean
  /** An invite still waiting on my answer (false for every other kind). */
  open: boolean
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

/** Accept and Decline show only while the invite is still open. */
export function inviteActionable(item: Pick<NotificationItem, 'kind' | 'gone' | 'open'>): boolean {
  return item.kind === 'studio_invite' && !item.gone && item.open
}

/** A notification's line and where clicking it goes (null when there is nowhere to go). */
export function notificationText(item: Pick<NotificationItem, 'kind' | 'data' | 'gone' | 'open'>): { text: string; href: string | null } {
  const d = item.data
  // LIV-30: scene updates and moderation point at a scene or a model, not a design
  switch (item.kind) {
    case 'scene_update': {
      const scene = str(d.sceneName, 'Your scene')
      const sceneId = typeof d.sceneId === 'string' && d.sceneId ? d.sceneId : null
      const how = d.virviDeploys ? 'Redeploy it to update.' : 'Update @virvixr/dcl in its project and deploy it.'
      return { text: `${scene} can update to Virvi ${str(d.latest, 'the latest release')}. ${how}`, href: sceneId ? `/scenes/${sceneId}` : '/scenes' }
    }
    case 'model_taken_down':
      return { text: `Virvi took down your model ${str(d.assetName, 'a model')}: ${str(d.reason, 'see the model for why')}. You can appeal.`, href: '/assets/' }
    case 'model_appeal':
      return d.decision === 'restored'
        ? { text: `Your appeal was accepted: ${str(d.assetName, 'your model')} can be shared again`, href: '/assets/' }
        : { text: `Your appeal for ${str(d.assetName, 'your model')} was turned down${typeof d.response === 'string' && d.response ? `: ${d.response}` : ''}`, href: '/assets/' }
  }
  const design = str(d.designName, 'a design')
  const designId = typeof d.designId === 'string' && d.designId ? d.designId : null
  if (item.gone) return { text: `${design} is no longer shared with you`, href: null }
  const href = designId ? `/studio/${designId}` : null
  // An open invite is answered on the Studio page (or right in the list); once answered and I'm on it, it opens the design
  if (item.kind === 'studio_invite') return { text: `${str(d.inviterName, 'Someone')} invited you to ${design}`, href: item.open ? '/studio' : href }
  switch (item.kind) {
    case 'studio_prompts': {
      const senders = Array.isArray(d.senders) ? d.senders.filter((s): s is string => typeof s === 'string') : []
      const count = Number(d.count) || 1
      if (count > 1) return { text: `${senderNames(senders)} sent ${count} prompts on ${design}`, href }
      return { text: `${senderNames(senders.slice(0, 1))} sent a prompt on ${design}`, href }
    }
    case 'studio_package_ready':
      return { text: `The ${packageWord(str(d.category, 'piece'))} package for ${design} is ready to download`, href }
    case 'studio_owner':
      return { text: `You're now the owner of ${design}`, href }
    case 'studio_support_note': {
      const count = Number(d.count) || 1
      return { text: count > 1 ? `Virvi support sent you ${count} messages on ${design}` : `Virvi support sent you a message on ${design}`, href }
    }
    case 'studio_help':
      return { text: `${str(d.requesterName, 'Someone')} asked for help on ${design}`, href }
    default:
      return { text: design, href }
  }
}
