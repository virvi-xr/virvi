import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioIdeaUses, studioJobs, studioUsageDays, users } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { utcDay } from '../src/studio/quota.js'
import {
  EXCLUDE_MAX, IDEAS, IDEA_ID, IDEA_ID_MAX, IDEA_MOVES, IDEA_SLOTS, IDEA_TEXT_MAX, findIdea, pickIdeas, type Idea, type IdeaQuery,
} from '../src/studio/prompt-ideas.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, fakeFly } from './helpers/studio.js'

const wearables = IDEAS.filter((i): i is Extract<Idea, { kind: 'wearable' }> => i.kind === 'wearable')
const emotes = IDEAS.filter((i): i is Extract<Idea, { kind: 'emote' }> => i.kind === 'emote')
const single = (slot: string) => wearables.filter((i) => i.slots.length === 1 && i.slots[0] === slot)

/** A seeded random, so a failing draw can be replayed. */
function seeded(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}
const pick = (q: IdeaQuery, o: { retired?: string[]; exclude?: string[]; count?: number; seed?: number } = {}) =>
  pickIdeas(q, { retired: new Set(o.retired ?? []), exclude: new Set(o.exclude ?? []), count: o.count ?? 3, rand: seeded(o.seed ?? 1) })
const slotsQ = (...slots: string[]): IdeaQuery => ({ kind: 'wearable', mode: 'slots', slots })

describe('the prompt ideas pool', () => {
  it('has about 200 wearable ideas and 60 emote ideas, with unique well-formed ids', () => {
    expect(wearables.length).toBeGreaterThanOrEqual(190)
    expect(emotes.length).toBeGreaterThanOrEqual(60)
    const ids = IDEAS.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id, id).toMatch(IDEA_ID)
      expect(id.length, id).toBeLessThanOrEqual(IDEA_ID_MAX)
    }
  })

  it('gives every slot at least 6 single-piece ideas, the busy ones clearly more, and about 40 outfits', () => {
    for (const s of IDEA_SLOTS) expect(single(s).length, s).toBeGreaterThanOrEqual(6)
    const quiet = ['helmet', 'earring', 'tiara', 'top_head', 'facial_hair', 'hands_wear', 'skin']
    const most = Math.max(...quiet.map((s) => single(s).length))
    for (const s of ['hat', 'upper_body', 'lower_body', 'feet', 'hair', 'mask', 'eyewear']) expect(single(s).length, s).toBeGreaterThan(most)
    const outfits = wearables.filter((i) => i.slots.length > 1)
    expect(outfits.length).toBeGreaterThanOrEqual(40)
    for (const o of outfits) {
      expect(o.slots.length, o.id).toBeLessThanOrEqual(4)
      expect(new Set(o.slots).size, o.id).toBe(o.slots.length)
      for (const s of o.slots) expect(IDEA_SLOTS as readonly string[], o.id).toContain(s)
    }
  })

  it('gives every kind of move at least 10 ideas, with loops and play-once ones, and says which in the words', () => {
    for (const m of IDEA_MOVES) {
      const of = emotes.filter((i) => i.move === m)
      expect(of.length, m).toBeGreaterThanOrEqual(10)
      expect(of.some((i) => i.playback === 'loop'), m).toBe(true)
      expect(of.some((i) => i.playback === 'once'), m).toBe(true)
    }
    for (const i of emotes) expect(i.text, i.id).toMatch(i.playback === 'loop' ? /\bIt loops\.$/ : /\bIt plays once\.$/)
  })

  it('keeps the words short and plain: one to three sentences, at most 300 characters, no exclamation marks or emoji', () => {
    for (const i of IDEAS) {
      expect(i.text.length, i.id).toBeLessThanOrEqual(IDEA_TEXT_MAX)
      expect(i.text, i.id).not.toMatch(/[!\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u)
      expect(i.text, i.id).toBe(i.text.trim())
      const sentences = i.text.split(/(?<=\.)\s+/).filter(Boolean)
      expect(sentences.length, i.id).toBeGreaterThanOrEqual(1)
      expect(sentences.length, i.id).toBeLessThanOrEqual(3)
    }
    expect(new Set(IDEAS.map((i) => i.text)).size).toBe(IDEAS.length)
  })

  it('names a style in every wearable idea, with a spread of styles across the pool', () => {
    const STYLES = ['cartoon', 'realistic', 'low-poly', 'pixel art', 'painterly', 'cel-shaded', 'stylized', 'futuristic', 'retro', 'steampunk', 'minimal']
    const used = new Map<string, number>()
    for (const i of wearables) {
      const found = STYLES.filter((s) => i.text.toLowerCase().includes(s))
      expect(found.length, i.id).toBeGreaterThan(0)
      for (const s of found) used.set(s, (used.get(s) ?? 0) + 1)
    }
    for (const s of ['cartoon', 'realistic', 'low-poly', 'pixel art', 'painterly', 'cel-shaded', 'stylized']) expect(used.get(s) ?? 0, s).toBeGreaterThanOrEqual(10)
  })

  // A modest list of the obvious ones, not a complete check: the ideas were also reviewed by hand
  it('names no obvious brand, franchise, character, crypto project or famous artwork', () => {
    const BANNED = [
      'nike', 'adidas', 'gucci', 'prada', 'chanel', 'louis vuitton', 'balenciaga', 'supreme', 'converse', 'vans', 'rolex', 'ray-ban',
      'disney', 'pixar', 'marvel', 'batman', 'superman', 'spider-man', 'spiderman', 'star wars', 'jedi', 'harry potter', 'hogwarts',
      'pokemon', 'pokémon', 'pikachu', 'mario', 'luigi', 'zelda', 'sonic', 'minecraft', 'fortnite', 'roblox', 'hello kitty', 'sanrio',
      'naruto', 'ghibli', 'totoro', 'barbie', 'lego', 'coca-cola', 'mcdonald', 'bitcoin', 'ethereum', 'bored ape', 'cryptopunk', 'nft',
      'decentraland', 'mona lisa', 'starry night', 'van gogh', 'cinderella', 'elsa', 'mickey', 'shrek', 'kawaii', 'samurai', 'ninja', 'viking', 'tribal',
    ]
    for (const i of IDEAS) {
      for (const b of BANNED) expect(new RegExp(`\\b${b}\\b`, 'i').test(i.text), `${i.id}: ${b}`).toBe(false)
      expect(i.text, i.id).not.toMatch(/[™®©]/)
    }
  })
})

