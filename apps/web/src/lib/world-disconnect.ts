// Disconnecting a Decentraland World from the Virvi scene that holds it: what the wizard says when the World it picked
// is connected to another scene (409 world_in_use, or the World lookups' `connectedScene`), and the copy of the
// disconnect itself on the wizard and on the scene's Deploy page. Disconnecting changes nothing in Decentraland.
import type { ConnectedScene } from './api'

export const DISCONNECT_ACTION = 'Disconnect it and use this World'

/** What to show for a World connected to another scene: a disconnect the caller may do, or who has to do it. */
export type WorldInUseView =
  | { kind: 'disconnect'; text: string; action: string; confirm: string; destinationId: string; sceneHref: string; sceneName: string }
  | { kind: 'blocked'; text: string }

/**
 * Null when the World isn't connected to a scene, or is connected to `ownSceneId` (the scene this run already made).
 * The other scene is named only when the server named it (the caller can see it).
 */
export function worldInUseView(world: string, c: ConnectedScene | null | undefined, ownSceneId?: string | null): WorldInUseView | null {
  if (!c) return null
  if ('sceneId' in c && ownSceneId && c.sceneId === ownSceneId) return null
  if (c.canDisconnect) {
    return {
      kind: 'disconnect',
      text: `${world} is connected to your scene “${c.name}”.`,
      action: DISCONNECT_ACTION,
      confirm: disconnectFromWizardPrompt(world, c.name),
      destinationId: c.destinationId,
      sceneHref: `/scenes?id=${c.sceneId}`,
      sceneName: c.name,
    }
  }
  if (c.name !== null) {
    return {
      kind: 'blocked',
      text: `${world} is connected to the scene “${c.name}”. Only its owner or a co-host can disconnect it: ask them to, then try again.`,
    }
  }
  return {
    kind: 'blocked',
    text: `${world} is connected to a scene in another Virvi account. That scene's owner needs to disconnect it before you can use this World.`,
  }
}

/** The holder from a 409 world_in_use error (an older server sends no `connectedScene`: nothing named); null for any other error. */
export function connectedSceneFromError(err: unknown): ConnectedScene | null {
  const body = (err as { body?: { error?: unknown; connectedScene?: ConnectedScene | null } } | null)?.body
  if (body?.error !== 'world_in_use') return null
  return body.connectedScene ?? { name: null, canDisconnect: false }
}

/** The wizard's confirm, before disconnecting `world` from the other scene `name`. */
export function disconnectFromWizardPrompt(world: string, name: string): string {
  return `Disconnect ${world} from “${name}”? What’s live in ${world} stays there until this new scene deploys over it. ` +
    `“${name}” keeps its models and deploy history, but Virvi stops deploying “${name}” to ${world}.`
}

/**
 * The Deploy page's confirm. `revokeLabel`: the card's button that removes Virvi's deploy permission, as it reads right
 * now ("Switch to signing each deploy" with the grant, "Remove Virvi's permission" after a partial one); null without one.
 */
export function disconnectFromCardPrompt(world: string, revokeLabel: string | null): string {
  const base = `Disconnect ${world} from this scene? ${world} keeps showing this scene until something else is deployed there. ` +
    'Virvi stops redeploying to it, and you can connect the World to another scene.'
  return revokeLabel
    ? `${base} Virvi keeps its permission to deploy to ${world} until you remove it: use “${revokeLabel}” first, ` +
      "or remove Virvi later under the World's permissions in the Creator Hub."
    : base
}

/** Whether the Deploy page offers the disconnect: full access only (owner or co-host; no relationship listed means owner). */
export function canDisconnectScene(relationship: string | null | undefined): boolean {
  return !relationship || relationship === 'owner' || relationship === 'cohost'
}

/**
 * After the wizard disconnected the World from the other scene: carry on with the run, unless the World turned out to
 * have a scene the user hasn't agreed to replace (the pick didn't know of it), which is asked first.
 */
export function afterDisconnect(replaceAgreed: boolean, fresh: { hasScene: boolean }): 'run' | 'confirm_replace' {
  return fresh.hasScene && !replaceAgreed ? 'confirm_replace' : 'run'
}

/** Shown once the disconnect went through: the server's permission sentence when Virvi keeps one. */
export function disconnectedNotice(res: { world: string; grantKept: boolean; message?: string }): string {
  const done = `${res.world} is disconnected from this scene.`
  return res.grantKept && res.message ? `${done} ${res.message}` : done
}
