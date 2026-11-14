import { describe, it, expect } from 'vitest'
import {
  BEAT_CHAINS, BEAT_CHAIN_INFO, BEAT_CONSENT_VERSION, BEAT_NAME_MAX, BEAT_DESCRIPTION_MAX, BEAT_SUPPLY_CAP_DEFAULT,
  BEAT_SUPPLY_CAP_MAX, BEAT_MIN_PRESENT_DEFAULT_MINUTES, BEAT_MIN_PRESENT_MAX_MINUTES, BEAT_IMAGE_MIN_PX, BEAT_MAX_BATCH,
  BEAT_CLAIM_GRACE_MS, BEAT_CARD_LEAD_MS, BEAT_RETENTION_DAYS, BEAT_JOB_EVERY_MS, BEAT_SEND_MAX_ATTEMPTS,
  BEAT_REPRICE_AFTER_MS, BEAT_FEE_BUMP_PERCENT, beatConsentText, beatPriceCents, beatTopupCents, beatTxUrl, beatTokenUrl,
} from '@virvixr/shared'

/** Shared BEAT constants and copy (LIV-11). The shared package has no runner of its own; its tests live here. */
const P = { baseCents: 500, includedMints: 100, extraMintCents: 2 }

describe('BEAT constants', () => {
  it('pins the values', () => {
    expect(BEAT_CHAINS).toEqual(['polygon-amoy', 'polygon'])
    expect(BEAT_CHAIN_INFO['polygon-amoy']).toEqual({ chainId: 80002, confirmations: 5, explorer: 'https://amoy.polygonscan.com', label: 'Polygon Amoy (test)' })
    expect(BEAT_CHAIN_INFO.polygon).toEqual({ chainId: 137, confirmations: 30, explorer: 'https://polygonscan.com', label: 'Polygon' })
    expect([BEAT_CONSENT_VERSION, BEAT_NAME_MAX, BEAT_DESCRIPTION_MAX, BEAT_SUPPLY_CAP_DEFAULT, BEAT_SUPPLY_CAP_MAX]).toEqual([1, 60, 500, 100, 5000])
    expect([BEAT_MIN_PRESENT_DEFAULT_MINUTES, BEAT_MIN_PRESENT_MAX_MINUTES, BEAT_IMAGE_MIN_PX, BEAT_MAX_BATCH]).toEqual([5, 120, 512, 200])
    expect([BEAT_CLAIM_GRACE_MS, BEAT_CARD_LEAD_MS, BEAT_RETENTION_DAYS, BEAT_JOB_EVERY_MS]).toEqual([86_400_000, 1_800_000, 30, 60_000])
    expect([BEAT_SEND_MAX_ATTEMPTS, BEAT_REPRICE_AFTER_MS, BEAT_FEE_BUMP_PERCENT]).toEqual([5, 600_000, 25])
  })
})

describe('beat price', () => {
  it('is the base up to the included mints, then per extra mint', () => {
    expect(beatPriceCents(100, P)).toBe(500)
    expect(beatPriceCents(1, P)).toBe(500)
    expect(beatPriceCents(101, P)).toBe(502)
    expect(beatPriceCents(5000, P)).toBe(10300)
  })
  it('tops up the difference', () => {
    expect(beatTopupCents(100, 150, P)).toBe(100)
  })
})

describe('beat copy and links', () => {
  it('has the exact consent text', () => {
    expect(beatConsentText('Gala')).toBe('To track your attendance for the Gala BEAT, Virvi stores your wallet address and display name for this BEAT. The hosts of this event will see them, and your wallet is needed to send you the token. You can stop tracking at any time before you claim.')
  })
  it('builds explorer links', () => {
    expect(beatTxUrl('polygon', '0xabc')).toBe('https://polygonscan.com/tx/0xabc')
    expect(beatTokenUrl('polygon-amoy', '0xC0', '7')).toBe('https://amoy.polygonscan.com/token/0xC0?a=7')
  })
})
