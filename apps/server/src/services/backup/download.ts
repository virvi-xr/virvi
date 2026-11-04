/**
 * Running a backup build for the download route: at most BACKUP_MAX_CONCURRENT at once server-wide (a build holds its
 * files in memory, from its downloads until its zip has been sent), and each build within BACKUP_DEADLINE_MS.
 */
import { BackupError, backupProject, type BackupFetcher, type BackupOptions } from './project.js'

export const BACKUP_MAX_CONCURRENT = 2
export const BACKUP_DEADLINE_MS = 5 * 60_000

const BUSY = 'Virvi is putting together other backups right now. Try again in a minute.'
const TIMEOUT = 'This backup took too long to put together. Try again in a few minutes.'

let limits = { maxConcurrent: BACKUP_MAX_CONCURRENT, deadlineMs: BACKUP_DEADLINE_MS }
let fetcher: BackupFetcher | null = null
let running = 0

/** Test hook: other limits (or null for the defaults). */
export function setBackupLimits(l: Partial<typeof limits> | null) {
  limits = { maxConcurrent: BACKUP_MAX_CONCURRENT, deadlineMs: BACKUP_DEADLINE_MS, ...l }
}
/** Test hook: where backup files come from, given each file's cap and kind (or null for the real, Virvi-hosted-only fetcher). */
export function setBackupFetcher(f: BackupFetcher | null) {
  fetcher = f
}

export type BackupRun = Awaited<ReturnType<typeof backupProject>> & {
  /** Gives the slot back: call it once the files are no longer needed (the response closed, or wasn't sent). Repeat calls do nothing. */
  release: () => void
}

/**
 * backupProject under the limits. Throws BackupError 429 `backup_busy` when the slots are taken, 504 `backup_timeout`
 * past the deadline (the deadline aborts the build's downloads; its slot comes back once it winds down). A build that
 * fails gives its slot back; one that succeeds keeps it until its caller calls `release`.
 */
export async function runBackup(sceneId: string, opts: Omit<BackupOptions, 'signal' | 'fetch'>): Promise<BackupRun> {
  if (running >= limits.maxConcurrent) throw new BackupError(429, 'backup_busy', BUSY)
  running++
  let released = false
  const release = () => {
    if (released) return
    released = true
    running--
  }
  const abort = new AbortController()
  const build = backupProject(sceneId, { ...opts, signal: abort.signal, ...(fetcher ? { fetch: fetcher } : {}) })
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new BackupError(504, 'backup_timeout', TIMEOUT))
      abort.abort(new Error('backup deadline passed'))
    }, limits.deadlineMs)
  })
  try {
    return { ...(await Promise.race([build, deadline])), release }
  } catch (err) {
    // A build that lost the race gives its slot back when it winds down; a failed one already has
    build.then(release, release)
    throw err
  } finally {
    clearTimeout(timer)
  }
}
