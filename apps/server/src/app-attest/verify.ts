import { createHash, randomBytes, timingSafeEqual, verify as verifySignature, X509Certificate } from 'node:crypto'
import { and, eq, lt } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { appAttestChallenges, appAttestKeys, arDevices } from '../db/schema.js'
import { BeatError } from '../beats/errors.js'
import { isUuid } from '../auth/scene-from.js'

/**
 * Apple App Attest for the Virvi app (the BEATs plan, anti-farming): an install registers a Secure Enclave key once,
 * with an attestation Apple signed, and every BEAT write after that carries an assertion by that key over the request
 * body. Only the genuine app on a real iPhone can make either, and the key's id is the install's id (one claim per
 * install per BEAT).
 *
 * The client side, which the app must match:
 * - Registering: `GET /api/app/attest/challenge` gives `challenge` (base64url text); the app calls
 *   `attestKey(keyId, clientDataHash: SHA-256(UTF-8 bytes of challenge))` and posts `{keyId, attestation, challenge}`,
 *   the attestation object in standard base64.
 * - Each write: `generateAssertion(keyId, clientDataHash: SHA-256(the exact request body bytes))` (an empty body for a
 *   DELETE), sent as `X-Virvi-Attest: <keyId>.<assertion in standard base64>`.
 */

const CHALLENGE_TTL_MS = 5 * 60_000
const NONCE_OID = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02]) // 1.2.840.113635.100.8.2
const AAGUID = {
  development: Buffer.from('appattestdevelop', 'ascii'),
  production: Buffer.concat([Buffer.from('appattest', 'ascii'), Buffer.alloc(7)]),
}

const sha256 = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest()
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b)

const badAttestation = () => new BeatError(400, 'bad_attestation', "This phone couldn't be verified. Update the Virvi app and try again.")
const badChallenge = () => new BeatError(400, 'bad_challenge', 'That verification expired. Try again.')
const attestRequired = () => new BeatError(401, 'attest_required', "This app couldn't be verified. Update the Virvi app and try again.")
const badAssertion = () => new BeatError(401, 'bad_assertion', "This app couldn't be verified. Update the Virvi app and try again.")

// ── CBOR: only what attestation objects and assertions use ──────────────────────────────────────────────────────────

/**
 * Decodes one CBOR item that is the whole of `buf`: maps (text keys), byte and text strings, arrays, and unsigned and
 * negative integers up to 2^53. Anything else (floats, tags, simple values, indefinite lengths, repeated keys,
 * trailing bytes) throws.
 */
export function decodeCbor(buf: Buffer): unknown {
  let pos = 0
  const need = (n: number) => {
    if (n < 0 || pos + n > buf.length) throw new Error('cbor: truncated')
  }
  const argument = (info: number): number => {
    if (info < 24) return info
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0
    if (!size) throw new Error('cbor: unsupported length')
    need(size)
    let n = 0
    for (let i = 0; i < size; i++) n = n * 256 + buf[pos + i]
    pos += size
    if (!Number.isSafeInteger(n)) throw new Error('cbor: integer too large')
    return n
  }
  const item = (depth: number): unknown => {
    if (depth > 16) throw new Error('cbor: too deep')
    need(1)
    const first = buf[pos++]
    const major = first >> 5
    const n = argument(first & 0x1f)
    switch (major) {
      case 0: return n
      case 1: return -1 - n
      case 2: need(n); pos += n; return Buffer.from(buf.subarray(pos - n, pos))
      case 3: need(n); pos += n; return buf.toString('utf8', pos - n, pos)
      case 4: {
        if (n > buf.length - pos) throw new Error('cbor: truncated')
        const out: unknown[] = []
        for (let i = 0; i < n; i++) out.push(item(depth + 1))
        return out
      }
      case 5: {
        if (n > buf.length - pos) throw new Error('cbor: truncated')
        const out: Record<string, unknown> = Object.create(null)
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1)
          if (typeof k !== 'string') throw new Error('cbor: map keys must be text')
          if (k in out) throw new Error('cbor: repeated key')
          out[k] = item(depth + 1)
        }
        return { ...out }
      }
      default: throw new Error('cbor: unsupported type')
    }
  }
  const v = item(0)
  if (pos !== buf.length) throw new Error('cbor: trailing bytes')
  return v
}

