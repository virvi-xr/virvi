import { describe, expect, it } from 'vitest'
import { backupErrorMessage } from './backup'

const apiError = (status: number, body: Record<string, unknown>) => Object.assign(new Error(String(body.error)), { status, body })

describe('backupErrorMessage', () => {
  it("says the server's sentence for too big, which names the largest files", () => {
    const message = 'This backup would be over the 500 MB limit. The largest files: a.glb (300 MB), b.mp4 (250 MB). Remove or shrink some of them in Virvi and try again.'
    expect(backupErrorMessage(apiError(413, { error: 'backup_too_big', message }))).toBe(message)
  })

  it('has a sentence for too big when the server sent none', () => {
    expect(backupErrorMessage(apiError(413, { error: 'backup_too_big' }))).toMatch(/500 MB/)
  })

  it('explains a scene with no Decentraland place', () => {
    expect(backupErrorMessage(apiError(422, { error: 'not_decentraland' }))).toMatch(/Decentraland/)
  })

  it('asks to try again when busy or timed out', () => {
    expect(backupErrorMessage(apiError(429, { error: 'backup_busy' }))).toMatch(/Try again/)
    expect(backupErrorMessage(apiError(504, { error: 'backup_timeout' }))).toMatch(/Try again/)
  })

  it('says a network failure plainly', () => {
    expect(backupErrorMessage(new TypeError('Failed to fetch'))).toMatch(/connection|reach/i)
  })

  it('falls back for an unknown failure', () => {
    expect(backupErrorMessage(apiError(500, { error: 'boom' }))).toMatch(/Try again/)
  })
})