describe('choosing prompt ideas', () => {
  it('for ticked slots: the exact pieces first, then any idea covering them all, then ideas covering any, never none', () => {
    const feet = pick(slotsQ('feet'), { count: 40 }).ideas
    expect(feet.slice(0, single('feet').length).every((i) => i.kind === 'wearable' && i.slots.join() === 'feet')).toBe(true)
    expect(feet.every((i) => i.kind === 'wearable' && i.slots.includes('feet'))).toBe(true)

    const both = pick(slotsQ('hat', 'feet'), { count: 300 }).ideas as Extract<Idea, { kind: 'wearable' }>[]
    const coversAll = both.findIndex((i) => !(i.slots.includes('hat') && i.slots.includes('feet')))
    expect(coversAll).toBeGreaterThan(0)
    // everything covering both comes before everything covering one
    expect(both.slice(coversAll).every((i) => !(i.slots.includes('hat') && i.slots.includes('feet')))).toBe(true)
    expect(both.every((i) => i.slots.includes('hat') || i.slots.includes('feet'))).toBe(true)
    expect(both.some((i) => i.slots.join() === 'hat')).toBe(true)
    expect(both.some((i) => i.slots.join() === 'feet')).toBe(true)
  })

  it('for a full outfit: outfits only; for not sure or nothing ticked: a mix across slots', () => {
    const outfit = pick({ kind: 'wearable', mode: 'outfit', slots: [] }, { count: 10 }).ideas
    expect(outfit).toHaveLength(10)
    expect(outfit.every((i) => i.kind === 'wearable' && i.slots.length > 1)).toBe(true)
    for (const q of [{ kind: 'wearable', mode: 'unsure', slots: [] }, slotsQ()] as IdeaQuery[]) {
      for (let seed = 1; seed < 20; seed++) {
        const three = pick(q, { seed }).ideas as Extract<Idea, { kind: 'wearable' }>[]
        const groups = three.map((i) => (i.slots.length > 1 ? 'outfit' : i.slots[0]))
        expect(new Set(groups).size, groups.join()).toBe(3)
      }
    }
    // never an emote
    expect(pick(slotsQ(), { count: 300 }).ideas.every((i) => i.kind === 'wearable')).toBe(true)
  })

  it('for emotes: both the move and the playback first, then either, never neither; nothing chosen is a mix of moves', () => {
    const r = pick({ kind: 'emote', move: 'dance', playback: 'once' }, { count: 100 }).ideas as Extract<Idea, { kind: 'emote' }>[]
    const exact = emotes.filter((i) => i.move === 'dance' && i.playback === 'once').length
    expect(r.slice(0, exact).every((i) => i.move === 'dance' && i.playback === 'once')).toBe(true)
    expect(r.slice(exact).every((i) => (i.move === 'dance') !== (i.playback === 'once'))).toBe(true)
    expect(r.length).toBe(emotes.filter((i) => i.move === 'dance' || i.playback === 'once').length)
    expect((pick({ kind: 'emote', move: 'prop', playback: null }, { count: 100 }).ideas as typeof r).every((i) => i.move === 'prop')).toBe(true)
    expect((pick({ kind: 'emote', move: null, playback: 'loop' }, { count: 100 }).ideas as typeof r).every((i) => i.playback === 'loop')).toBe(true)
    for (let seed = 1; seed < 20; seed++) {
      const three = pick({ kind: 'emote', move: null, playback: null }, { seed }).ideas as typeof r
      expect(new Set(three.map((i) => i.move)).size).toBe(3)
    }
  })

  it('skips the ideas already seen, says whether unseen ones remain, and starts over once everything was seen', () => {
    const q = slotsQ('skin')
    const all = pick(q, { count: 100 }).ideas.map((i) => i.id)
    const seen: string[] = []
    for (;;) {
      const r = pick(q, { exclude: seen, seed: seen.length + 1 })
      expect(r.ideas.length).toBe(3)
      const fresh = r.ideas.filter((i) => !seen.includes(i.id))
      seen.push(...fresh.map((i) => i.id))
      if (!r.more) break
      expect(fresh).toHaveLength(3)
    }
    expect(new Set(seen)).toEqual(new Set(all))
    // everything seen: the matching set again, not nothing
    const again = pick(q, { exclude: seen })
    expect(again.ideas).toHaveLength(3)
    expect(again.more).toBe(false)
    expect(again.ideas.every((i) => all.includes(i.id))).toBe(true)
  })

  it('never serves a retired idea, even once everything else was seen', () => {
    const q = slotsQ('facial_hair')
    const all = pick(q, { count: 100 }).ideas.map((i) => i.id)
    const retired = all.slice(0, all.length - 2)
    for (let seed = 1; seed < 10; seed++) {
      const r = pick(q, { retired, exclude: all, seed })
      expect(r.ideas.map((i) => i.id).sort()).toEqual(all.slice(-2).sort())
      expect(r.more).toBe(false)
    }
    expect(pick(q, { retired: all }).ideas).toEqual([])
  })
})

