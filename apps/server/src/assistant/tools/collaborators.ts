// Scene collaborators (phase 2c): who has a role on a scene, and adding or changing one. Adding someone gives them access
// to the scene, so it is a public card. Wallets reach the model only as `[wallet N]` references (resolveWallet) or, for
// someone already on the scene, the short form list_scene_collaborators gives; removing someone is done on the Roles tab.
import { createHash } from 'node:crypto'
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
const SHORT = /^0x([0-9a-f]{4})(?:…|\.\.\.)([0-9a-f]{4})$/i
const NOT_ON_SCENE = "That wallet doesn't have a role on this scene now. Ask the user to paste it."
const CHANGED = 'The collaborators changed since the card. Ask again.'
/** The card's person, as a hash of the full wallet: the press must reach the same wallet, not one sharing its short form. */
const pinOf = (wallet: string) => createHash('sha256').update(wallet.toLowerCase()).digest('hex').slice(0, 32)
const AMBIGUOUS = 'More than one collaborator has that short wallet. Ask the user to paste the wallet.'

const rolesUrl = (sceneId: string) => `/api/scenes/${sceneId}/roles`
const activeRoles = async (ctx: ToolCtx, sceneId: string) => list((await get(ctx, rolesUrl(sceneId))).roles)

/**
 * The full wallet an argument names: a `[wallet N]` reference or the user's own wallet (resolveWallet), or the short
 * form of someone who already has a role on this scene. A short form only ever matches a current collaborator, so it
 * changes a role and never adds anyone new.
 */
async function walletFor(ctx: ToolCtx, sceneId: string, value: string): Promise<string> {
  const direct = resolveWallet(value, ctx)
  if (direct) return direct
  const m = SHORT.exec(value.trim())
  if (!m) throw new ToolError(400, UNKNOWN_WALLET)
  const [head, tail] = [`0x${m[1]}`.toLowerCase(), m[2].toLowerCase()]
  const matches = (await activeRoles(ctx, sceneId)).map((r) => String(r.wallet).toLowerCase()).filter((w) => w.startsWith(head) && w.endsWith(tail))
  if (matches.length > 1) throw new ToolError(409, AMBIGUOUS)
  if (!matches.length) throw new ToolError(400, NOT_ON_SCENE)
  return matches[0]
}

/** The wallet the user meant, the scene's roles as the route gives them (unredacted: this is server side), and the scene. */
async function state(ctx: ToolCtx, sceneId: string, value: string, pin?: string) {
  const wallet = await walletFor(ctx, sceneId, value)
  if (pin && pinOf(wallet) !== pin) throw new ToolError(409, CHANGED)
  const roles = await get(ctx, rolesUrl(sceneId))
  if (list(roles.host?.wallets).some((w) => String(w).toLowerCase() === wallet)) throw new ToolError(409, IS_HOST)
  const existing = list(roles.roles).find((r) => String(r.wallet).toLowerCase() === wallet)
  const { scene, orgName } = await sceneState(ctx, sceneId)
  return { wallet, existing: (existing?.role as Role | undefined) ?? null, scene, orgName }
}

export const COLLABORATOR_TOOLS: ToolDef<any>[] = [
  {
    name: 'list_scene_collaborators',
    description:
      "Who has a role on a scene besides its host: each person's short wallet, role (cohost, editor or viewer), their name when they have signed in, and whether they have. To change someone's role, pass their short wallet to add_scene_collaborator.",
    input: z.object({ sceneId: id() }),
    effect: 'read',
    call: (a) => ({ method: 'GET', url: rolesUrl(a.sceneId) }),
    label: () => "List the scene's collaborators",
    summarize: (res) => {
      const o = (res ?? {}) as Obj
      return {
        host: pick(o.host ?? {}, ['displayName']),
        roles: list(o.roles).map((r) => ({ wallet: shortWallet(String(r.wallet).toLowerCase()), ...pick(r, ['role', 'displayName']), signedIn: Boolean(r.userId) })),
      }
    },
  },
  {
    name: 'add_scene_collaborator',
    description:
      "Give someone a role on a scene (cohost, editor or viewer), or change the role they have. Pass wallet as the `[wallet N]` reference from the user's message, exactly as it appears there, or, for someone already on the scene, their short wallet from list_scene_collaborators. Giving access is public, so the user confirms it on a card. Removing someone isn't something you can do: send the user to the scene's Roles tab (open_page /scenes/<id>).",
    input: z.object({
      sceneId: id(),
      wallet: z.string().trim().min(1).max(50),
      role: z.enum(ROLES),
      pin: z.string().regex(/^[0-9a-f]{32}$/).optional().describe('Leave this out: the card fills it in.'),
    }),
    effect: 'public',
    refusals: { is_host: IS_HOST },
    call: async (a, ctx) => {
      const wallet = await walletFor(ctx, a.sceneId, a.wallet)
      if (a.pin && pinOf(wallet) !== a.pin) throw new ToolError(409, CHANGED)
      return { method: 'POST', url: rolesUrl(a.sceneId), body: { wallet, role: a.role } }
    },
    before: async (a, ctx): Promise<Before> => {
      const { wallet, existing, orgName } = await state(ctx, a.sceneId, a.wallet, a.pin)
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
      const bind = { pin: pinOf(wallet) }
      if (existing) return { detail: `${who} is ${ARTICLE[existing]} ${existing} on ${name}. They become ${a.role}: ${CAN[a.role as Role]}.`, bind }
      return { detail: `Add ${who} to ${name} as ${a.role}: ${CAN[a.role as Role]}.`, bind }
    },
    // Neutral: the same card adds someone or changes their role (the detail line says which)
    label: (a) => `Make a collaborator ${ARTICLE[a.role as Role]} ${a.role}`,
    summarize: (res) => pick((res as Obj)?.role ?? {}, ['wallet', 'role']),
  },
]
