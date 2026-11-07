// Plain-language copy for the deploy page's World destinations and the publish page.
import type { ImportLocation } from '@virvixr/shared'
import type { DclDeployment, DclDestination } from './api'
import { wizardErrorMessage } from './wizard/run'
import { shortAddress } from './wizard/helpers'
import { placeLabel } from './import'

/** "3 models are waiting to go live", or that nothing is. */
/** What's waiting to go live: a count of models, or the pending list (which may hold the scene thumbnail, LIV-88). */
export function pendingLine(pending: number | Array<{ kind?: 'thumbnail'; removed?: true }>): string {
  if (typeof pending === 'number') {
    if (pending === 0) return 'Every model in the scene is live.'
    return pending === 1 ? '1 model is waiting to go live' : `${pending} models are waiting to go live`
  }
  const thumb = pending.find((p) => p.kind === 'thumbnail')
  const models = pending.length - (thumb ? 1 : 0)
  if (!thumb) return models === 0 ? 'Everything in the scene is live.' : pendingLine(models)
  if (models === 0) return thumb.removed ? 'Removing the thumbnail is waiting to go live' : 'The new thumbnail is waiting to go live'
  const what = thumb.removed ? 'removing the thumbnail' : 'the new thumbnail'
  return `${models === 1 ? '1 model' : `${models} models`} and ${what} are waiting to go live`
}

export function modeLabel(dest: Pick<DclDestination, 'mode' | 'grantedAt'>): string {
  if (dest.mode === 'virvi') return dest.grantedAt ? 'Virvi deploys for you' : "Virvi deploys for you, once you've signed the permission"
  return 'You sign each deploy'
}

const STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger'; line: string }> = {
  ok: { label: 'Up to date', tone: 'success', line: '' },
  needs_review: {
    label: 'Needs a look',
    tone: 'warning',
    line: "Your World changed outside Virvi, so Virvi stopped instead of guessing. Check the World in Decentraland. If what's there is what you want, use the live version and Virvi builds on it from now on.",
  },
  over_budget: { label: 'Over the limit', tone: 'warning', line: "The scene is past Decentraland's limits for this plot, so it can't deploy until something is removed." },
  unreachable: { label: "Can't reach Decentraland", tone: 'danger', line: "Virvi couldn't read your World from Decentraland. It tries again on its own." },
}

/** The destination's status as a label and a sentence; the server's `statusDetail` when it says more. */
export function statusView(dest: Pick<DclDestination, 'status' | 'statusDetail'>): { label: string; tone: 'success' | 'warning' | 'danger'; line: string } {
  const s = STATUS[dest.status] ?? { label: dest.status, tone: 'warning' as const, line: '' }
  const detail = dest.statusDetail?.trim()
  // Short reasons ("Your World changed outside Virvi") only repeat the label; full sentences say more.
  if (!detail || !/[.!?]$/.test(detail)) return s
  return { ...s, line: detail }
}

const DEPLOY_STATUS: Record<string, string> = {
  pending: 'Waiting',
  building: 'Packing',
  deploying: 'Uploading',
  deployed: 'Live',
  failed: 'Failed',
  awaiting_signature: 'Waiting for your signature',
}

export const deploymentStatusLabel = (status: string) => DEPLOY_STATUS[status] ?? status

/** A deploy history entry's one-line summary: what it added. */
export function deploymentSummary(d: DclDeployment): string {
  const added = (d.assetBundle as { added?: unknown } | null)?.added
  const n = Array.isArray(added) ? added.length : null
  if (n === null) return ''
  return n === 0 ? 'No new models' : `${n} new ${n === 1 ? 'model' : 'models'}`
}

/** The deploy page's World deployments, newest first. */
export function destinationHistory<T extends { id: string; destinationId?: string | null }>(deployments: T[], destinationId: string): T[] {
  return deployments.filter((d) => d.destinationId === destinationId)
}

