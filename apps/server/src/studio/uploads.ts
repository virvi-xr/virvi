import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioUploads } from '../db/schema.js'
import { getStudioStore, uploadKey } from './store.js'
import type { Design } from './designs.js'
import sharp from 'sharp'

/**
 * Files the owner gives the agent: images (a logo for a shirt, a texture, a reference photo), 3D files and sounds (an
 * emote's own sound effect or track, or one to time the moves to). A file's
 * kind comes from its contents, never its name alone. Every prompt job lists the design's uploads (`uploadPaths`), and its worker
 * reads them through the inputs route into the workspace's uploads/ folder.
 */

export const UPLOAD_LIMITS = { imageBytes: 20 * 1024 * 1024, modelBytes: 25 * 1024 * 1024, audioBytes: 15 * 1024 * 1024, perDesign: 12 }
/** Bigger than an emote may ship (3 MB with its model): this is raw material, a voice memo's WAV, that the agent re-encodes. */
/** A vector logo or drawing becomes a picture this many pixels on its long side: a full texture's size. */
const SVG_PIXELS = 2048

type Prepared = { kind: 'image' | 'model' | 'audio'; contentType: string; ext: string; body: Buffer }
type Kind = Prepared['kind']

const ext = (name: string) => (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? '').toLowerCase()
const isGlb = (b: Buffer) => b.length >= 12 && b.toString('latin1', 0, 4) === 'glTF' && b.readUInt32LE(4) === 2

/** A 3D file Blender opens, from its contents (the name only picks between formats with the same contents). */
function model(b: Buffer, name: string): Prepared | null {
  const m = (contentType: string, e: string) => ({ kind: 'model' as const, contentType, ext: e, body: b })
  if (isGlb(b)) return ext(name) === 'vrm' ? m('model/gltf-binary', 'vrm') : m('model/gltf-binary', 'glb')
  if (b.toString('latin1', 0, 20) === 'Kaydara FBX Binary  ') return m('application/octet-stream', 'fbx')
  if (b.toString('latin1', 0, 7) === 'BLENDER') return m('application/x-blender', 'blend')
  // Binary STL: an 80-byte header, a triangle count, then 50 bytes a triangle
  if (ext(name) === 'stl' && b.length >= 84 && b.length === 84 + 50 * b.readUInt32LE(80)) return m('model/stl', 'stl')
  const head = b.subarray(0, 4096).toString('latin1')
  if (/^[\t\n\r\x20-\x7e]*$/.test(head)) {
    if (ext(name) === 'stl' && /^\s*solid\b/.test(head) && /\bfacet\b/.test(head)) return m('model/stl', 'stl')
    // OBJ: text whose lines are vertices and faces
    if (ext(name) === 'obj' && /^v\s+-?[\d.]/m.test(head) && /^f\s+\d/m.test(b.toString('latin1'))) return m('model/obj', 'obj')
  }
  return null
}

/** A sound, from its header, stored as it is. An MP4 box is audio only when the name says .m4a (a video has one too). */
function sound(b: Buffer, name: string): Prepared | null {
  const a = (contentType: string, e: string) => ({ kind: 'audio' as const, contentType, ext: e, body: b })
  if (b.length < 12) return null
  if (b.toString('latin1', 0, 3) === 'ID3') return a('audio/mpeg', 'mp3')
  if (isMp3Frames(b)) return a('audio/mpeg', 'mp3')
  if (b.toString('latin1', 0, 4) === 'OggS') return a('audio/ogg', 'ogg')
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return a('audio/wav', 'wav')
  if (b.toString('latin1', 4, 8) === 'ftyp' && ext(name) === 'm4a') return a('audio/mp4', 'm4a')
  return null
}

// Layer III bit rates (kbit/s) by bitrate index, and sample rates (Hz) by index, for MPEG-1; MPEG-2 and 2.5 differ
const L3_KBPS = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] }
const RATES = [44100, 48000, 32000]

