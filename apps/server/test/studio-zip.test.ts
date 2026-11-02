import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, storedZip } from '../src/studio/zip.js'

describe('studio stored zip', () => {
  it('crc32 matches the standard check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })

  it('writes a zip with one stored entry per file, in order', () => {
    const zip = storedZip([{ name: 'a.zip', data: Buffer.from('first') }, { name: 'büro/b.zip', data: Buffer.from('second') }])
    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
    const end = zip.length - 22
    expect(zip.readUInt32LE(end)).toBe(0x06054b50)
    expect(zip.readUInt16LE(end + 10)).toBe(2)
    expect(zip.includes(Buffer.from('büro/b.zip', 'utf8'))).toBe(true)
  })

  // Where the system unzip exists (macOS, most Linux), it must accept the archive and read back the same bytes
  it.skipIf(!existsSync('/usr/bin/unzip'))('the system unzip tests it clean and extracts the same bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-zip-'))
    const path = join(dir, 'all.zip')
    const big = Buffer.alloc(200_000, 7)
    writeFileSync(path, storedZip([{ name: 'one.zip', data: Buffer.from('PK-one') }, { name: 'two.bin', data: big }]))
    expect(execFileSync('/usr/bin/unzip', ['-t', path]).toString()).toMatch(/No errors detected/)
    expect(execFileSync('/usr/bin/unzip', ['-p', path, 'one.zip']).toString()).toBe('PK-one')
    expect(execFileSync('/usr/bin/unzip', ['-p', path, 'two.bin'], { maxBuffer: 1 << 20 }).equals(big)).toBe(true)
  })
})
