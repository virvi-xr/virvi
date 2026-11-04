/**
 * Running a backup build for the download route: at most BACKUP_MAX_CONCURRENT at once server-wide (a build holds its
 * files in memory and fetches them one by one), and each within BACKUP_DEADLINE_MS.
 */
import { defaultModelFetcher, type ModelFetcher } from '../dcl/assemble.js'
import { BackupError, backupProject } from './project.js'

export const BACKUP_MAX_CONCURRENT = 2
export const BACKUP_DEADLINE_MS = 5 * 60_000

const BUSY = 'Virvi is putting together other backups right now. Try again in a minute.'
const TIMEOUT = 'This backup took too long to put together. Try again in a few minutes.'

let limits = { maxConcurrent: BACKUP_MAX_CONCURRENT, deadlineMs: BACKUP_DEADLINE_MS }
let fetcher: ModelFetcher | null = null
let running = 0

/** Test hook: other limits (or null for the defaults). */
export function setBackupLimits(l: Partial<typeof limits> | null) {
  limits = { maxConcurrent: BACKUP_MAX_CONCURRENT, deadlineMs: BACKUP_DEADLINE_MS, ...l }
}
/** Test hook: where backup files come from (or null for the real, Virvi-hosted-only fetcher). */
export function setBackupFetcher(f: ModelFetcher | null) {
  fetcher = f
}

/**
 * backupProject under the limits. Throws BackupError 429 `backup_busy` when the slots are taken, 504 `backup_timeout`
 * past the deadline. A build that runs out of time keeps its slot until it winds down, but fetches nothing more.
 */
export async function runBackup(sceneId: string): Promise<Awaited<ReturnType<typeof backupProject>>> {
  if (running >= limits.maxConcurrent) throw new BackupError(429, 'backup_busy', BUSY)
  running++
  let expired = false
  const fetch: ModelFetcher = async (url) => {
    if (expired) throw new Error('backup deadline passed')
    return (fetcher ?? defaultModelFetcher)(url)
  }
  const build = backupProject(sceneId, { fetch }).finally(() => void running--)
  build.catch(() => {}) // a build that lost the race may still fail later
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true
      reject(new BackupError(504, 'backup_timeout', TIMEOUT))
    }, limits.deadlineMs)
  })
  try {
    return await Promise.race([build, deadline])
  } finally {
    clearTimeout(timer)
  }
}
