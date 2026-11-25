import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'

/**
 * Synthetic Apple App Attest objects for tests: a test CA (root and intermediate, P-256) standing in for Apple's, a
 * device key whose credential certificate carries the nonce, and assertions over a request body. Built with a minimal
 * DER and CBOR encoder, so the tests need no extra dependency.
 */

const sha256 = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest()

// ── DER ──────────────────────────────────────────────────────────────────────
const derLen = (n: number) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]))
const tlv = (tag: number, ...parts: Buffer[]) => {
  const c = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), derLen(c.length), c])
}
const seq = (...p: Buffer[]) => tlv(0x30, ...p)
const set = (...p: Buffer[]) => tlv(0x31, ...p)
const ctx = (n: number, ...p: Buffer[]) => tlv(0xa0 + n, ...p)
const int = (n: number) => tlv(0x02, Buffer.from([n]))
const octet = (b: Buffer) => tlv(0x04, b)
const bits = (b: Buffer) => tlv(0x03, Buffer.from([0]), b)
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'))
const bool = () => tlv(0x01, Buffer.from([0xff]))
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number)
  const out = [40 * a + b]
  for (const n of rest) {
    const digits = [n & 0x7f]
    for (let v = n >>> 7; v > 0; v >>>= 7) digits.unshift((v & 0x7f) | 0x80)
    out.push(...digits)
  }
  return tlv(0x06, Buffer.from(out))
}
const utc = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'))
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'))
const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), utf8(cn))))
export const NONCE_OID = '1.2.840.113635.100.8.2'

let serial = 1
function cert(o: { subject: string; issuer: string; publicKey: KeyObject; signKey: KeyObject; ca?: boolean; extensions?: Buffer[]; notBefore?: Date; notAfter?: Date }): Buffer {
  const exts = [...(o.ca ? [seq(oid('2.5.29.19'), bool(), octet(seq(bool())))] : []), ...(o.extensions ?? [])]
  const tbs = seq(
    ctx(0, int(2)), int(serial++ % 120 + 1), ECDSA_SHA256, name(o.issuer),
    seq(utc(o.notBefore ?? new Date(Date.now() - 86_400_000)), utc(o.notAfter ?? new Date(Date.now() + 86_400_000))),
    name(o.subject), o.publicKey.export({ type: 'spki', format: 'der' }),
    ...(exts.length ? [ctx(3, seq(...exts))] : []),
  )
  return seq(tbs, ECDSA_SHA256, bits(sign('sha256', tbs, { key: o.signKey, dsaEncoding: 'der' })))
}
const pem = (der: Buffer) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`

// ── CBOR (the subset attestation objects use) ───────────────────────────────
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n])
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n])
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff])
  const b = Buffer.alloc(5)
  b[0] = (major << 5) | 26
  b.writeUInt32BE(n, 1)
  return b
}
export function cbor(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v])
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v, 'utf8')])
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)])
  const entries = Object.entries(v as Record<string, unknown>)
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])])
}

// ── Test CA, device keys, attestations and assertions ───────────────────────
export interface TestCa { rootPem: string; intermediateDer: Buffer; intermediateKey: KeyObject }

export function makeTestCa(): TestCa {
  const root = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const inter = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const rootDer = cert({ subject: 'Test App Attestation Root CA', issuer: 'Test App Attestation Root CA', publicKey: root.publicKey, signKey: root.privateKey, ca: true })
  const intermediateDer = cert({ subject: 'Test App Attestation CA 1', issuer: 'Test App Attestation Root CA', publicKey: inter.publicKey, signKey: root.privateKey, ca: true })
  return { rootPem: pem(rootDer), intermediateDer, intermediateKey: inter.privateKey }
}

export const AAGUID = {
  development: Buffer.from('appattestdevelop', 'ascii'),
  production: Buffer.concat([Buffer.from('appattest', 'ascii'), Buffer.alloc(7)]),
}

export interface TestDevice {
  keyId: string
  publicKey: KeyObject
  privateKey: KeyObject
  /** The next assertion counter (assert() uses it, then adds one). */
  counter: number
  /** The X-Virvi-Attest header value for this body (signed for `appId`, the device's own unless given). */
  assert(body: string, counter?: number, appId?: string): string
}

export function makeDevice(appId: string): TestDevice {
  const k = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = k.publicKey.export({ format: 'jwk' })
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])
  const keyId = sha256(point).toString('base64')
  const device: TestDevice = {
    keyId,
    publicKey: k.publicKey,
    privateKey: k.privateKey,
    counter: 1,
    assert(body: string, counter?: number, forApp = appId) {
      const n = counter ?? device.counter++
      const counterBytes = Buffer.alloc(4)
      counterBytes.writeUInt32BE(n)
      const authenticatorData = Buffer.concat([sha256(Buffer.from(forApp)), Buffer.from([0x40]), counterBytes])
      const nonce = sha256(authenticatorData, sha256(Buffer.from(body, 'utf8')))
      const signature = sign('sha256', nonce, { key: k.privateKey, dsaEncoding: 'der' })
      return `${keyId}.${cbor({ signature, authenticatorData }).toString('base64')}`
    },
  }
  return device
}

/**
 * An attestation object for the device's key and this challenge, as DCAppAttestService makes it: the credential
 * certificate (issued by the test intermediate) carries nonce = SHA-256(authData ‖ SHA-256(challenge)).
 */
export function makeAttestation(ca: TestCa, device: TestDevice, challenge: string, o: { appId: string; aaguid?: Buffer; nonce?: Buffer; rpId?: string; counter?: number; fmt?: string }): string {
  const keyIdBytes = Buffer.from(device.keyId, 'base64')
  const counter = Buffer.alloc(4)
  counter.writeUInt32BE(o.counter ?? 0)
  const credLen = Buffer.alloc(2)
  credLen.writeUInt16BE(keyIdBytes.length)
  const authData = Buffer.concat([sha256(Buffer.from(o.rpId ?? o.appId)), Buffer.from([0x41]), counter, o.aaguid ?? AAGUID.production, credLen, keyIdBytes])
  const nonce = o.nonce ?? sha256(authData, sha256(Buffer.from(challenge, 'utf8')))
  const credDer = cert({
    subject: device.keyId, issuer: 'Test App Attestation CA 1', publicKey: device.publicKey, signKey: ca.intermediateKey,
    extensions: [seq(oid(NONCE_OID), octet(seq(ctx(1, octet(nonce)))))],
  })
  return cbor({ fmt: o.fmt ?? 'apple-appattest', attStmt: { x5c: [credDer, ca.intermediateDer], receipt: Buffer.from('receipt') }, authData }).toString('base64')
}
