import { afterEach, describe, expect, it, vi } from 'vitest'
import { demoFixtures, SAMPLE_WORLD } from './fixtures'
import { clearDemoStores, createDemoApi, demoStorageKey, overlayDemoApi } from './store'

const NOW = Date.parse('2026-11-07T12:34:56.000Z')
const DAY = 86_400_000

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k) },
    setItem: (k, v) => { m.set(k, String(v)) },
  }
}

const range = { from: new Date(NOW - 7 * DAY).toISOString(), to: new Date(NOW).toISOString() }

afterEach(() => { vi.unstubAllGlobals() })

describe('demoFixtures', () => {
  it('fixtures are deterministic', () => {
    expect(demoFixtures(NOW)).toEqual(demoFixtures(NOW))
  })

  it('is the sample World with 7 days of visits, 3 events on the sample scene and 1 giveaway with 3 items and 5 claims', () => {
    const d = demoFixtures(NOW)
    expect(d.location.locationKey).toBe('virvi-sample.dcl.eth')
    expect(SAMPLE_WORLD.parcels).toHaveLength(4)
    expect(d.visits.length).toBeGreaterThan(0)
    for (const v of d.visits) {
      const t = Date.parse(v.startedAt)
      expect(t).toBeGreaterThanOrEqual(NOW - 7 * DAY)
      expect(t).toBeLessThanOrEqual(NOW)
    }
    expect(d.events).toHaveLength(3)
    expect(d.eventScenes.filter((l) => l.sceneId === d.scene.id).length).toBe(3)
    expect(d.giveaways).toHaveLength(1)
    expect(d.items.filter((i) => i.giveawayId === d.giveaways[0].id)).toHaveLength(3)
    expect(d.claims).toHaveLength(5)
  })

  it('heatmap cells lie inside the sample parcels', () => {
    const d = demoFixtures(NOW)
    expect(d.cells.length).toBeGreaterThan(0)
    // Scene-relative metres from the base parcel's SW corner: a 2×2 World spans 0..32 on both axes
    for (const c of d.cells) {
      expect(c.x).toBeGreaterThanOrEqual(0)
      expect(c.x).toBeLessThan(32)
      expect(c.z).toBeGreaterThanOrEqual(0)
      expect(c.z).toBeLessThan(32)
    }
  })
})

