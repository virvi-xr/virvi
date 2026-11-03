import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { verifyDclSceneRequest, verifyDclSignedFetch } from '../src/middleware/dcl-auth.js'
import { signedSceneHeaders, SCENE_META } from './helpers/dcl-sign.js'

const PATH = '/api/auth/platform'
const BODY = JSON.stringify({ user: { displayName: 'A' } })
const bodyHash = createHash('sha256').update(BODY, 'utf8').digest('hex')

describe('verifyDclSceneRequest', () => {
  it('accepts a correct scene request and returns wallet + context', async () => {
    const { headers, wallet } = await signedSceneHeaders({ method: 'POST', path: PATH, body: BODY })
    const r = await verifyDclSceneRequest('POST', PATH, headers, BODY)
    expect(r.wallet).toBe(wallet)
    expect(r.scene).toEqual({ sceneId: SCENE_META.sceneId, parcel: '10,20', realm: { hostname: 'peer.decentraland.org', serverName: 'main' }, isGuest: false })
  })

  it('accepts a bodiless (GET) scene request', async () => {
    const { headers } = await signedSceneHeaders({ method: 'GET', path: PATH })
    await expect(verifyDclSceneRequest('GET', PATH, headers, null)).resolves.toMatchObject({ scene: { sceneId: SCENE_META.sceneId } })
  })

  // The signature is valid (6.x signs the metadata bytes verbatim) and the signer is valid, so the
  // only thing that can refuse these is the scene-context check on the exact key spelling.
  it.each([
    ['SceneId', { sceneId: undefined, SceneId: 'bafkreiscenea' }],
    ['Parcel', { parcel: undefined, Parcel: '10,20' }],
  ])('refuses a respelled %s key', async (_k, override) => {
    const { headers } = await signedSceneHeaders({
      method: 'POST', path: PATH, body: BODY,
      metadata: { ...override, hashPayload: bodyHash },
    })
    await expect(verifyDclSceneRequest('POST', PATH, headers, BODY)).rejects.toThrow(/scene metadata incomplete/)
  })

  it('refuses a respelled Signer key (read as absent by naive consumers)', async () => {
    const { headers } = await signedSceneHeaders({
      method: 'POST', path: PATH, body: BODY,
      metadata: { signer: undefined, Signer: 'decentraland-kernel-scene', hashPayload: bodyHash },
    })
    await expect(verifyDclSceneRequest('POST', PATH, headers, BODY)).rejects.toThrow(/Invalid metadata content/)
  })

  it('refuses a request with no signer', async () => {
    const { headers } = await signedSceneHeaders({ method: 'POST', path: PATH, body: BODY, metadata: { signer: undefined } })
    await expect(verifyDclSceneRequest('POST', PATH, headers, BODY)).rejects.toThrow(/Invalid metadata content/)
  })

  it('refuses a non-canonical signer value', async () => {
    const { headers } = await signedSceneHeaders({ method: 'POST', path: PATH, body: BODY, metadata: { signer: 'Decentraland-Kernel-Scene' } })
    await expect(verifyDclSceneRequest('POST', PATH, headers, BODY)).rejects.toThrow(/Invalid metadata content/)
  })

  it('refuses a missing parcel', async () => {
    const { headers } = await signedSceneHeaders({ method: 'POST', path: PATH, body: BODY, metadata: { parcel: undefined } })
    await expect(verifyDclSceneRequest('POST', PATH, headers, BODY)).rejects.toThrow(/scene metadata incomplete/)
  })

  it('refuses a body that does not match hashPayload', async () => {
    const { headers } = await signedSceneHeaders({ method: 'POST', path: PATH, body: BODY })
    await expect(verifyDclSceneRequest('POST', PATH, headers, JSON.stringify({ user: { displayName: 'Evil' } }))).rejects.toThrow(/body does not match signed hash/)
  })

  it('reports a body covered by hashPayload as signed', async () => {
    const { headers } = await signedSceneHeaders({ method: 'POST', path: PATH, body: BODY })
    await expect(verifyDclSceneRequest('POST', PATH, headers, BODY)).resolves.toMatchObject({ bodySigned: true })
  })

  it('refuses a body signed without hashPayload unless the caller allows it', async () => {
    const { headers } = await signedSceneHeaders({ method: 'POST', path: PATH, body: BODY, metadata: { hashPayload: undefined } })
    await expect(verifyDclSceneRequest('POST', PATH, headers, BODY)).rejects.toThrow(/body does not match signed hash/)
  })

  it('with allowUnsignedBody, accepts a body signed without hashPayload (web explorer) and reports it unsigned', async () => {
    const { headers, wallet } = await signedSceneHeaders({ method: 'POST', path: PATH, body: BODY, metadata: { hashPayload: undefined } })
    const r = await verifyDclSceneRequest('POST', PATH, headers, BODY, { allowUnsignedBody: true })
    expect(r.wallet).toBe(wallet)
    expect(r.bodySigned).toBe(false)
    expect(r.scene.sceneId).toBe(SCENE_META.sceneId)
  })

  it('with allowUnsignedBody, still refuses a body that does not match a hashPayload that is present', async () => {
    const { headers } = await signedSceneHeaders({ method: 'POST', path: PATH, body: BODY })
    await expect(
      verifyDclSceneRequest('POST', PATH, headers, JSON.stringify({ user: { displayName: 'Evil' } }), { allowUnsignedBody: true }),
    ).rejects.toThrow(/body does not match signed hash/)
  })

  it('refuses a wallet-signed (non-scene) request', async () => {
    const { headers } = await signedSceneHeaders({ method: 'POST', path: PATH, body: BODY, metadata: { signer: 'dcl:explorer' } })
    await expect(verifyDclSceneRequest('POST', PATH, headers, BODY)).rejects.toThrow(/Invalid metadata content/)
  })

  it('refuses a signature made for another path', async () => {
    const { headers } = await signedSceneHeaders({ method: 'POST', path: '/elsewhere', body: BODY })
    await expect(verifyDclSceneRequest('POST', PATH, headers, BODY)).rejects.toThrow(/Invalid signature/)
  })

  it('refuses metadata edited after signing (casing is bound by the 6.x signature)', async () => {
    const { headers } = await signedSceneHeaders({ method: 'POST', path: PATH, body: BODY })
    const tampered = { ...headers, 'x-identity-metadata': headers['x-identity-metadata'].replace('"sceneId"', '"SceneId"') }
    await expect(verifyDclSceneRequest('POST', PATH, tampered, BODY)).rejects.toThrow(/expected "sceneId", got "SceneId"/)
  })
})