/** An MPEG Layer III frame header at `at`: its length in bytes, or 0 when it isn't one. */
function l3Frame(b: Buffer, at: number): number {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return 0
  const version = (b[at + 1] >> 3) & 3 // 3 MPEG-1, 2 MPEG-2, 0 MPEG-2.5, 1 reserved
  const layer = (b[at + 1] >> 1) & 3 // 1 is Layer III
  const bitrate = b[at + 2] >> 4
  const rate = (b[at + 2] >> 2) & 3
  if (version === 1 || layer !== 1 || bitrate === 0 || bitrate === 15 || rate === 3) return 0
  const mpeg1 = version === 3
  const hz = RATES[rate] / (mpeg1 ? 1 : version === 2 ? 2 : 4)
  return Math.floor(((mpeg1 ? 144 : 72) * L3_KBPS[mpeg1 ? 1 : 2][bitrate] * 1000) / hz) + ((b[at + 2] >> 1) & 1)
}

/** An MP3 without an ID3 tag: a valid frame header, and another where the first frame ends (text or noise that merely starts FF Ex doesn't). */
function isMp3Frames(b: Buffer): boolean {
  const first = l3Frame(b, 0)
  return first > 0 && l3Frame(b, first) > 0
}

const LIMIT: Record<Kind, number> = { image: UPLOAD_LIMITS.imageBytes, model: UPLOAD_LIMITS.modelBytes, audio: UPLOAD_LIMITS.audioBytes }

/** Pixels sharp will decode at all: a 64-megapixel photo, not a decompression bomb. */
const MAX_INPUT_PIXELS = 64_000_000
/** The long side of a stored image: as big as any Decentraland texture needs. */
const MAX_SIDE = 4096

export class UploadError extends Error {
  constructor(public status: number, public code: string) {
    super(code)
  }
}

/**
 * The file as it is stored: PNG, JPEG and WebP images as they are (shrunk to 4096 px on the long side when bigger);
 * GIF, TIFF, AVIF and SVG (a logo, often) as PNG, so the agent and the page can always open them; 3D files as they
 * are. Null when it is neither; UploadError when it is an image too big to decode.
 */
export async function prepareUpload(b: Buffer, name: string): Promise<Prepared | null> {
  if (!b.length) return null
  const asModel = model(b, name)
  if (asModel) return asModel
  const asSound = sound(b, name)
  if (asSound) return asSound
  const opts = { failOn: 'error' as const, limitInputPixels: MAX_INPUT_PIXELS }
  let meta: sharp.Metadata
  try {
    meta = await sharp(b, { failOn: 'error' }).metadata() // the header only: nothing is decoded yet
  } catch {
    return null
  }
  const keep: Record<string, [string, string]> = { png: ['image/png', 'png'], jpeg: ['image/jpeg', 'jpg'], webp: ['image/webp', 'webp'] }
  if (!meta.format || !['png', 'jpeg', 'webp', 'gif', 'tiff', 'heif', 'svg'].includes(meta.format)) return null
  if (meta.format !== 'svg' && (meta.width ?? 0) * (meta.height ?? 0) > MAX_INPUT_PIXELS) throw new UploadError(413, 'image_too_large')
  const fit = { width: MAX_SIDE, height: MAX_SIDE, fit: 'inside' as const, withoutEnlargement: true }
  try {
    if (meta.format === 'svg') {
      // Drawn big enough, then scaled to fill: a 24-unit icon and a 2000-unit drawing both come out 2048 px long
      const long = Math.max(meta.width ?? 0, meta.height ?? 0) || SVG_PIXELS
      const drawn = await sharp(b, { ...opts, density: Math.min(2400, Math.max(1, (72 * SVG_PIXELS) / long)) }).png().toBuffer()
      const body = await sharp(drawn, opts).resize({ width: SVG_PIXELS, height: SVG_PIXELS, fit: 'inside' }).png().toBuffer()
      return { kind: 'image', contentType: 'image/png', ext: 'png', body }
    }
    const single = !(meta.pages && meta.pages > 1)
    const big = Math.max(meta.width ?? 0, meta.height ?? 0) > MAX_SIDE
    if (keep[meta.format] && single) {
      const [contentType, e] = keep[meta.format]
      if (!big) return { kind: 'image', contentType, ext: e, body: b }
      const body = await sharp(b, opts).rotate().resize(fit).toFormat(meta.format as keyof sharp.FormatEnum).toBuffer()
      return { kind: 'image', contentType, ext: e, body }
    }
    // An animation's first frame; TIFF, AVIF and the rest as PNG
    const body = await sharp(b, { ...opts, pages: 1 }).rotate().resize(fit).png().toBuffer()
    return { kind: 'image', contentType: 'image/png', ext: 'png', body }
  } catch (err) {
    if (/pixel limit/i.test(String((err as Error).message))) throw new UploadError(413, 'image_too_large')
    return null // e.g. an HEIC photo: the standard sharp build can't decode it
  }
}

