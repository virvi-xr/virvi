/**
 * Giveaway kiosks (scene element type `claim_point`): a booth or a standalone item a host places in a scene, linked to
 * one of their automatic giveaways (LIV-194). Clicking it opens the giveaway card. Defined once here: the server checks
 * what is saved, the scene runtime reads it with the same defaults, and the dashboard edits it.
 *
 * The stored property names are old VLM's (ClaimPointProperties). Colours are { r, g, b, a } with channels from 0 to 1.
 */
import { ClaimPointType, MannequinType } from './enums/index.js'
import type { GiveawayChain } from './giveaways.js'

export type KioskColor = { r: number; g: number; b: number; a: number }

export const KIOSK_HOVER_TEXT_DEFAULT = 'Claim'
export const KIOSK_HOVER_TEXT_MAX = 40
export const KIOSK_SCALE = { min: 0.1, max: 10 } as const
export const KIOSK_Y_OFFSET = { min: -5, max: 10 } as const
export const KIOSK_SRC_MAX = 2048

/** Roof and sides, the display panel, the counter. */
export const KIOSK_DEFAULT_COLORS: { color1: KioskColor; color2: KioskColor; color3: KioskColor } = {
  color1: { r: 0.42, g: 0.27, b: 0.93, a: 1 },
  color2: { r: 0.08, g: 0.08, b: 0.12, a: 1 },
  color3: { r: 0.95, g: 0.95, b: 0.97, a: 1 },
}

/**
 * What the server adds to a serialized kiosk (never stored): the linked giveaway's items in order, for the marketplace
 * image (`thumbnail`) and the mannequin's wearables (`urn`). Empty when the kiosk has no giveaway or it is gone.
 */
export interface KioskItem {
  name: string | null
  thumbnail: string | null
  urn: string | null
}
export const KIOSK_ITEMS_KEY = 'giveawayItems'

