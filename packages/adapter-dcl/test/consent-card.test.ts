import { describe, it, expect, vi } from 'vitest'
import { ANALYTICS_CONSENT_TEXT, VISITOR_PRIVACY_URL } from '@virvixr/shared'
import { consentAction, consentCardView, type ConsentLike } from '../src/consent/card.js'

const c = (over: Partial<ConsentLike> = {}): ConsentLike => ({ state: 'undecided', open: true, canClose: false, ...over })
const ids = (v: ReturnType<typeof consentCardView>) => v.card?.actions.map((a) => `${a.id}:${a.label}`)

describe('consentCardView', () => {
  it('shows nothing while the decision is loading, nor without analytics', () => {
    expect(consentCardView(null)).toEqual({ card: null, chip: false })
    expect(consentCardView(c({ state: 'loading', open: false }))).toEqual({ card: null, chip: false })
  })

  it('asks a visitor with no decision: the notice, Accept and Decline, and the privacy link', () => {
    const v = consentCardView(c())
    expect(v.chip).toBe(false)
    expect(v.card).toMatchObject({ title: 'Privacy', body: ANALYTICS_CONSENT_TEXT, link: 'Privacy: virvi.io/privacy', current: null })
    expect(ids(v)).toEqual(['accept:Accept', 'decline:Decline'])
  })

  it('after a decision, only a small Privacy entry stays', () => {
    for (const state of ['accepted', 'declined'] as const) expect(consentCardView(c({ state, open: false }))).toEqual({ card: null, chip: true })
  })

  it('reopened from Privacy: says what was chosen, and can be closed', () => {
    expect(consentCardView(c({ state: 'declined', canClose: true })).card).toMatchObject({ current: "You declined: Virvi isn't recording your visit." })
    const v = consentCardView(c({ state: 'accepted', canClose: true }))
    expect(v.card?.current).toBe('You accepted.')
    expect(ids(v)).toEqual(['accept:Accept', 'decline:Decline', 'close:Close'])
  })
})

describe('consentAction', () => {
  it('passes each press to the decision, and opens the privacy page through the adapter', () => {
    const consent = { decide: vi.fn(async () => {}), reopen: vi.fn(), close: vi.fn() }
    const openUrl = vi.fn()
    consentAction('accept', consent, openUrl)
    consentAction('decline', consent, openUrl)
    consentAction('reopen', consent, openUrl)
    consentAction('close', consent, openUrl)
    consentAction('privacy', consent, openUrl)
    expect(consent.decide.mock.calls).toEqual([['accept'], ['decline']])
    expect(consent.reopen).toHaveBeenCalledTimes(1)
    expect(consent.close).toHaveBeenCalledTimes(1)
    expect(openUrl).toHaveBeenCalledWith(VISITOR_PRIVACY_URL)
  })
})
