/**
 * A minimal ZIP writer that stores files without compressing them (method 0). Studio packages are already zipped, so
 * "Download all" bundles them as they are. Names are UTF-8. Archives stay under 4 GB (no ZIP64): callers cap the total.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** DOS time and date fields for a ZIP entry. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear())
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  }
}

export const ZIP_MAX_BYTES = 0xfffffffe

/** One archive holding these files, stored. Throws when it would need ZIP64 (over 4 GB or 65,535 entries). */
export function storedZip(files: { name: string; data: Buffer }[], now = new Date()): Buffer {
  if (files.length > 0xffff) throw new Error('too many files for a zip')
  const { time, date } = dosDateTime(now)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const crc = crc32(f.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(f.data.length, 18)
    local.writeUInt32LE(f.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(f.data.length, 20)
    central.writeUInt32LE(f.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    // extra, comment, disk, internal attributes: 0
    central.writeUInt32LE(0, 38) // external attributes
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, f.data)
    centrals.push(central, name)
    offset += local.length + name.length + f.data.length
    if (offset > ZIP_MAX_BYTES) throw new Error('zip would be over 4 GB')
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}
