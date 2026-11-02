import type { FastifyRequest } from 'fastify'
import { HUD_PROTOCOL_HEADER } from '@virvixr/shared'

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** The protocol a HUD sent (`x-virvi-hud-protocol`); 0 when absent or not a whole number, as for HUDs from before the header. */
export function hudProtocolOf(request: FastifyRequest): number {
  const raw = request.headers[HUD_PROTOCOL_HEADER]
  const n = Number(Array.isArray(raw) ? raw[0] : raw)
  return Number.isInteger(n) && n >= 0 ? n : 0
}

/**
 * True when a Decentraland HUD below the minimum tries to write: the scene must be redeployed to edit.
 * Only Decentraland scene passes (no `via`) are checked; the dashboard, API keys, Hyperfy and headsets never are.
 * Reads always pass, so an old HUD keeps showing the scene.
 */
export function dclHudNeedsRedeploy(request: FastifyRequest, pass: { kind?: string; via?: string }, minProtocol: number): boolean {
  if (pass.kind !== 'scene' || pass.via) return false
  if (READS.has(request.method)) return false
  return hudProtocolOf(request) < minProtocol
}
