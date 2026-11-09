import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releaseFrom, readReleaseFile } from '../src/config.js'

describe('release stamp (LIV-66 follow-up: railway up from a checkout passes no commit SHA)', () => {
  it('falls back to the stamped RELEASE file when no env names the release', () => {
    expect(releaseFrom({}, '96ef3c93abcd')).toBe('96ef3c93abcd')
  })
  it('env still wins over the file', () => {
    expect(releaseFrom({ VIRVI_RELEASE: 'abc123' }, '96ef3c93abcd')).toBe('abc123')
    expect(releaseFrom({ RAILWAY_GIT_COMMIT_SHA: 'def4567890123456' }, '96ef3c93abcd')).toBe('def456789012')
  })
  it("the committed placeholder 'dev', a missing file and junk all give 'dev'", () => {
    expect(releaseFrom({}, 'dev')).toBe('dev')
    expect(releaseFrom({}, null)).toBe('dev')
    expect(releaseFrom({}, 'not a sha!')).toBe('dev')
  })
  it('readReleaseFile reads the first line, trimmed, and returns null when the file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rel-'))
    expect(readReleaseFile(join(dir, 'RELEASE'))).toBeNull()
    writeFileSync(join(dir, 'RELEASE'), '96ef3c93abcd\n')
    expect(readReleaseFile(join(dir, 'RELEASE'))).toBe('96ef3c93abcd')
  })
})