// ── DER: just enough to read the nonce extension of the credential certificate ─────────────────────────────────────

type Tlv = { tag: number; start: number; end: number }
function tlv(buf: Buffer, at: number): Tlv {
  if (at + 2 > buf.length) throw new Error('der: truncated')
  const tag = buf[at]
  let len = buf[at + 1]
  let start = at + 2
  if (len & 0x80) {
    const size = len & 0x7f
    if (size < 1 || size > 3 || start + size > buf.length) throw new Error('der: bad length')
    len = 0
    for (let i = 0; i < size; i++) len = len * 256 + buf[start + i]
    start += size
  }
  if (start + len > buf.length) throw new Error('der: truncated')
  return { tag, start, end: start + len }
}
function children(buf: Buffer, parent: Tlv): Tlv[] {
  const out: Tlv[] = []
  for (let at = parent.start; at < parent.end; at = out[out.length - 1].end) out.push(tlv(buf, at))
  return out
}

/** The nonce Apple put in the credential certificate: extension 1.2.840.113635.100.8.2, SEQUENCE { [1] { OCTET STRING } }. */
function certNonce(der: Buffer): Buffer {
  const certificate = tlv(der, 0)
  const tbs = children(der, certificate)[0]
  const extsWrapper = children(der, tbs).find((t) => t.tag === 0xa3)
  if (!extsWrapper) throw new Error('no extensions')
  for (const ext of children(der, children(der, extsWrapper)[0])) {
    const parts = children(der, ext)
    if (parts[0]?.tag !== 0x06 || !same(der.subarray(parts[0].start, parts[0].end), NONCE_OID)) continue
    const value = parts[parts.length - 1]
    if (value.tag !== 0x04) break
    const inner = tlv(der, value.start)
    const tagged = children(der, inner).find((t) => t.tag === 0xa1)
    if (!tagged) break
    const octets = tlv(der, tagged.start)
    if (octets.tag !== 0x04) break
    return Buffer.from(der.subarray(octets.start, octets.end))
  }
  throw new Error('no nonce extension')
}

// ── Attestation ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type AppAttestSettings = typeof config.appAttest

const isBytes = (v: unknown): v is Buffer => Buffer.isBuffer(v)
const validAt = (c: X509Certificate, now: Date) => new Date(c.validFrom) <= now && now <= new Date(c.validTo)

/** The key id's 32 bytes, when it is canonical standard base64 of 32 bytes. */
function keyIdBytes(keyId: unknown): Buffer | null {
  if (typeof keyId !== 'string' || keyId.length > 64) return null
  const b = Buffer.from(keyId, 'base64')
  return b.length === 32 && b.toString('base64') === keyId ? b : null
}

/**
 * Checks an attestation object as Apple describes (Validating Apps That Connect to Your Server): the certificate chain
 * to the root CA, the nonce, the credential key's hash as the key id, the app id's hash, a counter of 0, the
 * environment's aaguid and the credential id. Returns the credential public key (SPKI PEM). Throws on anything else.
 */
