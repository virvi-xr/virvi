// Scene collaborators (phase 2c): who has a role on a scene, and adding or changing one. Adding someone gives them access
// to the scene, so it is a public card. Wallets reach the model only as `[wallet N]` references (resolveWallet); the card
// and the stored label show the short form, and removing someone is done on the scene's Roles tab.
import { z } from 'zod'
import { id, pick } from './read.js'
import { get, sceneState } from './write.js'
import { resolveWallet, shortWallet } from './wallets.js'
import { ToolError, type Before, type ToolCtx, type ToolDef } from './types.js'

type Obj = Record<string, any>
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v : [])

const ROLES = ['cohost', 'editor', 'viewer'] as const
type Role = (typeof ROLES)[number]
const CAN: Record<Role, string> = {
  cohost: 'they can run the scene with you, including deploying it and changing its roles',
  editor: 'they can change the scene',
  viewer: "they can see the scene's analytics",
}
const ARTICLE: Record<Role, string> = { cohost: 'a', editor: 'an', viewer: 'a' }
const UNKNOWN_WALLET = "I don't have that wallet. Ask the user to paste it again."
const IS_HOST = "That wallet is the scene's host."

/** The wallet the user meant, the scene's roles as the route gives them (unredacted: this is server side), and the scene. */
async function state(ctx: ToolCtx, sceneId: string, value: string) {
  const wallet = resolveWallet(value, ctx)
  if (!wallet) throw new ToolError(400, UNKNOWN_WALLET)
  const roles = await get(ctx, `/api/scenes/${sceneId}/roles`)
  if (list(roles.host?.wallets).some((w) => String(w).toLowerCase() === wallet)) throw new ToolError(409, IS_HOST)
  const existing = list(roles.roles).find((r) => String(r.wallet).toLowerCase() === wallet)
  const { scene, orgName } = await sceneState(ctx, sceneId)
  return { wallet, existing: (existing?.role as Role | undefined) ?? null, scene, orgName }
}

const rolesUrl = (sceneId: string) => `/api/scenes/${sceneId}/roles`

export const COLLABORATOR_TOOLS: ToolDef<any>[] = [
  {
    name: 'list_scene_collaborators',
    description: "Who has a role on a scene besides its host: each person's role (cohost, editor or viewer), their name when they have signed in, and whether they have.",
    input: z.object({ sceneId: id() }),
    effect: 'read',
    call: (a) => ({ method: 'GET', url: rolesUrl(a.sceneId) }),
    label: () => "List the scene's collaborators",
    summarize: (res) => {
      const o = (res ?? {}) as Obj
      return {
        host: pick(o.host ?? {}, ['displayName']),
        roles: list(o.roles).map((r) => ({ ...pick(r, ['wallet', 'role', 'displayName']), signedIn: Boolean(r.userId) })),
      }
    },
  },
  {
    name: 'add_scene_collaborator',
    description:
      "Give someone a role on a scene (cohost, editor or viewer), or change the role they have. Pass wallet as the `[wallet N]` reference from the user's message, exactly as it appears there. Giving access is public, so the user confirms it on a card. Removing someone isn't something you can do: send the user to the scene's Roles tab (open_page /scenes/<id>).",
    input: z.object({ sceneId: id(), wallet: z.string().trim().min(1).max(50), role: z.enum(ROLES) }),
    effect: 'public',
    refusals: { is_host: IS_HOST },
    call: async (a, ctx) => {
      const wallet = resolveWallet(a.wallet, ctx)
      if (!wallet) throw new ToolError(400, UNKNOWN_WALLET)
      return { method: 'POST', url: rolesUrl(a.sceneId), body: { wallet, role: a.role } }
    },
    before: async (a, ctx): Promise<Before> => {
      const { wallet, existing, orgName } = await state(ctx, a.sceneId, a.wallet)
      const undo = existing
        ? { method: 'POST' as const, url: rolesUrl(a.sceneId), body: { wallet, role: existing } }
        : { method: 'DELETE' as const, url: `${rolesUrl(a.sceneId)}/${wallet}` }
      return { undo, after: () => ({ wallet, role: a.role }), current: { wallet, role: existing }, orgName }
    },
    // Undo re-reads the role by the stored full wallet, not the `[wallet N]` arg: the undo routes have no conversation
    currentOf: async (after, a, ctx) => {
      const wallet = String((after as Obj | null)?.wallet ?? '').toLowerCase()
      if (!wallet) return null
      const roles = await get(ctx, rolesUrl(a.sceneId))
      const now = list(roles.roles).find((r) => String(r.wallet).toLowerCase() === wallet)
      return { wallet, role: (now?.role as Role | undefined) ?? null }
    },
    preview: async (a, ctx) => {
      const { wallet, existing, scene } = await state(ctx, a.sceneId, a.wallet)
      const who = shortWallet(wallet)
      const name = `"${scene.name}"`
      if (existing) return { detail: `${who} is ${ARTICLE[existing]} ${existing} on ${name}. They become ${a.role}: ${CAN[a.role as Role]}.` }
      return { detail: `Add ${who} to ${name} as ${a.role}: ${CAN[a.role as Role]}.` }
    },
    label: (a) => `Add a collaborator as ${a.role}`,
    summarize: (res) => pick((res as Obj)?.role ?? {}, ['wallet', 'role']),
  },
]
