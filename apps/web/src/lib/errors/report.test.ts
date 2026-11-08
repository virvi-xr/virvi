import { describe, it, expect } from 'vitest'
import { ERROR_LIMITS, type Breadcrumb, type ClientErrorEvent } from '@virvixr/shared'
import { buildReport, reportPreview, reportEvent, checkScreenshotFile, ReportDraft, LAST_ERROR_MS } from './capture'

/** LIV-66 §4: the Report form (crash screen, prompt toast, help menu). What's previewed is what's sent, and only on Submit. */

const NOW = 1_800_000_000_000
const crumbs: Breadcrumb[] = [{ t: NOW - 5000, type: 'nav', path: '/scenes' }, { t: NOW - 1000, type: 'click', label: 'Save' }]
const failed: ClientErrorEvent = { kind: 'api', t: NOW - 2000, route: '/scenes/x', method: 'PUT', path: '/api/scenes/x', status: 500, userFacing: true, breadcrumbs: crumbs }
const shot = { type: 'image/png' as const, data: 'iVBORw0KGgo=', bytes: 8 }

describe('report payload and preview', () => {
  it('without a screenshot, the preview is exactly the JSON that Submit posts', () => {
    const p = buildReport(' Saving ', failed, 'abc1234')
    expect(reportPreview(p)).toBe(JSON.stringify(p, null, 2))
  })

  it('with a screenshot, the preview is the same JSON with the image bytes summarised', () => {
    const p = buildReport('Saving', failed, 'abc1234', shot)
    expect(p.screenshot).toEqual({ type: 'image/png', data: shot.data })
    const preview = JSON.parse(reportPreview(p))
    expect(preview).toEqual({ ...p, screenshot: { type: 'image/png', data: '[the image above, 8 bytes]' } })
  })

  it('a help-menu report with no error is a report event of the page, with the breadcrumbs', () => {
    expect(reportEvent('/scenes/x?tab=2&token=abc', crumbs, NOW)).toEqual({ kind: 'report', t: NOW, route: '/scenes/x', breadcrumbs: crumbs })
  })

  it('takes PNG, JPEG or WebP screenshots of at most 2 MB', () => {
    expect(checkScreenshotFile({ type: 'image/png', size: 1000 })).toBeNull()
    expect(checkScreenshotFile({ type: 'image/webp', size: ERROR_LIMITS.maxScreenshotBytes })).toBeNull()
    expect(checkScreenshotFile({ type: 'image/gif', size: 1000 })).toMatch(/PNG, JPEG or WebP/)
    expect(checkScreenshotFile({ type: 'image/png', size: ERROR_LIMITS.maxScreenshotBytes + 1 })).toMatch(/2 MB/)
  })
})

describe('ReportDraft: nothing leaves before Submit', () => {
  const draft = (lastError: ClientErrorEvent | null = failed) => {
    const sent: string[] = []
    const d = new ReportDraft({ lastError, route: '/scenes/x', breadcrumbs: crumbs, release: 'abc1234', now: () => NOW, send: async (body) => { sent.push(body); return { emailed: true, screenshot: 'kept' } } })
    return { d, sent }
  }

  it('typing, attaching a screenshot and reading the preview send nothing', async () => {
    const { d, sent } = draft()
    d.setDescription('I was saving my scene')
    expect(d.attach({ type: 'image/png', size: 8 }, shot.data)).toBeNull()
    d.preview()
    d.payload()
    expect(sent).toEqual([])
  })

  it('Submit sends exactly the previewed payload, once', async () => {
    const { d, sent } = draft()
    d.setDescription('I was saving my scene')
    d.attach({ type: 'image/png', size: 8 }, shot.data)
    const preview = JSON.parse(d.preview())
    const result = await d.submit()
    expect(result).toEqual({ emailed: true, screenshot: 'kept' })
    expect(sent).toHaveLength(1)
    const body = JSON.parse(sent[0])
    expect(body).toEqual(d.payload())
    expect({ ...body, screenshot: preview.screenshot }).toEqual(preview)
    expect(body.screenshot.data).toBe(shot.data)
  })

  it('needs a description', async () => {
    const { d, sent } = draft()
    d.setDescription('   ')
    expect(d.ready).toBe(false)
    await expect(d.submit()).rejects.toThrow(/what you were trying to do/)
    expect(sent).toEqual([])
  })

  it('is pre-filled with the last error and its breadcrumbs, which the user can leave out', () => {
    const { d } = draft()
    d.setDescription('x')
    expect(d.payload().event).toEqual(failed)
    d.includeError = false
    expect(d.payload().event).toEqual({ kind: 'report', t: NOW, route: '/scenes/x', breadcrumbs: crumbs })
  })

  it('with no recent error (or one older than half an hour), it reports the page', () => {
    expect(draft(null).d.hasError).toBe(false)
    const old = { ...failed, t: NOW - LAST_ERROR_MS - 1 }
    const { d } = draft(old)
    d.setDescription('x')
    expect(d.hasError).toBe(false)
    expect(d.payload().event.kind).toBe('report')
  })

  it('a refused screenshot is not attached; removing one drops it', () => {
    const { d } = draft()
    d.setDescription('x')
    expect(d.attach({ type: 'image/gif', size: 8 }, 'R0lG')).toMatch(/PNG/)
    expect(d.payload().screenshot).toBeUndefined()
    d.attach({ type: 'image/png', size: 8 }, shot.data)
    d.removeScreenshot()
    expect(d.payload().screenshot).toBeUndefined()
  })
})
