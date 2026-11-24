/**
 * The scene editor's giveaway kiosks (scene elements of type `claim_point`): the property panel's choices and copy.
 * The settings are read with the shared kioskSettings the scene runtime uses, and checked by the server with
 * checkKioskProperties. Hosts call it a kiosk, never a claim point.
 */
import { ClaimPointType, MannequinType, kioskSettings, type KioskColor, type KioskSettings } from '@virvixr/shared'
import { GENERIC_ERROR, GIVEAWAYS_OFF, giveawayStatus, type GiveawaySummary } from './drops'

export { kioskSettings, type KioskSettings }

/** What a new kiosk starts with: the marketplace image in a booth, with the default colours. */
export const NEW_KIOSK_PROPERTIES = { claimPointType: ClaimPointType.MARKETPLACE_IMAGE, enableKiosk: true, enableSpin: false, hoverText: 'Claim', itemYOffset: 0, itemScale: 1 }

export const KIOSK_DISPLAY_CHOICES: { value: ClaimPointType; label: string; hint: string }[] = [
  { value: ClaimPointType.MARKETPLACE_IMAGE, label: 'Marketplace image', hint: "The giveaway's first item, as the Decentraland Marketplace shows it." },
  { value: ClaimPointType.CUSTOM_IMAGE, label: 'Your image', hint: 'An image you pick.' },
  { value: ClaimPointType.MODEL, label: '3D model', hint: 'A model you pick.' },
  { value: ClaimPointType.MANNEQUIN, label: 'Mannequin', hint: "An avatar wearing the giveaway's wearables." },
]

export const MANNEQUIN_CHOICES: { value: MannequinType; label: string }[] = [
  { value: MannequinType.MATCH_PLAYER, label: 'Dressed like the visitor' },
  { value: MannequinType.FEMALE, label: 'Female' },
  { value: MannequinType.MALE, label: 'Male' },
]

/** The three booth colours, as the panel names them. */
export const KIOSK_COLOR_FIELDS: { key: 'color1' | 'color2' | 'color3'; label: string }[] = [
  { key: 'color1', label: 'Roof and sides' },
  { key: 'color2', label: 'Panel' },
  { key: 'color3', label: 'Counter' },
]

export const KIOSK_HELP = 'Visitors click the kiosk to open the giveaway card. In a scene with a kiosk, the card only opens from one.'

const hex2 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0')

/** A kiosk colour as #rrggbb, for a colour input. */
export function colorToHex(c: KioskColor): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`
}

/** #rrggbb as a kiosk colour (channels 0-1, opaque); null for anything else. */
export function hexToColor(hex: string): KioskColor | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) return null
  const ch = (s: string) => Math.round((parseInt(s, 16) / 255) * 1000) / 1000
  return { r: ch(m[1]), g: ch(m[2]), b: ch(m[3]), a: 1 }
}

export interface GiveawayOption { value: string; label: string; disabled?: boolean }

/**
 * The giveaway picker's choices: none, then the host's giveaways with their status. A kiosk linked to a giveaway the
 * viewer can't see (another editor's) keeps it, shown as such, so saving other settings doesn't drop it.
 */
export function kioskGiveawayOptions(list: GiveawaySummary[], current: string | null, now: number = Date.now()): GiveawayOption[] {
  const out: GiveawayOption[] = [{ value: '', label: 'No giveaway yet' }]
  for (const g of list) {
    if (g.deleteState === 'returning' && g.id !== current) continue
    out.push({ value: g.id, label: `${g.name} (${giveawayStatus(g, now).label})` })
  }
  if (current && !list.some((g) => g.id === current)) out.push({ value: current, label: 'Someone else’s giveaway', disabled: true })
  return out
}

/** A one-line note under the picker, or null. */
export function kioskGiveawayNote(list: GiveawaySummary[] | null, s: Pick<KioskSettings, 'giveawayId'>): string | null {
  if (list && list.length === 0) return 'You have no giveaways yet. Make one on the Drops page first.'
  if (!s.giveawayId) return 'Pick the giveaway this kiosk gives away. Picking one adds this scene to it.'
  return null
}

type ApiErr = { body?: { error?: string; message?: string } }

/** Why saving a kiosk was refused. */
export function kioskSaveError(err: unknown): string {
  const body = (err as ApiErr)?.body
  switch (body?.error) {
    case 'giveaways_off': return GIVEAWAYS_OFF
    case 'not_found': return "That giveaway isn't one of yours."
    case 'forbidden': return body.message?.trim() || "You can't use that giveaway in this scene."
    default: return body?.message?.trim() || GENERIC_ERROR
  }
}

/** What the display choice still needs before the kiosk shows an item, or null. */
export function kioskItemNote(s: KioskSettings): string | null {
  switch (s.claimPointType) {
    case ClaimPointType.MARKETPLACE_IMAGE: return s.giveawayId ? null : 'The image appears once you pick a giveaway.'
    case ClaimPointType.CUSTOM_IMAGE: return s.imgSrc ? null : 'Pick an image to show.'
    case ClaimPointType.MODEL: return s.modelSrc ? null : 'Pick a model to show.'
    case ClaimPointType.MANNEQUIN: return s.giveawayId ? null : 'The mannequin wears the wearables once you pick a giveaway.'
    default: return null
  }
}
