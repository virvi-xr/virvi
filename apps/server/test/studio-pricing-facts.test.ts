import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioJobs, studioMessages } from '../src/db/schema.js'
import { config, studioPricesFrom } from '../src/config.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { pricingFacts } from '../src/studio/pricing.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, fakeFly } from './helpers/studio.js'

const flat = (s: string) => s.replace(/\s+/g, ' ')

describe('pricing facts for the agent', () => {
  const defaults = studioPricesFrom({})

  it('a wearable: both body shapes for one price, extra pieces, revisions, top-ups and full rights', () => {
    const t = flat(pricingFacts('wearable', defaults))
    expect(t).toContain('$29')
    expect(t).toContain('$19')
    expect(t).toMatch(/both body shapes/)
    expect(t).toMatch(/one price/)
    expect(t).toContain('$15') // a revision
    expect(t).toContain('$10') // each other piece's revision in the same checkout
    expect(t).toContain('$5 for 10 more prompts')
    expect(t).toMatch(/sell/)
    expect(t).not.toContain('$39') // the emote price
  })

  it('an emote and a scene get their own prices', () => {
    const e = flat(pricingFacts('emote', defaults))
    expect(e).toContain('$39')
    expect(e).toContain('$20')
    expect(e).not.toContain('$19') // the wearable extra-piece price
    const s = flat(pricingFacts('scene', defaults))
    for (const p of ['$29', '$49', '$79', '$9', '$5', '$15', '$25', '$40']) expect(s).toContain(p)
    expect(s).toMatch(/4x4/)
  })

  it('follows the price settings, with cents when there are any', () => {
    const t = flat(pricingFacts('wearable', { ...defaults, wearable: 3450 }))
    expect(t).toContain('$34.50')
    expect(t).not.toContain('$29 ')
  })
})

describe('the prompt job carries the pricing facts', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage, key: config.anthropicApiKey }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
    ;(config as any).anthropicApiKey = null
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    ;(config as any).anthropicApiKey = prev.key
    setStudioStore(null)
    setMachineDeps(null)
  })
  beforeEach(async () => {
    await resetDb()
    setStudioStore(memoryStudioStore())
    setMachineDeps({ fly: fakeFly() })
    app = await testApp()
    owner = await createUser()
  })

  it("in the job's instructions, never in the conversation", async () => {
    const d = await createDesign(owner, { kind: 'emote' })
    const res = await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/prompts`, headers: { authorization: `Bearer ${tokenFor(owner)}` }, payload: { text: 'how much is it?' } })
    expect(res.statusCode).toBe(202)
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, res.json().jobId))
    expect((job.payload as any).pricing).toBe(pricingFacts('emote'))
    const msgs = await db.select().from(studioMessages).where(eq(studioMessages.designId, d.id))
    expect(msgs.map((m) => m.text)).toEqual(['how much is it?'])
  })
})
