/** A scene's activity log (LIV-32): turning each entry into a line a person can read. */

export interface SceneActivityEntry {
  id: string
  action: string
  via: 'dashboard' | 'in_world' | 'api' | string
  subject: { type: string | null; id: string | null; name: string | null }
  detail: Record<string, unknown> | null
  count: number
  at: string
  firstAt: string
  actor: { name: string | null; wallet: string | null }
}

const KIND: Record<string, string> = {
  video: 'screen', image: 'image', model: 'model', sound: 'sound', widget: 'widget', ad_space: 'ad space', claim_point: 'kiosk', nft: 'NFT', custom: 'item',
}
const ROLE: Record<string, string> = { cohost: 'co-host', editor: 'editor', viewer: 'viewer' }

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

/** Who did it: their Virvi name, else their wallet, shortened. */
export function activityActor(e: SceneActivityEntry): string {
  if (e.via === 'rule') return 'Virvi'
  return e.actor.name || (e.actor.wallet ? short(e.actor.wallet) : 'Someone')
}

/** What was done, as a sentence without its subject ("added the image “Poster”"). */
export function describeActivity(e: SceneActivityEntry): string {
  const kind = KIND[e.subject.type ?? ''] ?? 'item'
  const name = e.subject.name ? `“${e.subject.name}”` : ''
  const thing = `the ${kind}${name ? ` ${name}` : ''}`
  const who = e.subject.name || (e.subject.id && e.subject.type === 'wallet' ? short(e.subject.id) : 'someone')
  const d = e.detail ?? {}
  const role = (k: string) => ROLE[String(d[k])] ?? String(d[k] ?? '')
  const times = e.count > 1 ? ` (${e.count} times)` : ''
  switch (e.action) {
    case 'element.created': return `added ${thing}`
    case 'element.updated': return typeof d.rule === 'string' ? `changed ${thing} through ${d.rule ? `the rule “${d.rule}”` : 'a rule'}${times}` : `changed ${thing}${times}`
    case 'element.deleted': return `deleted ${thing}`
    case 'element.live_on': return `turned on the live stream on ${thing}`
    case 'element.live_off': return `turned off the live stream on ${thing}`
    case 'instance.added': return `placed a copy of ${thing}`
    case 'instance.updated': return `moved or changed a copy of ${thing}${times}`
    case 'instance.removed': return `removed a copy of ${thing}`
    case 'instances.cleared': return `removed ${typeof d.removed === 'number' ? `all ${d.removed} copies` : 'every copy'} of ${thing}`
    case 'scene.updated':
      return Array.isArray(d.changed) && d.changed.includes('name') && typeof d.from === 'string'
        ? `renamed the scene from “${d.from}” to ${name || 'a new name'}`
        : `changed the scene's description${times}`
    case 'scene.thumbnail_changed': return d.removed ? 'removed the thumbnail' : 'changed the thumbnail'
    case 'scene.deleted': return 'deleted the scene'
    case 'scene.restored': return 'restored the scene'
    case 'preset.created': return `${d.copied ? 'copied a preset as' : 'created the preset'} ${name}`.trim()
    case 'preset.renamed': return `renamed the preset “${String(d.from ?? '')}” to ${name}`
    case 'preset.deleted': return `deleted the preset ${name}`.trim()
    case 'preset.activated': return `made the preset ${name} live`.replace('  ', ' ')
    case 'collaborator.added': return `added ${who} as ${role('role')}`
    case 'collaborator.changed': return `made ${who} ${role('role')} (was ${role('from')})`
    case 'collaborator.removed': return d.left ? 'left the scene' : `removed ${who} (${role('role')})`
    case 'role.granted': return d.from ? `made ${who} ${role('role')} (was ${role('from')})` : `made ${who} ${role('role')}`
    case 'role.revoked': return `removed ${who} as ${role('role')}`
    case 'host.transferred': return `made ${who} the host`
    case 'rule.created': return `added the rule ${name || 'without a name'}`
    case 'rule.updated': return `changed the rule ${name || 'without a name'}${times}`
    case 'rule.deleted': return `deleted the rule ${name || 'without a name'}`
    case 'deploy.started': return `${d.signed ? 'prepared a deploy to' : 'deployed to'} ${e.subject.name ?? 'Decentraland'}`
    default: return 'made a change'
  }
}

export const VIA_LABEL: Record<string, string> = { dashboard: 'Dashboard', in_world: 'In-world', api: 'API', rule: 'Timed rule' }

/** The cursor for the page after this one. */
export const nextCursor = (entries: SceneActivityEntry[]) => {
  const last = entries[entries.length - 1]
  return last ? `${last.at},${last.id}` : undefined
}