/** A safe file name for the agent's folder: the base name's letters, digits, dots and dashes, with the real extension. */
export function cleanName(raw: string, ext: string, kind: Kind = 'image'): string {
  const base = (raw.split(/[\\/]/).pop() ?? '').replace(/\.[^.]*$/, '')
  // The worker's rule (jobs.py UPLOAD_NAME): starts with a letter or digit, no doubled dots
  const stem = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '').slice(0, 60).replace(/[-._]+$/, '')
  return `${stem || { image: 'image', model: 'model', audio: 'sound' }[kind]}.${ext}`
}

export const publicUpload = (u: typeof studioUploads.$inferSelect) =>
  ({ id: u.id, name: u.name, kind: u.kind, contentType: u.contentType, size: u.size, createdAt: u.createdAt })

export async function addUpload(design: Design, rawName: string, body: Buffer) {
  if (design.archivedAt) throw new UploadError(409, 'archived')
  if (body.length > Math.max(...Object.values(LIMIT))) throw new UploadError(413, 'file_too_large')
  const sniffed = await prepareUpload(body, rawName)
  if (!sniffed) throw new UploadError(400, 'unsupported_file')
  // Checked on what is stored, which for a converted image is the converted file
  if (sniffed.body.length > LIMIT[sniffed.kind]) throw new UploadError(413, 'file_too_large')

  const row = await db.transaction(async (tx) => {
    // Serialize a design's uploads so the count and the name stay right under concurrent requests
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`studio-uploads:${design.id}`}))`)
    const existing = await tx.select({ name: studioUploads.name }).from(studioUploads).where(eq(studioUploads.designId, design.id))
    if (existing.length >= UPLOAD_LIMITS.perDesign) throw new UploadError(409, 'too_many_uploads')
    const taken = new Set(existing.map((e) => e.name.toLowerCase()))
    const first = cleanName(rawName, sniffed.ext, sniffed.kind)
    let name = first
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = first.replace(/(\.[a-z]+)$/, `-${n}$1`)
    const [u] = await tx.insert(studioUploads).values({
      designId: design.id, name, kind: sniffed.kind, contentType: sniffed.contentType, size: sniffed.body.length,
    }).returning()
    return u
  })
  // Stored after the commit, so no connection waits on the bucket; a failed put takes its row back out
  try {
    await getStudioStore().put(uploadKey(design.id, row.id), sniffed.body, sniffed.contentType)
  } catch (err) {
    await db.delete(studioUploads).where(eq(studioUploads.id, row.id))
    throw err
  }
  return publicUpload(row)
}

export async function listUploads(designId: string) {
  return db.select().from(studioUploads).where(eq(studioUploads.designId, designId)).orderBy(asc(studioUploads.createdAt), asc(studioUploads.id))
}

export async function findUpload(designId: string, uploadId: string) {
  const [u] = await db.select().from(studioUploads).where(and(eq(studioUploads.designId, designId), eq(studioUploads.id, uploadId)))
  return u ?? null
}

export async function deleteUpload(designId: string, uploadId: string): Promise<boolean> {
  const [gone] = await db.delete(studioUploads)
    .where(and(eq(studioUploads.designId, designId), eq(studioUploads.id, uploadId))).returning({ id: studioUploads.id })
  if (!gone) return false
  await getStudioStore().deletePrefix(uploadKey(designId, uploadId))
  return true
}

/** What a prompt job lists for its worker: the input path to read, the name the agent sees, and its kind. */
export async function uploadPaths(designId: string, exec: Pick<typeof db, 'select'> = db) {
  const rows = await exec.select().from(studioUploads).where(eq(studioUploads.designId, designId))
    .orderBy(asc(studioUploads.createdAt), asc(studioUploads.id))
  return rows.map((u) => ({ path: `uploads/${u.id}/${u.name}`, name: u.name, kind: u.kind }))
}