export interface KioskSettings {
  giveawayId: string | null
  claimPointType: ClaimPointType
  /** Show the booth (roof sign, panel, counter and Claim button) around the item. */
  enableKiosk: boolean
  enableSpin: boolean
  imgSrc: string | null
  modelSrc: string | null
  mannequinType: MannequinType
  hoverText: string
  color1: KioskColor
  color2: KioskColor
  color3: KioskColor
  /** A banner on the booth's roof sign. */
  kioskImgSrc: string | null
  itemYOffset: number
  itemScale: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TYPES = new Set<number>([ClaimPointType.MARKETPLACE_IMAGE, ClaimPointType.CUSTOM_IMAGE, ClaimPointType.MODEL, ClaimPointType.MANNEQUIN])
const MANNEQUINS = new Set<number>([MannequinType.MALE, MannequinType.FEMALE, MannequinType.MATCH_PLAYER])

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clamp = (n: number, r: { min: number; max: number }) => Math.min(r.max, Math.max(r.min, n))
const src = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

function readColor(v: unknown, fallback: KioskColor): KioskColor {
  if (!isObj(v)) return fallback
  const ch = (k: 'r' | 'g' | 'b' | 'a', d: number) => (finite(v[k]) ? Math.min(1, Math.max(0, v[k] as number)) : d)
  return { r: ch('r', fallback.r), g: ch('g', fallback.g), b: ch('b', fallback.b), a: ch('a', 1) }
}

/** A stored kiosk as runtimes and editors read it: anything missing or out of range falls back to the default. */
export function kioskSettings(raw: unknown): KioskSettings {
  const p = isObj(raw) ? raw : {}
  const hover = typeof p.hoverText === 'string' ? p.hoverText.trim() : ''
  return {
    giveawayId: typeof p.giveawayId === 'string' && UUID.test(p.giveawayId) ? p.giveawayId.toLowerCase() : null,
    claimPointType: finite(p.claimPointType) && TYPES.has(p.claimPointType) ? p.claimPointType : ClaimPointType.MARKETPLACE_IMAGE,
    enableKiosk: p.enableKiosk !== false,
    enableSpin: p.enableSpin === true,
    imgSrc: src(p.imgSrc),
    modelSrc: src(p.modelSrc),
    mannequinType: finite(p.mannequinType) && MANNEQUINS.has(p.mannequinType) ? p.mannequinType : MannequinType.MATCH_PLAYER,
    hoverText: hover ? hover.slice(0, KIOSK_HOVER_TEXT_MAX) : KIOSK_HOVER_TEXT_DEFAULT,
    color1: readColor(p.color1, KIOSK_DEFAULT_COLORS.color1),
    color2: readColor(p.color2, KIOSK_DEFAULT_COLORS.color2),
    color3: readColor(p.color3, KIOSK_DEFAULT_COLORS.color3),
    kioskImgSrc: src(p.kioskImgSrc),
    itemYOffset: finite(p.itemYOffset) ? clamp(p.itemYOffset, KIOSK_Y_OFFSET) : 0,
    itemScale: finite(p.itemScale) && p.itemScale > 0 ? clamp(p.itemScale, KIOSK_SCALE) : 1,
  }
}

/** The server's items on a serialized kiosk; [] for anything else. */
export function kioskItemsOf(element: unknown): KioskItem[] {
  const list = isObj(element) ? element[KIOSK_ITEMS_KEY] : undefined
  if (!Array.isArray(list)) return []
  return list.filter(isObj).map((i) => ({
    name: typeof i.name === 'string' ? i.name : null,
    thumbnail: typeof i.thumbnail === 'string' && i.thumbnail ? i.thumbnail : null,
    urn: typeof i.urn === 'string' && i.urn ? i.urn : null,
  }))
}

export type KioskCheck = { ok: true; value: Record<string, unknown> } | { ok: false; error: string }

/**
 * A kiosk's properties as sent to the server, checked and tidied: each kiosk setting that is present must be valid
 * (null or '' clears an optional one). Other keys are kept as they are, except the server-made item list, which is
 * never stored.
 */
export function checkKioskProperties(raw: unknown): KioskCheck {
  if (raw === null || raw === undefined) return { ok: true, value: {} }
  if (!isObj(raw)) return { ok: false, error: 'Kiosk settings must be an object.' }
  const out: Record<string, unknown> = { ...raw }
  delete out[KIOSK_ITEMS_KEY]
  const fail = (error: string): KioskCheck => ({ ok: false, error })
  const has = (k: string) => k in raw && raw[k] !== undefined

  if (has('giveawayId')) {
    const v = raw.giveawayId
    if (v === null || v === '') out.giveawayId = null
    else if (typeof v !== 'string' || !UUID.test(v)) return fail('Pick one of your giveaways.')
    else out.giveawayId = v.toLowerCase()
  }
  if (has('claimPointType') && !(finite(raw.claimPointType) && TYPES.has(raw.claimPointType))) {
    return fail('Show the item as its marketplace image, your own image, a 3D model or a mannequin.')
  }
  if (has('mannequinType') && !(finite(raw.mannequinType) && MANNEQUINS.has(raw.mannequinType))) {
    return fail('The mannequin is male, female or dressed like the visitor.')
  }
  for (const k of ['enableKiosk', 'enableSpin'] as const) {
    if (has(k) && typeof raw[k] !== 'boolean') return fail(`${k === 'enableKiosk' ? 'The booth' : 'Spinning'} is on or off.`)
  }
  for (const k of ['imgSrc', 'modelSrc', 'kioskImgSrc'] as const) {
    if (!has(k)) continue
    const v = raw[k]
    if (v === null || v === '') { out[k] = null; continue }
    if (typeof v !== 'string' || v.length > KIOSK_SRC_MAX) return fail('That image or model address is not usable.')
    out[k] = v.trim()
  }
  if (has('hoverText')) {
    const v = raw.hoverText
    if (v === null) out.hoverText = null
    else if (typeof v !== 'string' || [...v.trim()].length > KIOSK_HOVER_TEXT_MAX) return fail(`Keep the hover text to ${KIOSK_HOVER_TEXT_MAX} characters.`)
    else out.hoverText = v.trim()
  }
  for (const k of ['color1', 'color2', 'color3'] as const) {
    if (!has(k)) continue
    const c = raw[k]
    if (!isObj(c) || !(['r', 'g', 'b'] as const).every((ch) => finite(c[ch]) && (c[ch] as number) >= 0 && (c[ch] as number) <= 1) ||
      (c.a !== undefined && !(finite(c.a) && c.a >= 0 && c.a <= 1))) {
      return fail('Kiosk colours have red, green and blue from 0 to 1.')
    }
    out[k] = { r: c.r, g: c.g, b: c.b, a: c.a ?? 1 }
  }
  if (has('itemYOffset') && !(finite(raw.itemYOffset) && raw.itemYOffset >= KIOSK_Y_OFFSET.min && raw.itemYOffset <= KIOSK_Y_OFFSET.max)) {
    return fail(`The item's height goes from ${KIOSK_Y_OFFSET.min} to ${KIOSK_Y_OFFSET.max} metres.`)
  }
  if (has('itemScale') && !(finite(raw.itemScale) && raw.itemScale >= KIOSK_SCALE.min && raw.itemScale <= KIOSK_SCALE.max)) {
    return fail(`The item's size goes from ${KIOSK_SCALE.min} to ${KIOSK_SCALE.max}.`)
  }
  return { ok: true, value: out }
}

/** A collection item's wearable URN, as an AvatarShape takes it. */
export function giveawayItemUrn(chain: GiveawayChain, contractAddress: string, itemId: string): string {
  const network = chain === 'polygon' ? 'matic' : 'amoy'
  return `urn:decentraland:${network}:collections-v2:${contractAddress.toLowerCase()}:${itemId}`
}