describe('createDemoApi', () => {
  it('reads the sample analytics', async () => {
    const api = createDemoApi({ trialId: 't1', now: () => NOW, storage: memoryStorage() })
    const { scenes } = await api.getAnalyticsLocations()
    expect(scenes).toHaveLength(1)
    const id = scenes[0].id
    const s = await api.getAnalyticsSummary(id, range)
    expect(s.sessions).toBeGreaterThan(0)
    expect(s.uniqueVisitors).toBeLessThanOrEqual(s.sessions)
    const ts = await api.getAnalyticsTimeseries(id, { ...range, bucket: 'day' })
    expect(ts.points.reduce((n, p) => n + p.sessions, 0)).toBe(s.sessions)
    const heat = await api.getAnalyticsHeatmap(id, range)
    expect(heat.cells.length).toBeGreaterThan(0)
    expect(heat.heatmap3d).toBe(false)
    expect(await api.getAnalyticsLayout(id)).toEqual({ layout: null })
    const first = await api.getAnalyticsSessions(id)
    expect(first.sessions.length).toBeGreaterThan(0)
    if (first.nextCursor) expect((await api.getAnalyticsSessions(id, first.nextCursor)).sessions.length).toBeGreaterThan(0)
    const live = await api.getAnalyticsLive(id)
    expect(live.positions).toHaveLength(live.count)
  })

  it('creating an event persists and lists', async () => {
    const storage = memoryStorage()
    const a = createDemoApi({ trialId: 't1', now: () => NOW, storage })
    const { event } = await a.createEvent({ name: 'My launch', timezone: 'UTC' })
    expect(storage.getItem(demoStorageKey('t1'))).not.toBeNull()
    const b = createDemoApi({ trialId: 't1', now: () => NOW, storage })
    const { events } = await b.getEvents()
    expect(events.map((e: any) => e.name)).toContain('My launch')
    expect(events).toHaveLength(4)
    expect((await b.getEvent(event.id)).event.name).toBe('My launch')
    // Another trial's demo starts fresh
    const c = createDemoApi({ trialId: 't2', now: () => NOW, storage })
    expect((await c.getEvents()).events).toHaveLength(3)
  })

  it('sample events keep their place relative to now on a later visit; guest-made and edited events keep their times (LIV-138)', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(NOW)
      const storage = memoryStorage()
      const first = createDemoApi({ trialId: 't1', now: () => Date.now(), storage })
      const mine = (await first.createEvent({ name: 'My launch', startTime: new Date(NOW + DAY).toISOString(), timezone: 'UTC' })).event
      await first.updateEvent('demo-event-3', { name: 'Builders meetup' })
      const editedBefore = (await first.getEvent('demo-event-3')).event

      vi.setSystemTime(NOW + 3 * DAY)
      const later = createDemoApi({ trialId: 't1', now: () => Date.now(), storage })
      const { events } = await later.getEvents()
      const byId = new Map(events.map((e: any) => [e.id, e]))
      const walk = byId.get('demo-event-2')!
      const t = Date.now()
      // Still on now, as the sample has it
      expect(Date.parse(walk.startTime!)).toBeLessThanOrEqual(t)
      expect(Date.parse(walk.endTime!)).toBeGreaterThan(t)
      expect(walk).toEqual(demoFixtures(t).events[1])
      expect(byId.get('demo-event-1')).toEqual(demoFixtures(t).events[0])
      // The guest's own and edited events are as they left them
      expect(byId.get(mine.id)).toEqual(mine)
      const edited = byId.get('demo-event-3')!
      expect([edited.name, edited.startTime, edited.endTime]).toEqual(['Builders meetup', editedBefore.startTime, editedBefore.endTime])
      expect(events).toHaveLength(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a store from before the marker re-anchors only the sample events it never edited', async () => {
    const storage = memoryStorage()
    const old = demoFixtures(NOW)
    const edited = { ...old.events[2], name: 'Renamed', updatedAt: new Date(NOW + 1000).toISOString() }
    const { location, scene, visits, cells, hotspots, ...data } = old
    storage.setItem(demoStorageKey('t1'), JSON.stringify({ v: 2, data: { ...data, events: [old.events[0], old.events[1], edited] } }))
    const later = NOW + 3 * DAY
    const { events } = await createDemoApi({ trialId: 't1', now: () => later, storage }).getEvents()
    expect(events[1]).toEqual(demoFixtures(later).events[1])
    expect(events[2]).toEqual(edited)
  })

  it('items come only from the demo host’s own wearables, and the sample giveaway’s items are locked by its claims', async () => {
    const api = createDemoApi({ trialId: 't1', now: () => NOW, storage: memoryStorage() })
    const { items } = await api.getGiveawayCreatorItems('polygon')
    expect(items.every((i) => i.thumbnail === null)).toBe(true)
    await expect(api.setGiveawayItems('demo-giveaway-1', [items[3]])).rejects.toMatchObject({ status: 409, body: { error: 'has_claims' } })
    const { giveaway } = await api.createGiveaway({ name: 'Caps' })
    await expect(api.setGiveawayItems(giveaway.id, [{ contractAddress: '0x00000000000000000000000000000000000000ff', itemId: '1' }]))
      .rejects.toMatchObject({ status: 400, body: { error: 'not_your_item' } })
    const view = await api.setGiveawayItems(giveaway.id, [items[3]])
    expect(view.items.map((i) => [i.name, i.mintState])).toEqual([['Comet cap', 'ready']])
  })

  it('a stored demo from before automatic giveaways is the sample again', async () => {
    const storage = memoryStorage()
    const { location, scene, visits, cells, hotspots, ...data } = demoFixtures(NOW)
    storage.setItem(demoStorageKey('t1'), JSON.stringify({ v: 1, data: { ...data, events: [] } }))
    expect((await createDemoApi({ trialId: 't1', now: () => NOW, storage }).getEvents()).events).toHaveLength(3)
  })

  it('switching on needs items and a scene; delete waits for the POL to go back', async () => {
    const api = createDemoApi({ trialId: 't1', now: () => NOW, storage: memoryStorage() })
    const { giveaway } = await api.createGiveaway({ name: 'Caps' })
    expect(giveaway.enabled).toBe(false)
    await expect(api.updateGiveaway(giveaway.id, { enabled: true })).rejects.toMatchObject({ status: 409, body: { error: 'not_ready' } })
    await api.setGiveawayItems(giveaway.id, [{ contractAddress: '0x00000000000000000000000000000000000000d2', itemId: '0' }])
    await expect(api.updateGiveaway(giveaway.id, { enabled: true })).rejects.toMatchObject({ body: { error: 'not_ready' } })
    await api.setGiveawayScenes(giveaway.id, ['demo-scene'])
    expect((await api.updateGiveaway(giveaway.id, { enabled: true })).enabled).toBe(true)

    const sample = await api.getGiveaway('demo-giveaway-1')
    expect(sample.funding).toMatchObject({ balanceWei: '1500000000000000000', covered: false, lowGas: false })
    expect(sample.funding.claimsCovered).toBeGreaterThan(10)
    await expect(api.deleteGiveaway('demo-giveaway-1')).rejects.toMatchObject({ status: 409, body: { error: 'send_back_first' } })
    const { wallets } = await api.getGiveawaySendBackWallets()
    await expect(api.sendBackGiveaway('demo-giveaway-1', '0x00000000000000000000000000000000000000aa')).rejects.toMatchObject({ body: { error: 'not_your_wallet' } })
    const sent = await api.sendBackGiveaway('demo-giveaway-1', wallets[0])
    expect(BigInt(sent.valueWei) > BigInt(0)).toBe(true)
    await expect(api.sendBackGiveaway('demo-giveaway-1', wallets[0])).rejects.toMatchObject({ body: { error: 'nothing_to_send' } })
    expect((await api.deleteGiveaway('demo-giveaway-1')).deleteState).toBe('returning')
    expect((await api.getGiveaways()).giveaways.map((g) => g.id)).toEqual([giveaway.id])
  })

  it('a stored item with an outside image comes back without it', async () => {
    const storage = memoryStorage()
    const { location, scene, visits, cells, hotspots, ...data } = demoFixtures(NOW)
    data.items[0] = { ...data.items[0], imageUrl: 'https://tracker.example/p.png' }
    storage.setItem(demoStorageKey('t1'), JSON.stringify({ v: 2, data }))
    const giveaway = await createDemoApi({ trialId: 't1', now: () => NOW, storage, origin: 'https://virvi.io' }).getGiveaway('demo-giveaway-1')
    expect(giveaway.items[0].thumbnail).toBeNull()
  })

  it('a stored demo missing any of its lists falls back to the sample data', async () => {
    const lists = ['events', 'eventScenes', 'eventGiveaways', 'giveaways', 'items', 'claims'] as const
    for (const missing of lists) {
      const storage = memoryStorage()
      const full = Object.fromEntries(lists.map((k) => [k, []]))
      storage.setItem(demoStorageKey('t1'), JSON.stringify({ v: 2, data: { ...full, [missing]: { not: 'a list' } } }))
      const api = createDemoApi({ trialId: 't1', now: () => NOW, storage })
      // the sample giveaway and its claims are there, not a crash
      const { giveaways } = await api.getGiveaways()
      expect(giveaways.length, missing).toBe(1)
      expect((await api.getGiveawayClaims(giveaways[0].id)).claims.length, missing).toBe(5)
    }
  })

  it('a method the demo lacks rejects account_required with demo:<name>', async () => {
    const refused: string[] = []
    const api = overlayDemoApi({ getScene: () => Promise.resolve('real') } as Record<string, (...a: any[]) => any>,
      createDemoApi({ trialId: 't1', now: () => NOW, storage: memoryStorage() }), (a) => refused.push(a))
    await expect(api.getScene('x')).rejects.toMatchObject({ status: 403, body: { error: 'account_required', action: 'demo:getScene' } })
    expect(refused).toEqual(['demo:getScene'])
  })

  it('no real api method is reachable through the overlay', async () => {
    const names = ['getScene', 'updateScene', 'deleteScene', 'createScene', 'setAnalyticsWalletVisibility', 'createPresetSchedule',
      'deletePresetSchedule', 'getCommandCenterStatus', 'broadcastToEvent', 'uploadMedia', 'downloadStudioPackage', 'getWallets']
    const real: Record<string, ReturnType<typeof vi.fn>> = Object.fromEntries(names.map((n) => [n, vi.fn(() => Promise.resolve('real'))]))
    const api = overlayDemoApi(real, createDemoApi({ trialId: 't1', now: () => NOW, storage: memoryStorage() }))
    for (const n of names) {
      await expect((api as any)[n]('a', 'b'), n).rejects.toMatchObject({ body: { action: `demo:${n}` } })
      expect(real[n], n).not.toHaveBeenCalled()
    }
    // Names the real api doesn't have are refused too, and the overlay is not a thenable
    await expect((api as any).somethingNew()).rejects.toMatchObject({ body: { action: 'demo:somethingNew' } })
    expect((api as any).then).toBeUndefined()
  })

  it('the demo never calls fetch', async () => {
    const spy = vi.fn(() => Promise.reject(new Error('network')))
    vi.stubGlobal('fetch', spy)
    const demo = createDemoApi({ trialId: 't1', now: () => NOW, storage: memoryStorage() })
    const api = overlayDemoApi({} as Record<string, (...a: any[]) => any>, demo)
    // Events
    const { events } = await api.getEvents()
    const { event } = await api.createEvent({ name: 'Party', startTime: new Date(NOW + DAY).toISOString(), timezone: 'UTC' })
    await api.updateEvent(event.id, { description: 'Bring friends' })
    const { scenes } = await api.getScenes()
    const { giveaways } = await api.getGiveaways()
    await api.linkSceneToEvent(event.id, scenes[0].id)
    await api.linkGiveawayToEvent(event.id, giveaways[0].id)
    const detail = await api.getEvent(event.id)
    expect(detail.event.sceneLinks).toHaveLength(1)
    expect(detail.event.giveawayLinks[0].giveaway.name).toBe(giveaways[0].name)
    await api.unlinkSceneFromEvent(event.id, scenes[0].id)
    await api.unlinkGiveawayFromEvent(event.id, giveaways[0].id)
    await api.deleteEvent(events[0].id)
    expect((await api.getEvents()).events).toHaveLength(3)
    // Giveaways
    expect((await api.getGiveawayAvailability()).enabled).toBe(true)
    const { giveaway } = await api.createGiveaway({ name: 'Hats' })
    await api.updateGiveaway(giveaway.id, { claimCap: 2, minPresentSeconds: 600 })
    const { items } = await api.getGiveawayCreatorItems('polygon')
    expect((await api.setGiveawayItems(giveaway.id, [items[0]])).items).toHaveLength(1)
    await api.setGiveawayScenes(giveaway.id, [scenes[0].id])
    expect((await api.getGiveaway(giveaway.id)).sceneIds).toEqual([scenes[0].id])
    expect((await api.getGiveawayClaims(giveaways[0].id)).claims).toHaveLength(5)
    await api.deleteGiveaway(giveaway.id)
    expect((await api.getGiveaways()).giveaways).toHaveLength(1)
    await expect(api.getGiveaway('nope')).rejects.toMatchObject({ status: 404 })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('clearDemoStores', () => {
  it('removes every demo store and nothing else', async () => {
    const storage = memoryStorage()
    storage.setItem('virvi.auth', 'x')
    await createDemoApi({ trialId: 't1', now: () => NOW, storage }).createEvent({ name: 'A' })
    await createDemoApi({ trialId: 't2', now: () => NOW, storage }).createEvent({ name: 'B' })
    clearDemoStores(storage)
    expect(storage.getItem(demoStorageKey('t1'))).toBeNull()
    expect(storage.getItem(demoStorageKey('t2'))).toBeNull()
    expect(storage.getItem('virvi.auth')).toBe('x')
  })
})
