import { describe, it, expect, vi } from 'vitest'
import { normalizeVolume } from '@virvixr/shared'
import { SceneManager } from '../src/SceneManager.js'
import { VirviStorageImpl } from '../src/storage.js'
import { EventBus } from '../src/events/EventBus.js'

/**
 * The dashboard stores volume from 0 to 1 (its slider, default 1). Decentraland read it as 0 to 100, so every sound and
 * screen played at about 1% (LIV-196). Older 0-100 values still read as percentages.
 */
describe('volume', () => {
  it('normalizeVolume', () => {
    expect(normalizeVolume(1)).toBe(1)
    expect(normalizeVolume(0.4)).toBe(0.4)
    expect(normalizeVolume(80)).toBe(0.8)
    expect(normalizeVolume(250)).toBe(1)
    expect(normalizeVolume(-1)).toBe(0)
    expect(normalizeVolume(undefined)).toBe(1)
    expect(normalizeVolume('loud', 0.5)).toBe(0.5)
  })

  it("a sound plays at the dashboard's volume", () => {
    const adapter: any = {
      capabilities: { platformName: 'test' }, createEntity: vi.fn(() => 1), destroyEntity: vi.fn(), entityExists: () => true,
      setTransform: vi.fn(), setAudioSource: vi.fn(), setAudioStream: vi.fn(),
    }
    const sm = new SceneManager(adapter, VirviStorageImpl.create(), new EventBus())
    sm.handlePresetUpdate({ action: 'init', scenePreset: { sounds: [{ sk: 's', enabled: true, audioSrc: 'https://a/x.mp3', volume: 0.4, sourceType: 1, instances: [{ sk: 'i', enabled: true, position: { x: 0, y: 0, z: 0 } }] }] } })
    const calls = [...adapter.setAudioSource.mock.calls, ...adapter.setAudioStream.mock.calls]
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0][1]).toMatchObject({ volume: 0.4 })
  })
})
