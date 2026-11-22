import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AR_APPS, AR_APPS_REPO } from '@virvixr/shared'
import { ArSections } from './ArSections'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('the AR page', () => {
  const html = renderToStaticMarkup(createElement(ArSections))

  it('says what AR Spaces are', () => {
    expect(html).toContain('AR Spaces')
    expect(html).toContain('life-size')
    expect(html).toContain('ARC by the door')
    expect(html).toContain('Decentraland')
    expect(html).toContain('Hyperfy')
  })

  it('lists all three apps, each with its device, status and link', () => {
    for (const app of AR_APPS) {
      expect(html).toContain(app.name)
      expect(html).toContain(app.device)
      expect(html).toContain(`href="${app.sourceUrl}"`)
    }
    expect(html).toContain('Preview')
    expect(html).toContain('Prototype')
    expect(html).toContain('See the source on GitHub')
    expect(html).toContain('Not in the store yet')
  })

  it('presents one app, Virvi AR, on three platforms, with no old app names', () => {
    expect(html).toContain('One app, three platforms')
    for (const platform of ['Meta Quest', 'Apple Vision Pro', 'iPhone']) expect(html).toContain(`Virvi AR for ${platform}`)
    expect(html).not.toContain('Virvi Builder')
    expect(html).not.toContain('Virvi for iPhone')
  })

  it('tells venue owners how to set up a space, with the docs, and says the apps are open source', () => {
    expect(html).toContain('Set up your own space')
    expect(html).toContain('href="/docs/"')
    expect(html).toContain(`href="${AR_APPS_REPO}"`)
    expect(html).toContain('open source')
  })

  it('uses typographic apostrophes in visible text', () => {
    expect(html).not.toContain('&#x27;')
  })

  it('has its own title', () => {
    expect(source('./page.tsx')).toMatch(/title: '[^']*AR[^']*'/)
  })
})

describe('pages that point to the AR page', () => {
  it('the ring’s fallback page sends people to get the apps', () => {
    expect(source('../s/[code]/client.tsx')).toContain('href="/ar/"')
  })

  it('the dashboard has an AR tab', () => {
    expect(source('../(dashboard)/layout.tsx')).toContain("{ href: '/ar-apps', label: 'AR'")
  })
})
