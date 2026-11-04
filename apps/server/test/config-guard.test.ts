import { describe, it, expect, vi } from 'vitest'
import { assertProductionSecrets, validDeployKey, studioPricesFrom } from '../src/config.js'

describe('assertProductionSecrets', () => {
  it('refuses the dev or an empty secret in cloud mode or NODE_ENV=production', () => {
    expect(() => assertProductionSecrets({ mode: 'cloud', jwtSecret: 'dev-secret-change-me' })).toThrow('JWT_SECRET must be set in production')
    expect(() => assertProductionSecrets({ mode: 'single', nodeEnv: 'production', jwtSecret: '' })).toThrow('JWT_SECRET must be set in production')
  })
  it('allows the dev secret locally and real secrets in production', () => {
    expect(() => assertProductionSecrets({ mode: 'single', jwtSecret: 'dev-secret-change-me' })).not.toThrow()
    expect(() => assertProductionSecrets({ mode: 'cloud', jwtSecret: 'a-real-secret' })).not.toThrow()
  })
})

describe('validDeployKey', () => {
  const key = 'ab'.repeat(32)
  it('accepts a 32-byte hex private key, with or without 0x', () => {
    expect(validDeployKey(key)).toBe(`0x${key}`)
    expect(validDeployKey(` 0x${key.toUpperCase()} `)).toBe(`0x${key.toUpperCase()}`)
    expect(validDeployKey(undefined)).toBeNull()
  })
  it('treats a malformed key as unset and warns without printing it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const bad of ['0x1234', `${key}00`, 'z'.repeat(64), '0'.repeat(64), 'f'.repeat(64)]) expect(validDeployKey(bad)).toBeNull()
      expect(warn).toHaveBeenCalled()
      for (const call of warn.mock.calls) expect(String(call)).not.toMatch(/zzzz|ffff|1234/)
    } finally {
      warn.mockRestore()
    }
  })
  it('names the Genesis City key in its warning, still without printing it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(validDeployKey('f'.repeat(64), 'VIRVI_DCL_PARCEL_DEPLOY_KEY')).toBeNull()
      expect(validDeployKey(key, 'VIRVI_DCL_PARCEL_DEPLOY_KEY')).toBe(`0x${key}`)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0])).toMatch(/VIRVI_DCL_PARCEL_DEPLOY_KEY/)
      expect(String(warn.mock.calls[0])).not.toMatch(/ffff/)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('studioPricesFrom', () => {
  it('studio prices default and refuse bad values', () => {
    expect(studioPricesFrom({})).toEqual({
      wearable: 2900, extraPiece: 1900, emote: 3900,
      revisionWearable: 1500, revisionExtraPiece: 1000, revisionEmote: 2000,
      furniture: 900, furnitureExtra: 500, revisionFurniture: 500,
      buildingSmall: 2900, buildingMedium: 4900, buildingLarge: 7900,
      revisionBuildingSmall: 1500, revisionBuildingMedium: 2500, revisionBuildingLarge: 4000,
      giftCapCents: 2900,
      topupCents: 500, topupPrompts: 10,
    })
    expect(studioPricesFrom({ STUDIO_PRICE_BUILDING_LARGE_CENTS: '9900' }).buildingLarge).toBe(9900)
    expect(studioPricesFrom({ STUDIO_PRICE_WEARABLE_CENTS: '3500' }).wearable).toBe(3500)
    expect(() => studioPricesFrom({ STUDIO_PRICE_EMOTE_CENTS: 'abc' })).toThrow(/STUDIO_PRICE_EMOTE_CENTS/)
    expect(() => studioPricesFrom({ STUDIO_TOPUP_PROMPTS: '-1' })).toThrow(/STUDIO_TOPUP_PROMPTS/)
    expect(() => studioPricesFrom({ STUDIO_REVISION_EMOTE_CENTS: '1.5' })).toThrow()
  })
})