/**
 * The wallets that may sign a destination's deploys: its owner for a World; for Genesis City parcels, the `signers` the
 * server named. Null when any wallet may try (the parcels' signers couldn't be read from Decentraland).
 */
export function signerWallets(dest: { ownerWallet: string; signers?: string[] | null }): string[] | null {
  if (dest.signers === undefined) return [dest.ownerWallet]
  return dest.signers?.length ? dest.signers : null
}

/** A failure while signing: the wrong wallet names the owner's (a World) or the kind of wallet (parcels); everything else as in the wizard. */
export function signErrorMessage(err: unknown, dest: Pick<DclDestination, 'ownerWallet'> & { worldName: string | null; kind?: 'world' | 'parcels' }): string {
  if ((err as Error | null)?.name === 'WrongWalletError' && dest.kind === 'parcels') return 'Sign with a wallet that owns or operates these parcels.'
  if ((err as Error | null)?.name === 'WrongWalletError') return `Sign with ${shortAddress(dest.ownerWallet)}, the wallet that owns ${dest.worldName ?? 'this World'}.`
  return wizardErrorMessage(err)
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '--'
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Where a destination deploys: its World, or its Genesis City parcels (a parcels destination has no World name). */
export function destinationLocation(d: Pick<DclDestination, 'kind' | 'worldName' | 'base' | 'parcels'>): ImportLocation {
  return d.kind === 'parcels' ? { kind: 'parcels', base: d.base, parcels: d.parcels } : { kind: 'world', world: d.worldName ?? '' }
}

/** The publish page's words for a destination: a World by its name and owner, Genesis City parcels by their place. */
export function publishCopy(d: Pick<DclDestination, 'kind' | 'worldName' | 'base' | 'parcels'>): {
  place: string; subtitle: string; signWith: string; yours: string; notSigned: string
} {
  const loc = destinationLocation(d)
  const place = placeLabel(loc)
  if (loc.kind === 'parcels') {
    return {
      place,
      subtitle: 'Put the models you added live on your Genesis City parcels.',
      signWith: 'You sign once with a wallet that owns or operates these parcels.',
      yours: 'your parcels',
      notSigned: "These parcels are set to let Virvi deploy, but Virvi isn't an operator on them yet.",
    }
  }
  return {
    place,
    subtitle: 'Put the models you added live in your Decentraland World.',
    signWith: `You sign once with the wallet that owns ${place}.`,
    yours: 'your World',
    notSigned: "This World is set to let Virvi deploy, but the permission isn't signed yet.",
  }
}

/**
 * LIV-135: whether Decentraland built a map snapshot (its Initial Scene State) for what Virvi last deployed. Null when
 * that was never checked, or what's live now isn't the entity that was checked (Use the live version).
 */
export function mapView(d: Pick<DclDestination, 'kind' | 'lastEntityId' | 'mapStatus' | 'mapEntityId' | 'mapAssets'>): {
  line: string; tone: 'muted' | 'warning'; help: string
} | null {
  if (!d.mapStatus || d.mapStatus === 'unknown' || !d.mapEntityId || d.mapEntityId !== d.lastEntityId) return null
  const help = d.kind === 'parcels'
    ? 'The map photo itself only changes when Decentraland re-captures the map, which they do by hand now and then.'
    : "The map photo itself only changes when Decentraland re-captures the map (by hand, now and then), and Worlds don't have a satellite map yet."
  if (d.mapStatus === 'ready') {
    const n = d.mapAssets
    return { line: n == null ? 'Map data: ready' : `Map data: ready (${n} ${n === 1 ? 'model' : 'models'})`, tone: 'muted', help }
  }
  if (d.mapStatus === 'pending') return { line: 'Map data: waiting for Decentraland', tone: 'muted', help }
  return { line: "No map data — Decentraland didn't build a map snapshot for this deploy", tone: 'warning', help }
}