describe('verifyDclSignedFetch (setup, ingest, claims)', () => {
  it('accepts a 6.x-signed request from a non-scene signer', async () => {
    const { headers, wallet } = await signedSceneHeaders({ method: 'GET', path: '/api/setup', metadata: { signer: 'dcl:explorer' } })
    const r = await verifyDclSignedFetch('GET', '/api/setup', headers)
    expect(r.walletAddress).toBe(wallet)
  })

  it('accepts a legacy-signed request with canonical keys and empty metadata (older explorers)', async () => {
    const a = await signedSceneHeaders({ method: 'GET', path: '/api/setup', legacy: true })
    await expect(verifyDclSignedFetch('GET', '/api/setup', a.headers)).resolves.toMatchObject({ walletAddress: a.wallet })
    const b = await signedSceneHeaders({ method: 'GET', path: '/api/setup', legacy: true, rawMetadata: '{}' })
    await expect(verifyDclSignedFetch('GET', '/api/setup', b.headers)).resolves.toMatchObject({ walletAddress: b.wallet })
  })

  it('accepts a legacy-signed request whose metadata carries unrelated keys in any case', async () => {
    const { headers, wallet } = await signedSceneHeaders({ method: 'GET', path: '/api/setup', legacy: true, rawMetadata: JSON.stringify({ Intent: 'x', Origin: 'y' }) })
    await expect(verifyDclSignedFetch('GET', '/api/setup', headers)).resolves.toMatchObject({ walletAddress: wallet })
  })

  it('refuses a legacy-signed request that respells a declared key', async () => {
    const { headers } = await signedSceneHeaders({ method: 'GET', path: '/api/setup', legacy: true, rawMetadata: JSON.stringify({ Signer: 'decentraland-kernel-scene' }) })
    await expect(verifyDclSignedFetch('GET', '/api/setup', headers)).rejects.toThrow(/expected "signer", got "Signer"/)
  })
})
