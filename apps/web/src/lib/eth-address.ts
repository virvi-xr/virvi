// EIP-55 checksummed wallet addresses, for showing a whole address where it matters (the hand-off's account choice).
// Keccak-256 (the original padding, not NIST SHA3) on 64-bit BigInt lanes: small inputs only, display use only.
// BigInt(...) calls, not literals: the web build targets below ES2020.

const MASK = (BigInt(1) << BigInt(64)) - BigInt(1)
const ROUND_CONSTANTS = [
  BigInt('0x0000000000000001'), BigInt('0x0000000000008082'), BigInt('0x800000000000808a'), BigInt('0x8000000080008000'), BigInt('0x000000000000808b'), BigInt('0x0000000080000001'),
  BigInt('0x8000000080008081'), BigInt('0x8000000000008009'), BigInt('0x000000000000008a'), BigInt('0x0000000000000088'), BigInt('0x0000000080008009'), BigInt('0x000000008000000a'),
  BigInt('0x000000008000808b'), BigInt('0x800000000000008b'), BigInt('0x8000000000008089'), BigInt('0x8000000000008003'), BigInt('0x8000000000008002'), BigInt('0x8000000000000080'),
  BigInt('0x000000000000800a'), BigInt('0x800000008000000a'), BigInt('0x8000000080008081'), BigInt('0x8000000000008080'), BigInt('0x0000000080000001'), BigInt('0x8000000080008008'),
]
// Rotation offsets r[x][y], lane index x + 5y
const ROTATIONS = [
  [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
]

const rotl = (v: bigint, n: number) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK)

function keccakF(s: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20])
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1)
      for (let y = 0; y < 5; y++) s[x + 5 * y] ^= d
    }
    const b = new Array<bigint>(25)
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROTATIONS[x][y])
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
      s[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & MASK & b[((x + 2) % 5) + 5 * y])
    }
    s[0] ^= ROUND_CONSTANTS[round]
  }
}

/** Keccak-256 of a UTF-8 string, as 64 lowercase hex characters. */
export function keccak256Hex(input: string): string {
  const rate = 136
  const bytes = new TextEncoder().encode(input)
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate)
  padded.set(bytes)
  padded[bytes.length] ^= 0x01
  padded[padded.length - 1] ^= 0x80
  const s = new Array<bigint>(25).fill(BigInt(0))
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = BigInt(0)
      for (let k = 7; k >= 0; k--) lane = (lane << BigInt(8)) | BigInt(padded[off + i * 8 + k])
      s[i] ^= lane
    }
    keccakF(s)
  }
  let hex = ''
  for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) hex += Number((s[i] >> BigInt(8 * k)) & BigInt('0xff')).toString(16).padStart(2, '0')
  return hex
}

/** The EIP-55 checksummed form of a 20-byte hex address, or null if it isn't one. */
export function checksumAddress(address: string): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null
  const lower = address.slice(2).toLowerCase()
  const hash = keccak256Hex(lower)
  let out = '0x'
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i]
  return out
}
