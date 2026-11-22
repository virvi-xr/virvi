import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CITIES } from '@virvixr/shared'
import { CityList } from '@/components/cities/CityList'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('CITIES', () => {
  it('gives every live world an https url and every coming one none', () => {
    for (const c of CITIES) for (const w of c.worlds) {
      if (w.status === 'live') expect(w.url, c.id).toMatch(/^https:\/\//)
      else expect(w.url, c.id).toBeNull()
    }
  })
})

describe('CityList', () => {
  const html = renderToStaticMarkup(createElement(CityList))
  it('links Virvi City in Decentraland, in a new tab', () => {
    expect(html).toContain('Virvi City')
    expect(html).toContain('href="https://decentraland.org/jump/?realm=virvicity.dcl.eth"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener"')
    expect(html).toContain('Visit in Decentraland')
    expect(html).toContain('Live')
  })
  it('says Hyperfy is coming, without a link', () => {
    expect(html).toContain('Coming to Hyperfy')
    expect(html).not.toContain('Visit in Hyperfy')
  })
  it('shows an initials tile when there is no picture', () => {
    expect(html).toContain('>VC<')
  })
})

describe('the pages', () => {
  it('have their own title and the dashboard header', () => {
    expect(source('./page.tsx')).toMatch(/title: '[^']*Cities[^']*'/)
    expect(source('../(dashboard)/virvi-cities/page.tsx')).toContain('title="Cities"')
  })
})