export function verifyAttestation(keyId: string, attestation: Buffer, clientDataHash: Buffer, s: AppAttestSettings, now = new Date()): string {
  const id = keyIdBytes(keyId)
  if (!id) throw new Error('bad key id')
  const obj = decodeCbor(attestation) as { fmt?: unknown; attStmt?: { x5c?: unknown }; authData?: unknown }
  if (!obj || typeof obj !== 'object' || obj.fmt !== 'apple-appattest' || !isBytes(obj.authData)) throw new Error('not an App Attest object')
  const x5c = obj.attStmt?.x5c
  if (!Array.isArray(x5c) || x5c.length !== 2 || !x5c.every(isBytes)) throw new Error('bad x5c')

  const root = new X509Certificate(s.rootCa)
  const intermediate = new X509Certificate(x5c[1])
  const cred = new X509Certificate(x5c[0])
  if (!intermediate.ca || !intermediate.checkIssued(root) || !intermediate.verify(root.publicKey)) throw new Error('intermediate not from the root')
  if (!cred.checkIssued(intermediate) || !cred.verify(intermediate.publicKey)) throw new Error('credential not from the intermediate')
  if (![root, intermediate, cred].every((c) => validAt(c, now))) throw new Error('certificate expired')

  const authData = obj.authData
  if (!same(certNonce(x5c[0]), sha256(authData, clientDataHash))) throw new Error('nonce')

  const jwk = cred.publicKey.export({ format: 'jwk' })
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new Error('not a P-256 key')
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
  if (!same(sha256(point), id)) throw new Error('key id is not the credential key')

  if (authData.length < 55) throw new Error('authData too short')
  if (!same(authData.subarray(0, 32), sha256(Buffer.from(s.appId, 'utf8')))) throw new Error('rpIdHash')
  if (authData.readUInt32BE(33) !== 0) throw new Error('counter')
  const aaguid = authData.subarray(37, 53)
  if (!same(aaguid, AAGUID[s.env]) && !(s.allowDevelopment && same(aaguid, AAGUID.development))) throw new Error('aaguid')
  const credLen = authData.readUInt16BE(53)
  if (!same(authData.subarray(55, 55 + credLen), id)) throw new Error('credential id')

  return cred.publicKey.export({ type: 'spki', format: 'pem' }).toString()
}

/** A fresh challenge for this account: 32 random bytes as base64url, for 5 minutes, single use. */
export async function issueChallenge(userId: string, now = new Date()): Promise<string> {
  await db.delete(appAttestChallenges).where(lt(appAttestChallenges.expiresAt, now))
  const challenge = randomBytes(32).toString('base64url')
  await db.insert(appAttestChallenges).values({ challenge, userId, expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS) })
  return challenge
}

/**
 * Registers an install's key: the challenge is used up first (a failed attempt burns it too), then the attestation is
 * checked and the key stored with counter 0, linked to the account.
 */
export async function registerKey(userId: string, body: { keyId?: unknown; attestation?: unknown; challenge?: unknown }, now = new Date()): Promise<{ keyId: string }> {
  const { keyId, attestation, challenge } = body
  if (typeof challenge !== 'string' || challenge.length > 100) throw badChallenge()
  const [ch] = await db.delete(appAttestChallenges).where(eq(appAttestChallenges.challenge, challenge)).returning()
  if (!ch || ch.userId !== userId || ch.expiresAt < now) throw badChallenge()
  if (typeof keyId !== 'string' || typeof attestation !== 'string' || attestation.length > 64 * 1024) throw badAttestation()
  let publicKey: string
  try {
    publicKey = verifyAttestation(keyId, Buffer.from(attestation, 'base64'), sha256(Buffer.from(challenge, 'utf8')), config.appAttest, now)
  } catch {
    throw badAttestation()
  }
  // A key is attested once: an id already stored can't be registered again
  const [row] = await db.insert(appAttestKeys).values({ keyId, publicKey, counter: 0, userId }).onConflictDoNothing().returning({ keyId: appAttestKeys.keyId })
  if (!row) throw badAttestation()
  return { keyId }
}

// ── Assertions ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Checks `X-Virvi-Attest: <keyId>.<assertion>` over the raw body: the stored key's signature over
 * SHA-256(authenticatorData ‖ SHA-256(body)), the app id's hash, and a counter above the stored one, which it then
 * stores with one conditional UPDATE (a replay, or two requests racing with one counter, gets 401). Returns the key id.
 */
