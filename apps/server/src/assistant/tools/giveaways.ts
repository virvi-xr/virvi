// Automatic giveaways (LIV-194): the assistant can set one up for a show, always switched off. It never turns one on, moves
// POL, sends a balance back or deletes: those are the host's, in Drops, once the wallet is a minter on their collection.
import { z } from 'zod'
import { config } from '../../config.js'
import { id } from './read.js'
import { created, fields, get, sceneState } from './write.js'
import { inject, routeError } from './http.js'
import { ToolError, type Before, type ToolDef } from './types.js'

type Obj = Record<string, any>

export const GIVEAWAY_NEXT = 'Add it as a minter on your collection in the Builder, then switch the giveaway on in Drops.'
const NOT_YOURS = 'Pick items from collections you created, with a wallet linked to your account.'
const GIVEAWAYS_OFF = "Automatic giveaways aren't switched on for this server yet."

export const GIVEAWAY_TOOLS: ToolDef<any>[] = [
  {
    name: 'create_giveaway',
    description:
      "Create an automatic giveaway for a show, in a scene: its name, the scene, and the wearable items it gives away (contractAddress and itemId, from the show's wearable or the user). It is always created switched off; you can't switch it on, fund it, send its balance back or delete it. The result gives the giveaway's wallet address: tell the user to add it as a minter on their collection in the Builder, then switch the giveaway on in Drops.",
    input: z.object({
      name: z.string().trim().min(1).max(80),
      sceneId: id(),
      items: z.array(z.object({ contractAddress: z.string().trim().max(64), itemId: z.string().trim().max(40) })).min(1).max(10).optional(),
    }),
    effect: 'write',
    available: () => config.giveaways.enabled,
    // Several routes, in order: the giveaway, then its items (if any), then its scene. The last answer is the giveaway as the host sees it.
    call: async (a, ctx) => {
      const made = await inject(ctx, { method: 'POST', url: '/api/giveaways', body: { name: a.name } })
      if (made.status >= 400) throw new ToolError(made.status, routeError(made.status, made.json))
      const giveawayId = created(made.json, 'giveaway').id
      return [
        ...(a.items?.length ? [{ method: 'PUT' as const, url: `/api/giveaways/${giveawayId}/items`, body: { items: a.items } }] : []),
        { method: 'PUT' as const, url: `/api/giveaways/${giveawayId}/scenes`, body: { sceneIds: [a.sceneId] } },
      ]
    },
    // The scene as the user sees it (their own refusal otherwise), so the row names its organization
    before: async (a, ctx): Promise<Before> => {
      if (!config.giveaways.enabled) throw new ToolError(503, GIVEAWAYS_OFF)
      const { orgName } = await sceneState(ctx, a.sceneId)
      // Checked here so a wrong item leaves no half-made giveaway behind
      if (a.items?.length) {
        const mine = ((await get(ctx, '/api/giveaways/creator-items')).items ?? []) as Obj[]
        const has = (i: { contractAddress: string; itemId: string }) => mine.some((m) => String(m.contractAddress).toLowerCase() === i.contractAddress.toLowerCase() && String(m.itemId) === i.itemId)
        if (!a.items.every(has)) throw new ToolError(400, NOT_YOURS)
      }
      // No delete tool, so nothing to undo with
      return { undo: null, after: (res) => fields((res as Obj[]).at(-1), ['id', 'name']), orgName }
    },
    keepWallets: (res) => [String(((res as Obj[]).at(-1) ?? {}).walletAddress ?? '')],
    label: (a) => `Create giveaway "${a.name}"`,
    summarize: (res) => {
      const g = ((res as Obj[]).at(-1) ?? {}) as Obj
      const wallet = typeof g.walletAddress === 'string' && g.walletAddress ? `Giveaway wallet ${g.walletAddress}. ` : ''
      return { ...fields(g, ['id', 'name', 'enabled', 'walletAddress', 'builderUrl']), next: `${wallet}${GIVEAWAY_NEXT}` }
    },
  },
]
