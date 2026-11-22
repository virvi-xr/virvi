import { describe, it, expect } from 'vitest'
import { AR_APPS, AR_APPS_REPO, arAppLink, arAppStatusLabel, arAppsForDevice, type ArApp } from '@virvixr/shared'

const quest = AR_APPS.find((a) => a.id === 'quest')!

describe('AR_APPS', () => {
  it('lists the Quest, Vision Pro and iPhone apps, each with its source on GitHub', () => {
    expect(AR_APPS.map((a) => a.id)).toEqual(['quest', 'vision-pro', 'iphone'])
    expect(AR_APPS.map((a) => a.name)).toEqual(['Virvi AR', 'Virvi Builder', 'Virvi for iPhone'])
    for (const app of AR_APPS) expect(app.sourceUrl.startsWith(`${AR_APPS_REPO}/tree/main/apps/`)).toBe(true)
    expect(AR_APPS.find((a) => a.id === 'iphone')!.sourceUrl).toBe('https://github.com/virvi-xr/virvi/tree/main/apps/ar-spike')
  })
})

describe('arAppLink', () => {
  it('links to the source, saying it isn’t in the store yet, while there is no store link', () => {
    expect(arAppLink(quest)).toEqual({ href: quest.sourceUrl, label: 'See the source on GitHub', note: 'Not in the store yet' })
  })

  it('links to the store once there is one, in each store’s words', () => {
    const inStore = (app: ArApp): ArApp => ({ ...app, status: 'store', storeUrl: 'https://store.example/app' })
    expect(arAppLink(inStore(quest))).toEqual({ href: 'https://store.example/app', label: 'Get it on the Meta Horizon Store', note: null })
    for (const id of ['vision-pro', 'iphone'] as const) {
      expect(arAppLink(inStore(AR_APPS.find((a) => a.id === id)!)).label).toBe('Download on the App Store')
    }
  })
})

describe('arAppStatusLabel', () => {
  it('says each status in words', () => {
    expect(arAppStatusLabel('store')).toBe('In the store')
    expect(arAppStatusLabel('preview')).toBe('Preview')
    expect(arAppStatusLabel('prototype')).toBe('Prototype')
    expect(arAppStatusLabel('coming')).toBe('Coming soon')
  })
})

describe('arAppsForDevice', () => {
  const ids = (ua: string) => arAppsForDevice(ua).map((a) => a.id)
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
  const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  const QUEST = 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.0.0 SamsungBrowser/4.0 Chrome/126.0 VR Safari/537.36'
  const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'

  it('puts the iPhone app first on an iPhone or iPad', () => {
    expect(ids(IPHONE)).toEqual(['iphone', 'quest', 'vision-pro'])
    expect(ids(IPAD)).toEqual(['iphone', 'quest', 'vision-pro'])
  })

  it('puts the Quest app first in the Quest browser', () => {
    expect(ids(QUEST)).toEqual(['quest', 'vision-pro', 'iphone'])
    expect(ids('Mozilla/5.0 (Linux; Android 12; Quest 3S) OculusBrowser/36.0')).toEqual(['quest', 'vision-pro', 'iphone'])
  })

  it('keeps the usual order anywhere else, and always shows all three', () => {
    for (const ua of [DESKTOP, '', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126.0 Mobile']) {
      expect(ids(ua)).toEqual(['quest', 'vision-pro', 'iphone'])
    }
  })
})
