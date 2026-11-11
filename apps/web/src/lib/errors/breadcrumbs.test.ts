import { describe, it, expect } from 'vitest'
import { Breadcrumbs, clickLabel } from './breadcrumbs'

describe('breadcrumbs', () => {
  it('keeps the last 30', () => {
    const b = new Breadcrumbs(() => 1)
    for (let i = 0; i < 40; i++) b.nav(`/p${i}`)
    const all = b.list()
    expect(all).toHaveLength(30)
    expect(all[0].path).toBe('/p10')
    expect(all.at(-1)!.path).toBe('/p39')
  })

  it('records pages without their query, and credential codes as :code', () => {
    const b = new Breadcrumbs(() => 1)
    b.nav('/scenes?tab=roles&email=me@x.com')
    b.nav('/pair/ABC123')
    expect(b.list().map((c) => c.path)).toEqual(['/scenes', '/pair/:code'])
  })

  it('records API calls with method, path, status, duration and request ID', () => {
    const b = new Breadcrumbs(() => 5)
    b.api('put', '/api/scenes/x?token=abc', 500, 31.6, 'req-1')
    expect(b.list()).toEqual([{ t: 5, type: 'api', method: 'PUT', path: '/api/scenes/x', status: 500, ms: 32, requestId: 'req-1' }])
  })

  it('a click is the button or link’s own label, never typed text', () => {
    const b = new Breadcrumbs(() => 1)
    b.click('Save me@x.com')
    b.click(null)
    expect(b.list()).toEqual([{ t: 1, type: 'click', label: 'Save [email]' }])
  })
})

describe('clickLabel (fixtures)', () => {
  const el = (tagName: string, o: Partial<{ text: string; aria: string; title: string; role: string; type: string }> = {}) => ({
    tagName, textContent: o.text ?? '', getAttribute: (n: string) => ({ 'aria-label': o.aria, title: o.title, role: o.role, type: o.type } as Record<string, string | undefined>)[n] ?? null,
  })
  it('reads buttons and links', () => {
    expect(clickLabel(el('BUTTON', { text: '  Save   scene ' }))).toBe('Save scene')
    expect(clickLabel(el('A', { text: '', aria: 'Open settings' }))).toBe('Open settings')
    expect(clickLabel(el('DIV', { role: 'button', title: 'Close' }))).toBe('Close')
    expect(clickLabel(el('BUTTON', { text: 'x'.repeat(200) }))!.length).toBeLessThanOrEqual(80)
  })
  it('never reads what was typed: inputs, text areas, selects and anything else are not recorded', () => {
    expect(clickLabel(el('INPUT', { type: 'password', aria: 'Password' }))).toBeNull()
    expect(clickLabel(el('INPUT', { type: 'submit', aria: 'Go' }))).toBeNull()
    expect(clickLabel(el('TEXTAREA', { text: 'my private notes' }))).toBeNull()
    expect(clickLabel(el('SELECT', { text: 'one two' }))).toBeNull()
    expect(clickLabel(el('DIV', { text: 'hello' }))).toBeNull()
    expect(clickLabel(null)).toBeNull()
  })
})
