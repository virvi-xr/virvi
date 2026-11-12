import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'

/**
 * Signed, short-lived URLs for render frames: the only studio files a browser ever receives. The token names one
 * frame; the server builds the store key from its verified fields, so no token can reach a GLB, checker report or
 * workspace.
 */

export type RenderFrame = { designId: string; revisionId: string; viewKey: string; category: string; frame: number; jobId: string }

export const RENDER_URL_TTL_MS = 3600_000

/** Expiries fall on the hour, one to two hours out, so re-reading a design gives the same URLs and the browser cache holds. */
export function frameUrlExpiry(now: Date): Date {
  return new Date(Math.ceil(now.getTime() / RENDER_URL_TTL_MS) * RENDER_URL_TTL_MS + RENDER_URL_TTL_MS)
}

const key = () => createHmac('sha256', config.jwtSecret).update('studio-render-frames').digest()
const mac = (body: string) => createHmac('sha256', key()).update(body).digest('base64url')

export function signRenderFrame(f: RenderFrame, expiresAt: Date): string {
  const body = Buffer.from(JSON.stringify({
    d: f.designId, r: f.revisionId, v: f.viewKey, c: f.category, f: f.frame, j: f.jobId, e: expiresAt.getTime(),
  })).toString('base64url')
  return `${config.publicUrl}/api/studio/render-frames/${body}.${mac(body)}`
}

export function verifyRenderFrame(token: string, now: Date): RenderFrame | null {
  const [body, sig, extra] = token.split('.')
  if (!body || !sig || extra !== undefined) return null
  const want = Buffer.from(mac(body))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  let c: Record<string, unknown>
  try {
    c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof c.e !== 'number' || c.e <= now.getTime()) return null
  const str = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 100
  if (!str(c.d) || !str(c.r) || !str(c.v) || !str(c.c) || !str(c.j)) return null
  if (!Number.isInteger(c.f) || (c.f as number) < 0 || (c.f as number) > 999) return null
  return { designId: c.d as string, revisionId: c.r as string, viewKey: c.v as string, category: c.c as string, frame: c.f as number, jobId: c.j as string }
}

/** The frame's path in its job's files, as the contract names it. */
export const framePath = (f: Pick<RenderFrame, 'category' | 'viewKey' | 'frame'>) =>
  `renders/${f.category}/${f.viewKey}/${String(f.frame).padStart(3, '0')}.webp`

/** The frame's PNG (the server's own conversion, for Decentraland), stored beside its WebP on first request. */
export const framePngPath = (f: Pick<RenderFrame, 'category' | 'viewKey' | 'frame'>) => framePath(f).replace(/\.webp$/, '.png')

/**
 * An emote revision's sound, for the studio's previews: signed like a frame, under its own key, naming one revision's
 * sound file; the route checks the revision still lists it. The file name goes on the end so players know the type.
 */
export type PieceSound = { designId: string; revisionId: string; jobId: string; path: string }

const soundKey = () => createHmac('sha256', config.jwtSecret).update('studio-piece-sounds').digest()
const soundMac = (body: string) => createHmac('sha256', soundKey()).update(body).digest('base64url')

export function signPieceSound(s: PieceSound, expiresAt: Date): string {
  const body = Buffer.from(JSON.stringify({ d: s.designId, r: s.revisionId, j: s.jobId, p: s.path, e: expiresAt.getTime() })).toString('base64url')
  return `${config.publicUrl}/api/studio/piece-sounds/${body}.${soundMac(body)}/${s.path.split('/').pop()}`
}

export function verifyPieceSound(token: string, now: Date): PieceSound | null {
  const [signed, name, extra] = token.split('/')
  if (!signed || !name || extra !== undefined) return null
  const [body, sig, more] = signed.split('.')
  if (!body || !sig || more !== undefined) return null
  const want = Buffer.from(soundMac(body))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  let c: Record<string, unknown>
  try {
    c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof c.e !== 'number' || c.e <= now.getTime()) return null
  const str = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 200
  if (!str(c.d) || !str(c.r) || !str(c.j) || !str(c.p) || (c.p as string).split('/').pop() !== name) return null
  return { designId: c.d as string, revisionId: c.r as string, jobId: c.j as string, path: c.p as string }
}
