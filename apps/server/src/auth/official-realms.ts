import { config } from '../config.js'
import { getDclDirectory } from '../analytics/dcl-directory.js'
import type { SceneRequestContext } from '../middleware/dcl-auth.js'

/**
 * Which realms may bind a scene pass. `realm.serverName`, the parcel and the scene code all come from
 * the realm the player is connected to, so only Decentraland's own realms are believed.
 *
 * The explorer (unity-explorer RealmController.ResolveHostname) fills `realm.hostname` as:
 * - a World (ENS realm name): `{host}{path}` of the realm URL, e.g. `worlds-content-server.decentraland.org/world/name.dcl.eth`,
 *   or, in current explorers, `gateway.decentraland.org/worlds-content-server/world/name.dcl.eth`;
 * - a realm with its own comms (a catalyst): the realm URL's host, e.g. `peer-ec1.decentraland.org`;
 * - the main realm (no comms in /about): `realm-provider.decentraland.org`.
 * Older explorers send the bare host (ADR-289 example: `peer.decentraland.org`).
 */

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** Genesis City realm hosts Decentraland operates (realm provider, early-access realm provider, catalyst load balancer). */
export const DCL_GENESIS_HOSTS = ['realm-provider.decentraland.org', 'realm-provider-ea.decentraland.org', 'peer.decentraland.org']

/** Used only when the DAO catalyst list can't be fetched: the Decentraland-run DAO catalysts as of 2026-10-16. */
export const FALLBACK_CATALYST_HOSTS = ['peer-ec1.decentraland.org', 'peer-ec2.decentraland.org', 'peer-ap1.decentraland.org', 'peer-eu1.decentraland.org']

/** The Worlds content server, which is also the Worlds realm host. */
export const DCL_WORLDS_HOSTS = ['worlds-content-server.decentraland.org']

/** Decentraland's gateway, which current explorers report for Worlds as `gateway.decentraland.org/worlds-content-server/world/<name>`. */
export const DCL_WORLDS_GATEWAY = { host: 'gateway.decentraland.org', pathPrefix: '/worlds-content-server' }

// Current explorers also report the main realm as the bare gateway host (seen live 2026-11-14 on the studio parcel); with
// a path it is a World or nothing, which the World branch and DNS_NAME handle.
const genesisHosts = () => new Set([...DCL_GENESIS_HOSTS, DCL_WORLDS_GATEWAY.host, hostOf(config.catalystUrl)].filter(Boolean) as string[])
const worldsHosts = () => new Set([...DCL_WORLDS_HOSTS, hostOf(config.worldsUrl)].filter(Boolean) as string[])

// A plain DNS name: no scheme, port, path, whitespace or trailing dot.
const DNS_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

export const isWorldRealm = (ctx: SceneRequestContext) => ctx.realm.serverName.toLowerCase().endsWith('.eth')

async function catalystHosts(): Promise<string[]> {
  try {
    return await getDclDirectory().getCatalystHosts()
  } catch {
    return FALLBACK_CATALYST_HOSTS
  }
}

/** True only when the signed realm is an official Decentraland realm of the right kind (World vs Genesis City). */
export async function isOfficialRealm(ctx: SceneRequestContext): Promise<boolean> {
  const raw = ctx.realm.hostname.toLowerCase()
  if (isWorldRealm(ctx)) {
    const slash = raw.indexOf('/')
    const host = slash < 0 ? raw : raw.slice(0, slash)
    const path = slash < 0 ? '' : raw.slice(slash).replace(/\/$/, '')
    if (!DNS_NAME.test(host)) return false
    const worldPath = `/world/${ctx.realm.serverName.toLowerCase()}`
    // Through the gateway, the path must be exactly the Worlds server's path to this World.
    if (host === DCL_WORLDS_GATEWAY.host) return path === `${DCL_WORLDS_GATEWAY.pathPrefix}${worldPath}`
    if (!worldsHosts().has(host)) return false
    // When the explorer reports the World path, it must name the same World as serverName.
    return path === '' || path === worldPath
  }
  if (!DNS_NAME.test(raw)) return false
  if (genesisHosts().has(raw)) return true
  return (await catalystHosts()).includes(raw)
}
