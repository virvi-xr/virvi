import type { FastifyInstance } from 'fastify'
import { cleanDisplayName } from '@virvixr/shared'
import { config } from '../config.js'
import type { SessionClaims } from './tokens.js'
import type { SessionUser } from './sessions.js'
import type { SceneBinding } from './scene-binding.js'

export function sceneClaims(user: { id: string; role: string }, wallet: string | null, b: SceneBinding): SessionClaims {
  return { id: user.id, email: null, role: user.role, orgId: null, wallet, verified: true, kind: 'scene', sceneId: b.sceneId, locationId: b.locationId }
}

/**
 * A scene pass: acts as the wallet's user only inside the bound scene (sceneId null = visitor).
 * No refresh token: a pass lives 15 min past the last signed request, so one taken by a hostile realm dies soon after the player leaves.
 */
export function issueScenePass(app: FastifyInstance, user: SessionUser, wallet: string, b: SceneBinding, expiresAt?: Date, signInName?: string) {
  // signInName: the Decentraland name this sign-in came with, cleaned and capped as raffle entries store it (LIV-55)
  const claims: SessionClaims = { ...sceneClaims(user, wallet, b), ...(signInName ? { displayName: cleanDisplayName(signInName, wallet) } : {}) }
  return {
    user: { id: user.id, displayName: user.displayName, email: null, role: user.role },
    // expiresAt (hand-off): never later than the pass the code was minted from. A number here is seconds.
    accessToken: app.jwt.sign(claims, { expiresIn: expiresAt ? Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) : config.jwtAccessExpiry }),
    refreshToken: null,
    scene: b,
  }
}

/**
 * The studio scene's pass: the wallet's user, bound to no scene, for the studio routes only (`scenePass.studio`).
 * Lives `config.jwtAccessExpiry` with no refresh token, like a scene pass. Its hand-off mints the checkout link.
 */
export function issueStudioPass(app: FastifyInstance, user: SessionUser, wallet: string) {
  const claims: SessionClaims = { ...sceneClaims(user, wallet, { sceneId: null, locationId: null }), via: 'studio' }
  return {
    user: { id: user.id, displayName: user.displayName, email: null, role: user.role },
    accessToken: app.jwt.sign(claims, { expiresIn: config.jwtAccessExpiry }),
    refreshToken: null,
    scene: { sceneId: null, locationId: null } as SceneBinding,
  }
}

/**
 * A Hyperfy HUD pass: a scene pass for the world's scene, tied to a pairing so revoking the pairing kills it at once.
 * The wallet is the approving user's verified wallet, or null. No refresh token: the HUD renews through its pairing.
 */
export function issueHyperfyPass(
  app: FastifyInstance,
  user: { id: string; role: string },
  wallet: string | null,
  pairing: { id: string; worldId: string; sceneId: string },
): { pass: string; passExpiresAt: Date } {
  const claims: SessionClaims = { ...sceneClaims(user, wallet, { sceneId: pairing.sceneId, locationId: null }), via: 'hyperfy', pairingId: pairing.id, worldId: pairing.worldId }
  const pass = app.jwt.sign(claims, { expiresIn: config.jwtAccessExpiry })
  const exp = (app.jwt.decode(pass) as { exp: number }).exp
  return { pass, passExpiresAt: new Date(exp * 1000) }
}

/**
 * An AR headset pass: a scene pass for one scene, tied to a paired headset so revoking it (or ending a shared
 * headset's session) kills the pass at once. Lives `config.jwtAccessExpiry`, never past `notAfter` (the headset's own
 * expiry). The wallet is the approving user's verified wallet, or null. No refresh token: the headset mints a new one.
 */
export function issueArPass(
  app: FastifyInstance,
  user: { id: string; role: string },
  wallet: string | null,
  b: { deviceId: string; sceneId: string; notAfter?: Date },
  now = new Date(),
): { pass: string; passExpiresAt: Date } {
  const claims: SessionClaims = { ...sceneClaims(user, wallet, { sceneId: b.sceneId, locationId: null }), via: 'ar', deviceId: b.deviceId }
  // Signed against the caller's clock (iat), so the pass and the headset's expiry are measured from the same now.
  const stamped: SessionClaims & { iat: number } = { ...claims, iat: Math.floor(now.getTime() / 1000) }
  let pass = app.jwt.sign(stamped, { expiresIn: config.jwtAccessExpiry })
  let exp = (app.jwt.decode(pass) as { exp: number }).exp
  if (b.notAfter && exp * 1000 > b.notAfter.getTime()) {
    // A number here is seconds.
    pass = app.jwt.sign(stamped, { expiresIn: Math.max(1, Math.floor((b.notAfter.getTime() - now.getTime()) / 1000)) })
    exp = (app.jwt.decode(pass) as { exp: number }).exp
  }
  return { pass, passExpiresAt: new Date(exp * 1000) }
}
