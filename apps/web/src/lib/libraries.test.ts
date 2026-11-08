import { describe, it, expect } from 'vitest'
import { ASSET_LIBRARY, MEDIA_LIBRARY, MEDIA_UPLOAD_RULES, asPickerModel, isModelFile, splitModelFiles, uploadErrorMessage } from './libraries'

describe('the two libraries (LIV-132)', () => {
  it('says what each library is for', () => {
    expect(MEDIA_LIBRARY.purpose).toBe('Images and video for your scenes')
    expect(ASSET_LIBRARY.purpose).toBe('3D models, your own and shared ones')
  })
  it("tells the truth about who sees an upload: it's listed for you, but its link opens for anyone", () => {
    expect(MEDIA_LIBRARY.uploadHelp).toMatch(/only you/i)
    expect(MEDIA_LIBRARY.uploadHelp).toMatch(/anyone with the link/i)
    expect(ASSET_LIBRARY.uploadHelp).toMatch(/private/i)
    expect(ASSET_LIBRARY.uploadHelp).toMatch(/anyone with the link/i)
    // No publish control exists yet (LIV-20): the copy mustn't promise one
    expect(ASSET_LIBRARY.uploadHelp).not.toMatch(/publish/i)
  })
  it('the Media upload rules no longer list GLB', () => {
    expect(MEDIA_UPLOAD_RULES).not.toMatch(/GLB/)
    expect(MEDIA_UPLOAD_RULES).toMatch(/PNG/)
    expect(MEDIA_UPLOAD_RULES).toMatch(/MP4/)
  })
})

describe('isModelFile', () => {
  it('spots GLB and glTF by name or type', () => {
    expect(isModelFile({ name: 'duck.GLB', type: '' })).toBe(true)
    expect(isModelFile({ name: 'duck.gltf', type: 'application/octet-stream' })).toBe(true)
    expect(isModelFile({ name: 'duck', type: 'model/gltf-binary' })).toBe(true)
    expect(isModelFile({ name: 'a.png', type: 'image/png' })).toBe(false)
    expect(isModelFile({ name: 'clip.mp4', type: 'video/mp4' })).toBe(false)
  })
  it('splits a picked set into media and models', () => {
    const files = [{ name: 'a.png', type: 'image/png' }, { name: 'b.glb', type: '' }]
    expect(splitModelFiles(files)).toEqual({ media: [files[0]], models: [files[1]] })
  })
})

describe('uploadErrorMessage', () => {
  it('points a refused model to 3D Models', () => {
    expect(uploadErrorMessage({ message: 'use_asset_library' })).toMatch(/3D Models page/)
  })
  it('keeps the old messages', () => {
    expect(uploadErrorMessage({ message: 'unsupported_type' })).toBe(MEDIA_UPLOAD_RULES)
    expect(uploadErrorMessage({ message: 'too_large' })).toBe(MEDIA_UPLOAD_RULES)
    expect(uploadErrorMessage({ message: 'HTTP 413' })).toBe(MEDIA_UPLOAD_RULES)
    expect(uploadErrorMessage({ message: 'boom' })).toBe('boom')
    expect(uploadErrorMessage({})).toBe('Upload failed')
  })

  it('names the libraries Images & Video and 3D Models (LIV-132)', () => {
    expect(MEDIA_LIBRARY.name).toBe('Images & Video')
    expect(ASSET_LIBRARY.name).toBe('3D Models')
    expect(ASSET_LIBRARY.uploadHelp).toMatch(/My Models/)
  })

  it('lists a 3D Models item in the model picker as a GLB at its URL', () => {
    expect(asPickerModel({ id: 'a1', name: 'Chair', cdnUrl: 'https://cdn/x.glb' })).toEqual({ id: 'a1', filename: 'Chair', publicUrl: 'https://cdn/x.glb', contentType: 'model/gltf-binary' })
  })
})
