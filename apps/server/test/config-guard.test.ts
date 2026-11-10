import { describe, it, expect } from 'vitest'
import { assertProductionSecrets, assertScalableRedis, validDeployKey, studioPricesFrom } from '../src/config.js'

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
  it('refuses a malformed key, naming the variable without printing the value', () => {
    for (const bad of ['0x1234', `${key}00`, 'z'.repeat(64), '0'.repeat(64), 'f'.repeat(64)]) {
      let message = ''
      try { validDeployKey(bad) } catch (err) { message = String(err) }
      expect(message).toMatch(/VIRVI_DCL_DEPLOY_KEY is not a valid private key/)
      expect(message).not.toMatch(/zzzz|ffff|1234|0000/)
    }
  })
  it('names the Genesis City key when it is the malformed one', () => {
    expect(() => validDeployKey('f'.repeat(64), 'VIRVI_DCL_PARCEL_DEPLOY_KEY')).toThrow(/VIRVI_DCL_PARCEL_DEPLOY_KEY/)
    expect(validDeployKey(key, 'VIRVI_DCL_PARCEL_DEPLOY_KEY')).toBe(`0x${key}`)
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

describe('assertScalableRedis', () => {
  it('refuses scalable mode without REDIS_URL', () => {
    expect(() => assertScalableRedis({ mode: 'scalable' })).toThrow(/REDIS_URL must be set in scalable mode/)
    expect(() => assertScalableRedis({ mode: 'scalable', redisUrl: '  ' })).toThrow(/REDIS_URL/)
  })
  it('allows scalable with Redis, and single and cloud without it', () => {
    expect(() => assertScalableRedis({ mode: 'scalable', redisUrl: 'redis://redis:6379' })).not.toThrow()
    expect(() => assertScalableRedis({ mode: 'single' })).not.toThrow()
    expect(() => assertScalableRedis({ mode: 'cloud' })).not.toThrow()
  })
})
