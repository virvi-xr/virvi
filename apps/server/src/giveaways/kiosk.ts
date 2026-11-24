import { and, inArray, isNull } from 'drizzle-orm'
import { KIOSK_ITEMS_KEY, giveawayItemUrn, kioskSettings, type KioskItem } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { giveawayItems, giveaways } from '../db/schema.js'

/**
 * Giveaway kiosks (scene elements of type `claim_point`): what the scene runtime needs of the linked giveaway to draw
 * the item, added to each serialized kiosk as `giveawayItems` (never stored). Only public marketplace facts go out:
 * each item's name, thumbnail and wearable URN, in the order the visitor card lists them. A kiosk whose giveaway is
 * deleted or missing gets an empty list, so its marketplace image or mannequin shows nothing rather than an old item.
 */

type Kiosk = Record<string, unknown>

/** The items of each of these giveaways that still exist, by giveaway id. */
async function itemsByGiveaway(ids: string[]): Promise<Map<string, KioskItem[]>> {
  const out = new Map<string, KioskItem[]>()
  if (!ids.length) return out
  const live = await db.select({ id: giveaways.id, chain: giveaways.chain }).from(giveaways)
    .where(and(inArray(giveaways.id, ids), isNull(giveaways.deletedAt)))
  if (!live.length) return out
  const chainOf = new Map(live.map((g) => [g.id, g.chain]))
  const rows = await db.select().from(giveawayItems).where(inArray(giveawayItems.giveawayId, [...chainOf.keys()]))
  // The visitor card's order: by contract, then by item id as a number (decimal strings: by length, then as strings)
  const id = (r: typeof rows[number]) => r.itemId ?? ''
  rows.sort((a, b) => (a.contractAddress ?? '').toLowerCase().localeCompare((b.contractAddress ?? '').toLowerCase()) ||
    id(a).length - id(b).length || (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0))
  for (const g of live) out.set(g.id, [])
  for (const r of rows) {
    const chain = chainOf.get(r.giveawayId)!
    out.get(r.giveawayId)!.push({
      name: r.name ?? null,
      thumbnail: r.imageUrl ?? null,
      urn: r.contractAddress && r.itemId ? giveawayItemUrn(chain, r.contractAddress, r.itemId) : null,
    })
  }
  return out
}

/** These serialized kiosks with their giveaway's items. */
export async function withKioskItems<K extends Kiosk>(kiosks: K[]): Promise<K[]> {
  if (!kiosks.length) return kiosks
  const ids = [...new Set(kiosks.map((k) => kioskSettings(k).giveawayId).filter((v): v is string => !!v))]
  const items = await itemsByGiveaway(ids)
  return kiosks.map((k) => {
    const g = kioskSettings(k).giveawayId
    return { ...k, [KIOSK_ITEMS_KEY]: (g && items.get(g)) || [] }
  })
}

/** A serialized preset with its kiosks' items. */
export async function withKioskPreset<P extends { claimPoints: Kiosk[] }>(preset: P): Promise<P> {
  return { ...preset, claimPoints: await withKioskItems(preset.claimPoints) }
}

/** One serialized element: a kiosk gets its items, anything else is returned as it is. */
export async function withKioskElement<E extends Kiosk>(type: string, element: E): Promise<E> {
  return type === 'claim_point' ? (await withKioskItems([element]))[0] : element
}
