import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { unlink, writeFile } from 'fs/promises'

/** How long one ffprobe run may take (a remote file is read over the network). */
export const PROBE_TIMEOUT_MS = 30_000

export type ProbeResult =
  | { ok: true; seconds: number }
  /** 'unavailable': ffprobe isn't installed or timed out (try again later); 'unreadable': it ran and found no length. */
  | { ok: false; reason: 'unavailable' | 'unreadable' }

/** ffprobe's `format=duration` output → seconds rounded to the millisecond, or null for anything but a positive length. */
export function parseDuration(stdout: string): number | null {
  const s = stdout.trim().split(/\s+/)[0] ?? ''
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  return n > 0 && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null
}

function ffprobe(input: string, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(
      process.env.FFPROBE_PATH || 'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', input],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null
        if (e && (e.code === 'ENOENT' || e.killed)) return resolve({ ok: false, reason: 'unavailable' })
        const seconds = e ? null : parseDuration(String(stdout))
        resolve(seconds === null ? { ok: false, reason: 'unreadable' } : { ok: true, seconds })
      },
    )
  })
}

/** The length of a video: a file's bytes (written to a temp file first) or a URL ffprobe can read. */
export async function probeDuration(input: Buffer | string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  if (typeof input === 'string') return ffprobe(input, timeoutMs)
  const path = join(tmpdir(), `virvi-probe-${randomUUID()}`)
  await writeFile(path, input)
  try {
    return await ffprobe(path, timeoutMs)
  } finally {
    await unlink(path).catch(() => {})
  }
}

export function isVideo(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('video/')
}
