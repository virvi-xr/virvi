import { describe, it, expect } from 'vitest'
import { resolveStorageProvider } from '../src/storage/index.js'

describe('resolveStorageProvider', () => {
  it('uses STORAGE_PROVIDER when it is local, s3 or r2', () => {
    expect(resolveStorageProvider({ STORAGE_PROVIDER: 'local', VIRVI_MODE: 'cloud' })).toBe('local')
    expect(resolveStorageProvider({ STORAGE_PROVIDER: 's3' })).toBe('s3')
    expect(resolveStorageProvider({ STORAGE_PROVIDER: ' r2 ' })).toBe('r2')
  })
  it('defaults to s3 in cloud mode and local disk otherwise', () => {
    expect(resolveStorageProvider({ VIRVI_MODE: 'cloud' })).toBe('s3')
    expect(resolveStorageProvider({ VIRVI_MODE: 'single' })).toBe('local')
    expect(resolveStorageProvider({})).toBe('local')
  })
  it('refuses an unknown provider instead of quietly storing on local disk', () => {
    expect(() => resolveStorageProvider({ STORAGE_PROVIDER: 'supabase' })).toThrow(
      "STORAGE_PROVIDER=supabase isn't supported. Use local, s3 or r2.",
    )
    expect(() => resolveStorageProvider({ STORAGE_PROVIDER: 'S3' })).toThrow(/isn't supported/)
  })
})
