import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkFilePath, memoryStudioStore, localStudioStore, jobFileKey, workspaceKey } from '../src/studio/store.js'

describe('studio store', () => {
  it('file paths follow the contract', () => {
    expect(checkFilePath('pieces/hat/neon_cap_male.glb')).toEqual({ ok: true, kind: 'piece', category: 'hat' })
    expect(checkFilePath('pieces/hat/piece.json')).toEqual({ ok: true, kind: 'piece', category: 'hat' })
    expect(checkFilePath('checks/hat.txt')).toEqual({ ok: true, kind: 'check', category: 'hat' })
    // the frame a render stopped on as blank, kept privately (CONTRACT.md)
    expect(checkFilePath('checks/hat/orbit-male-blank-003.png')).toEqual({ ok: true, kind: 'check', category: 'hat' })
    expect(checkFilePath('renders/hat/spin-male-outfit-2/007.webp')).toEqual({ ok: true, kind: 'render', category: 'hat' })
    expect(checkFilePath('final/hat/package.zip')).toEqual({ ok: true, kind: 'final', category: 'hat' })
    for (const bad of [
      '../x',
      'pieces/hat/../../workspace.tar.gz',
      '/pieces/hat/a.glb',
      'pieces/hat/a.blend',
      'renders/hat/spin/7.webp',
      'checks/hat.txt/x',
      'checks/hat/orbit-male-blank-003.txt',
      'checks/hat/../orbit.png',
      'checks/hat/Orbit.png',
      'pieces/Hat/a.glb',
      'pieces/hat/a b.glb',
      'final/hat/x.glb',
      'final/hat/../package.zip',
      'final/hat/package.zip/x',
      'pieces/hat/' + 'a'.repeat(186) + '.glb',
    ]) {
      const r = checkFilePath(bad)
      expect(r.ok, bad).toBe(false)
      if (!r.ok) expect(r.reason).toBeTruthy()
    }
    expect(('pieces/hat/' + 'a'.repeat(186) + '.glb').length).toBe(201)
  })

  it('builds the bucket keys', () => {
    expect(workspaceKey('d1')).toBe('designs/d1/workspace.tar.gz')
    expect(jobFileKey('d1', 'j1', 'pieces/hat/a.glb')).toBe('designs/d1/jobs/j1/pieces/hat/a.glb')
  })

  for (const [name, make] of [
    ['memory', () => memoryStudioStore()],
    ['local', () => localStudioStore(mkdtempSync(join(tmpdir(), 'studio-store-')))],
  ] as const) {
    it(`${name} store round-trips and deletes by prefix`, async () => {
      const s = make()
      await s.put('designs/d1/a', Buffer.from('a'), 'text/plain')
      await s.put('designs/d1/jobs/j/b.webp', Buffer.from('b'), 'image/webp')
      await s.put('designs/d2/c', Buffer.from('c'), 'text/plain')
      const got = await s.get('designs/d1/jobs/j/b.webp')
      expect(got?.body.toString()).toBe('b')
      expect(got?.contentType).toBe('image/webp')
      expect(await s.deletePrefix('designs/d1/')).toBe(2)
      expect(await s.get('designs/d1/a')).toBeNull()
      expect((await s.get('designs/d2/c'))?.body.toString()).toBe('c')
      expect(await s.get('designs/nope')).toBeNull()
      const { Readable } = await import('node:stream')
      await s.putStream('designs/d3/workspace.tar.gz', Readable.from([Buffer.from('ab'), Buffer.from('cd')]), 4, 'application/gzip')
      const st = await s.getStream('designs/d3/workspace.tar.gz')
      const chunks: Buffer[] = []
      for await (const c of st!.body) chunks.push(Buffer.from(c))
      expect(Buffer.concat(chunks).toString()).toBe('abcd')
      expect(st).toMatchObject({ contentType: 'application/gzip', length: 4 })
      expect(await s.getStream('designs/nope')).toBeNull()
    })
  }

  it('local store refuses keys that escape its folder', async () => {
    const s = localStudioStore(mkdtempSync(join(tmpdir(), 'studio-store-')))
    await expect(s.put('../x', Buffer.from('x'), 'text/plain')).rejects.toThrow()
    await expect(s.get('../../etc/passwd')).rejects.toThrow()
  })
})