async function appAttestInstall(request: FastifyRequest, header: string, body: string | Buffer | undefined): Promise<string> {
  const dot = header.indexOf('.')
  const keyId = header.slice(0, dot)
  if (dot < 1 || !keyIdBytes(keyId)) throw badAssertion()
  const [key] = await db.select().from(appAttestKeys).where(eq(appAttestKeys.keyId, keyId))
  if (!key) throw badAssertion()
  let counter: number
  try {
    const a = decodeCbor(Buffer.from(header.slice(dot + 1), 'base64')) as { signature?: unknown; authenticatorData?: unknown }
    if (!a || !isBytes(a.signature) || !isBytes(a.authenticatorData) || a.authenticatorData.length < 37) throw new Error('shape')
    const authData = a.authenticatorData
    if (!same(authData.subarray(0, 32), sha256(Buffer.from(config.appAttest.appId, 'utf8')))) throw new Error('rpIdHash')
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '', 'utf8')
    const nonce = sha256(authData, sha256(raw))
    if (!verifySignature('sha256', nonce, { key: key.publicKey, dsaEncoding: 'der' }, a.signature)) throw new Error('signature')
    counter = authData.readUInt32BE(33)
  } catch {
    throw badAssertion()
  }
  const moved = await db.update(appAttestKeys).set({ counter, userId: request.user.id })
    .where(and(eq(appAttestKeys.keyId, keyId), lt(appAttestKeys.counter, counter))).returning({ keyId: appAttestKeys.keyId })
  if (!moved.length) throw badAssertion()
  return keyId
}

/** One way an install proves itself on a write: the header it reads and its check, which returns the install's key. */
interface InstallProof {
  header: string
  verify(request: FastifyRequest, value: string, body: string | Buffer | undefined): Promise<string>
}
const PROOFS: InstallProof[] = [{ header: 'x-virvi-attest', verify: appAttestInstall }]

/**
 * A signed-in Quest has no App Attest, so it is its own install: `X-Virvi-Device: <deviceId>` names the visitor pairing
 * it signed in with. The header is a client-supplied string and proves nothing alone; it counts only when the id is an
 * `ar_devices` row that is a visitor pairing, was approved by this very session's account (`user_id`), and was claimed
 * (a spent code: `revoked` with no `code_hash`, as `claimVisitorPairing` leaves it). A made-up id, another account's
 * device, a builder headset or an unclaimed pairing is refused like a missing proof, so ids can't be invented for keys.
 * Returns `quest:<deviceId>`.
 */
async function questInstall(request: FastifyRequest, deviceId: string): Promise<string> {
  if (!isUuid(deviceId)) throw attestRequired()
  const [row] = await db.select({ purpose: arDevices.purpose, userId: arDevices.userId, status: arDevices.status, codeHash: arDevices.codeHash })
    .from(arDevices).where(eq(arDevices.id, deviceId))
  if (!row || row.purpose !== 'visitor' || row.status !== 'revoked' || row.codeHash !== null || !row.userId || row.userId !== request.user.id) throw attestRequired()
  return `quest:${deviceId}`
}

/**
 * The install a write comes from, proved by the first proof whose header the request carries: an App Attest
 * assertion over `body` (the raw request body; undefined for none), or with no such header a signed-in Quest's visitor
 * device (`questInstall`). Throws 401 `attest_required` with neither, 401 `bad_assertion` when the proof fails.
 */
export async function requireAssertion(request: FastifyRequest, body: string | Buffer | undefined): Promise<string> {
  for (const p of PROOFS) {
    const value = request.headers[p.header]
    if (typeof value === 'string' && value) return p.verify(request, value, body)
  }
  // Only with no App Attest header at all: a bad assertion never falls back to a device header
  const device = request.headers['x-virvi-device']
  if (typeof device === 'string' && device) return questInstall(request, device)
  throw attestRequired()
}

