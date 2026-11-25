import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { DCL_HUD_LATEST } from '@virvixr/shared'
import { hudBehindNote, hudMissing, hudMissingNote, hudRedeployHere } from './hud-version'
import { DCL_CHANGELOG } from './dcl-changelog'

describe('the scene page\'s out-of-date HUD warning', () => {
  it('names the versions when the scene is behind', () => {
    expect(hudBehindNote({ version: '2.14.0', latest: '2.15.0', seenAt: '', behind: true }))
      .toBe('This scene runs HUD 2.14.0 in Decentraland; the latest is 2.15.0. Redeploy it to give visitors the latest fixes and features.')
    expect(hudBehindNote({ version: null, latest: '2.15.0', seenAt: '', behind: true })).toContain('an older HUD')
  })
  it('says nothing when current, or when no HUD has called', () => {
    expect(hudBehindNote({ version: '2.15.0', latest: '2.15.0', seenAt: '', behind: false })).toBeNull()
    expect(hudBehindNote(null)).toBeNull()
    expect(hudBehindNote(undefined)).toBeNull()
  })
  it('a scene deployed from its creator\'s own project is told how to update it there, with no Redeploy (LIV-13)', () => {
    const own = { version: '2.14.0', latest: '2.15.0', seenAt: '', behind: true, virviDeploys: false }
    expect(hudBehindNote(own)).toBe('This scene runs HUD 2.14.0 in Decentraland; the latest is 2.15.0. To give visitors the latest fixes and features, run `npm install @virvixr/dcl@latest` in your scene\'s folder, then deploy it the way you usually do.')
    expect(hudRedeployHere(own)).toBe(false)
    expect(hudRedeployHere({ ...own, virviDeploys: true })).toBe(true)
    expect(hudRedeployHere({ version: '2.14.0', latest: '2.15.0', seenAt: '', behind: true })).toBe(true)
  })
})

describe('what a scene that is behind is missing (LIV-13)', () => {
  const behind = (version: string | null, latest = '2.21.1') => ({ version, latest, seenAt: '', behind: true })
  it('lists the headlines of every release after the scene\'s, up to the latest, newest first', () => {
    expect(hudMissingNote(behind('2.20.0'))).toBe('New since 2.20.0: Version reporting, BEAT auto-claim and New consent text.')
    expect(hudMissingNote(behind('2.21.0'))).toBe('New since 2.21.0: Version reporting.')
    expect(hudMissing(behind('2.19.0', '2.21.0'))!.highlights).toEqual(['BEAT auto-claim', 'New consent text', 'Visitor privacy notice', 'Privacy entry', 'Nothing is sent before a decision'])
  })
  it('names a headline once and counts the rest past five', () => {
    const m = hudMissing(behind('2.16.0'))!
    expect(m.highlights).toHaveLength(5)
    expect(new Set([...m.highlights]).size).toBe(5)
    expect(hudMissingNote(behind('2.16.0'))).toMatch(/^New since 2\.16\.0: Version reporting, BEAT auto-claim, New consent text, Visitor privacy notice, Privacy entry and \d+ more\.$/)
    // Stop tracking (2.17.0, 2.18.0) and Guests (2.16.0 is excluded, 2.18.0) appear once
    const all = hudMissing(behind('2.16.0'), 99)!
    expect(all.highlights.filter((h) => h === 'Stop tracking')).toHaveLength(1)
    expect(all.more).toBe(0)
  })
  it('says nothing when the scene is current, or its version is unknown', () => {
    expect(hudMissingNote({ version: '2.21.1', latest: '2.21.1', seenAt: '', behind: false })).toBeNull()
    expect(hudMissingNote(behind(null))).toBeNull()
    expect(hudMissingNote(null)).toBeNull()
  })
  it('matches the public changelog: every release and its bold headlines, in order', () => {
    const md = readFileSync(new URL('../../../docs/src/content/docs/sdk/decentraland/changelog.md', import.meta.url), 'utf8')
    const fromDocs = [...md.matchAll(/^## (\S+) — \S+\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)]
      .map((m) => ({ version: m[1], highlights: [...m[2].matchAll(/^- \*\*(.+?):\*\*/gm)].map((h) => h[1]) }))
    expect(fromDocs.length).toBeGreaterThan(10)
    expect(DCL_CHANGELOG).toEqual(fromDocs)
  })
  it('covers the latest release the server knows of', () => {
    expect(DCL_CHANGELOG[0].version).toBe(DCL_HUD_LATEST)
  })
})
