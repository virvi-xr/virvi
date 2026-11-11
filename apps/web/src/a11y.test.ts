import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Accessibility checks over the source (LIV-42): every form field has a name a screen reader can say, and the theme's
 * text grays are readable on the dashboard's surfaces (WCAG AA, 4.5:1 for body text).
 */

const SRC = fileURLToPath(new URL('.', import.meta.url))

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return tsxFiles(p)
    return p.endsWith('.tsx') && !p.includes('.test.') ? [p] : []
  })
}

/** Where a JSX tag that starts at `i` ends: the first `>` outside braces and strings (so `onChange={e => …}` is skipped). */
function tagEnd(s: string, i: number): number {
  let depth = 0
  let quote: string | null = null
  for (; i < s.length; i++) {
    const c = s[i]
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '"' || ((c === "'" || c === '`') && depth > 0)) quote = c
    else if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) return i
  }
  return -1
}

/** Strips comments, so a field named in one (`like an <input accept>`) isn't taken for a field. */
const withoutComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/.*$/gm, (m, a) => a + ' '.repeat(m.length - a.length))

/** Form fields with no accessible name: no aria-label(ledby), not inside a <label>, and no id that a htmlFor names. */
export function unlabelledFields(source: string): number[] {
  const s = withoutComments(source)
  const lines: number[] = []
  for (const m of s.matchAll(/<(input|textarea|select)\b/g)) {
    const start = m.index!
    const attrs = s.slice(start + m[0].length, tagEnd(s, start + m[0].length))
    if (/type=["'](hidden|file|submit)["']/.test(attrs)) continue
    if (/aria-label|aria-labelledby|aria-hidden="true"|\{\.\.\./.test(attrs)) continue
    const before = s.slice(Math.max(0, start - 600), start)
    if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1]
    if (id ? s.includes(`htmlFor="${id}"`) : /\bid=\{/.test(attrs) && s.includes('htmlFor')) continue
    lines.push(s.slice(0, start).split('\n').length)
  }
  return lines
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('accessibility (LIV-42)', () => {
  it('every form field has a name a screen reader can say', () => {
    const missing = tsxFiles(SRC).flatMap((f) => unlabelledFields(readFileSync(f, 'utf8')).map((line) => `${relative(SRC, f)}:${line}`))
    // Give the field a <label htmlFor>, wrap it in a <label>, or add aria-label: a placeholder isn't a name
    expect(missing).toEqual([])
  })

  it('the check finds an unlabelled field and accepts the ways of naming one', () => {
    expect(unlabelledFields('<input value={x} onChange={e => set(e.target.value)} placeholder="Name" />')).toEqual([1])
    expect(unlabelledFields('<input aria-label="Name" />')).toEqual([])
    expect(unlabelledFields('<label>Name <input /></label>')).toEqual([])
    expect(unlabelledFields('<label htmlFor="n">Name</label><input id="n" />')).toEqual([])
    expect(unlabelledFields('<input type="hidden" name="x" />')).toEqual([])
    expect(unlabelledFields('// like an <input accept>\n')).toEqual([])
  })

  it('secondary text (gray-400, gray-500) is readable on the page and on cards', () => {
    const css = readFileSync(join(SRC, 'styles/globals.css'), 'utf8')
    const color = (name: string) => new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)![1]
    for (const text of ['gray-400', 'gray-500']) {
      for (const surface of ['gray-950', 'gray-900']) {
        expect(contrast(color(text), color(surface)), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('reduced motion is respected', () => {
    const css = readFileSync(join(SRC, 'styles/globals.css'), 'utf8')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
  })
})
