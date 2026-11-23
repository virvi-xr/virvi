import { describe, it, expect } from 'vitest'
import {
  GIVEAWAY_CHAINS, GIVEAWAY_CONSENT_VERSION, GIVEAWAY_CLAIM_STATUSES, GIVEAWAY_PAUSE_REASONS, GIVEAWAY_FAIL_REASONS,
  GIVEAWAY_GAS_PER_ITEM, GIVEAWAY_MAX_CLAIMS_PER_TX, GIVEAWAY_JOB_EVERY_MS_DEFAULT, giveawayTxUrl, giveawayMarketplaceApi, giveawayBuilderUrl,
} from '@virvixr/shared'

describe('giveaway shared constants and links (LIV-194)', () => {
  it('pins the values', () => {
    expect(GIVEAWAY_CHAINS).toEqual(['polygon', 'polygon-amoy'])
    expect(GIVEAWAY_CONSENT_VERSION).toBe(1)
    expect(GIVEAWAY_CLAIM_STATUSES).toEqual(['present', 'waiting', 'minting', 'sent', 'failed'])
    expect(GIVEAWAY_PAUSE_REASONS).toEqual(['low_gas', 'not_minter', 'not_approved', 'rpc_down'])
    expect(GIVEAWAY_FAIL_REASONS).toEqual(['sold_out', 'reverted', 'ended'])
    expect([GIVEAWAY_GAS_PER_ITEM, GIVEAWAY_MAX_CLAIMS_PER_TX, GIVEAWAY_JOB_EVERY_MS_DEFAULT]).toEqual([120_000n, 40, 15_000])
  })

  it('links the transaction on each chain', () => {
    expect(giveawayTxUrl('polygon', '0xab')).toBe('https://polygonscan.com/tx/0xab')
    expect(giveawayTxUrl('polygon-amoy', '0xab')).toBe('https://amoy.polygonscan.com/tx/0xab')
  })

  it('names the marketplace API and Builder per chain', () => {
    expect(giveawayMarketplaceApi('polygon')).toBe('https://marketplace-api.decentraland.org')
    expect(giveawayMarketplaceApi('polygon-amoy')).toBe('https://marketplace-api.decentraland.zone')
    expect(giveawayBuilderUrl('polygon', '0x1')).toBe('https://decentraland.org/builder/collections')
    expect(giveawayBuilderUrl('polygon-amoy', '0x1')).toBe('https://decentraland.zone/builder/collections')
  })
})