describe('prompt ideas routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
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
  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const ideas = (id: string, query = '', headers: Record<string, string> = as(owner)) =>
    app.inject({ method: 'GET', url: `/api/studio/designs/${id}/prompt-ideas${query ? `?${query}` : ''}`, headers })
  const prompt = (id: string, body: Record<string, unknown>, headers: Record<string, string> = as(owner)) =>
    app.inject({ method: 'POST', url: `/api/studio/designs/${id}/prompts`, headers, payload: body })
  const finishJob = async (designId: string) =>
    db.update(studioJobs).set({ status: 'done', finishedAt: new Date() }).where(eq(studioJobs.designId, designId))
  const uses = () => db.select().from(studioIdeaUses)

  it('serves three ideas for the ticked slots, as ids and words only', async () => {
    const d = await createDesign(owner)
    const res = await ideas(d.id, 'slots=feet&mode=slots')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.more).toBe(true)
    expect(body.ideas).toHaveLength(3)
    for (const i of body.ideas) {
      expect(Object.keys(i).sort()).toEqual(['id', 'text'])
      expect((findIdea(i.id) as Extract<Idea, { kind: 'wearable' }>).slots).toContain('feet')
    }
  })

  it('follows the other chips: outfit, not sure, emotes, count and exclude', async () => {
    const d = await createDesign(owner)
    const outfit = (await ideas(d.id, 'mode=outfit&count=5')).json().ideas
    expect(outfit).toHaveLength(5)
    expect(outfit.every((i: { id: string }) => (findIdea(i.id) as Extract<Idea, { kind: 'wearable' }>).slots.length > 1)).toBe(true)
    expect((await ideas(d.id, 'mode=unsure')).json().ideas).toHaveLength(3)
    expect((await ideas(d.id)).json().ideas.every((i: { id: string }) => findIdea(i.id)?.kind === 'wearable')).toBe(true)

    const skins = single('skin').map((i) => i.id)
    const r = (await ideas(d.id, `slots=skin&exclude=${skins.slice(0, -1).join(',')}`)).json()
    expect(r.ideas[0].id).toBe(skins[skins.length - 1])

    const e = await createDesign(owner, { kind: 'emote' })
    const dances = (await ideas(e.id, 'move=dance&playback=loop')).json().ideas
    expect(dances.every((i: { id: string }) => {
      const x = findIdea(i.id) as Extract<Idea, { kind: 'emote' }>
      return x.move === 'dance' && x.playback === 'loop'
    })).toBe(true)
    // the slots don't apply to an emote
    expect((await ideas(e.id, 'slots=hat')).json().ideas.every((i: { id: string }) => findIdea(i.id)?.kind === 'emote')).toBe(true)

    const scene = await createDesign(owner, { kind: 'scene' })
    expect((await ideas(scene.id)).json()).toEqual({ ideas: [], more: false })
  })

  it('checks the query', async () => {
    const d = await createDesign(owner)
    for (const q of ['count=0', 'count=7', 'count=two', 'mode=all', 'slots=cape', 'slots=hat,,feet', 'move=jump', 'playback=twice']) {
      expect((await ideas(d.id, q)).statusCode, q).toBe(400)
    }
    // an exclude list past the cap keeps its latest ids; unknown ids in it are skipped
    const many = [...Array.from({ length: EXCLUDE_MAX + 50 }, (_, i) => `gone-${i}`), 'not an id']
    expect((await ideas(d.id, `exclude=${encodeURIComponent(many.join(','))}`)).statusCode).toBe(200)
  })

  it('is the owner’s (and support’s, and a trial’s on its own design), like the design page', async () => {
    const d = await createDesign(owner)
    expect((await ideas(d.id, '', as(await createUser()))).statusCode).toBe(404)
    expect((await ideas('not-a-uuid')).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/studio/designs/${d.id}/prompt-ideas` })).statusCode).toBe(401)
    expect((await ideas(d.id, '', as(await createUser({ role: 'admin' })))).statusCode).toBe(200)

    const t = await createUser({ email: null })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, t.id))
    const { accessToken } = issueTrialSession(app, { id: t.id, displayName: t.displayName, role: 'creator', trialLastActiveAt: new Date() })
    const trial = { authorization: `Bearer ${accessToken}` }
    expect((await ideas((await createDesign(t)).id, '', trial)).statusCode).toBe(200)
    expect((await ideas(d.id, '', trial)).statusCode).toBe(404)
  })

  it('retires an idea once it is sent as a first prompt, edited or not, for everyone', async () => {
    const d = await createDesign(owner)
    const idea = single('skin')[0]
    const res = await prompt(d.id, { text: `${idea.text} Make it gold.`, selectedSlots: ['skin'], ideaId: idea.id })
    expect(res.statusCode).toBe(202)
    const [use] = await uses()
    expect(use).toMatchObject({ ideaId: idea.id, userId: owner.id, designId: d.id })
    // never sent to the agent
    const [job] = await db.select().from(studioJobs)
    expect(JSON.stringify(job.payload)).not.toContain(idea.id)

    // nobody is offered it again, whatever they saw
    const other = await createUser()
    const theirs = await createDesign(other)
    for (let i = 0; i < 5; i++) {
      const r = (await ideas(theirs.id, `slots=skin&count=6&exclude=${single('skin').map((x) => x.id).join(',')}`, as(other))).json()
      expect(r.ideas.map((x: { id: string }) => x.id)).not.toContain(idea.id)
    }
    // someone else sending it too (a page loaded before) is still accepted, and the first use stays
    expect((await prompt(theirs.id, { text: idea.text, ideaId: idea.id }, as(other))).statusCode).toBe(202)
    expect(await uses()).toHaveLength(1)
    expect((await uses())[0].userId).toBe(owner.id)
  })

  it('ignores the idea on a later prompt, and on a refused one', async () => {
    const d = await createDesign(owner)
    expect((await prompt(d.id, { text: 'a neon cap' })).statusCode).toBe(202)
    await finishJob(d.id)
    const idea = single('hat')[0]
    expect((await prompt(d.id, { text: idea.text, ideaId: idea.id })).statusCode).toBe(202)
    expect(await uses()).toHaveLength(0)

    // over the day's allowance: refused, so the idea stays free
    const e = await createDesign(owner)
    await db.insert(studioUsageDays).values({ userId: owner.id, day: utcDay(new Date()), prompts: 99, costUsd: 0 })
      .onConflictDoUpdate({ target: [studioUsageDays.userId, studioUsageDays.day], set: { prompts: 99 } })
    const refused = await prompt(e.id, { text: idea.text, ideaId: idea.id })
    expect(refused.statusCode).toBe(429)
    expect(await uses()).toHaveLength(0)
  })

  it('refuses an unknown idea, or one of another kind, with 400 and sends nothing', async () => {
    const d = await createDesign(owner)
    for (const ideaId of ['no-such-idea', 3, '', emotes[0].id]) {
      expect((await prompt(d.id, { text: 'a hat', ideaId })).statusCode, String(ideaId)).toBe(400)
    }
    expect(await db.select().from(studioJobs)).toHaveLength(0)
    expect(await uses()).toHaveLength(0)
  })
})

describe('prompt ideas on the admin page', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  const counts = async (u: TestUser) => app.inject({ method: 'GET', url: '/api/admin/studio/ideas', headers: { authorization: `Bearer ${tokenFor(u)}` } })

  it('counts what is left per slot (outfits included), for outfits and per move; admins only', async () => {
    expect((await counts(await createUser())).statusCode).toBe(403)
    const admin = await createUser({ role: 'admin' })
    const skins = wearables.filter((i) => i.slots.includes('skin'))
    const outfit = wearables.find((i) => i.slots.length > 1 && i.slots.includes('hat'))!
    await db.insert(studioIdeaUses).values([...skins.slice(0, -2), outfit, emotes.find((i) => i.move === 'prop')!].map((i) => ({ ideaId: i.id })))
    const res = await counts(admin)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.low).toBe(3)
    const row = (list: { key: string }[], key: string) => list.find((r) => r.key === key)
    expect(body.wearable.map((r: { key: string }) => r.key)).toEqual([...IDEA_SLOTS, 'outfit'])
    expect(row(body.wearable, 'skin')).toEqual({ key: 'skin', left: 2, total: skins.length })
    const hats = wearables.filter((i) => i.slots.includes('hat')).length
    expect(row(body.wearable, 'hat')).toEqual({ key: 'hat', left: hats - 1, total: hats })
    const outfits = wearables.filter((i) => i.slots.length > 1).length
    expect(row(body.wearable, 'outfit')).toEqual({ key: 'outfit', left: outfits - 1, total: outfits })
    const props = emotes.filter((i) => i.move === 'prop').length
    expect(body.emote.map((r: { key: string }) => r.key)).toEqual([...IDEA_MOVES])
    expect(row(body.emote, 'prop')).toEqual({ key: 'prop', left: props - 1, total: props })
  })
})
