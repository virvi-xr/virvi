import { describe, it, expect } from 'vitest'
import {
  afterDisconnect, canDisconnectScene, connectedSceneFromError, disconnectedNotice, disconnectFromCardPrompt, disconnectFromWizardPrompt, DISCONNECT_ACTION, worldInUseView,
} from './world-disconnect'
import { wizardErrorMessage } from './wizard/run'

const apiError = (status: number, body: Record<string, unknown>) =>
  Object.assign(new Error(String(body.error ?? `API error ${status}`)), { status, body })

const mine = { sceneId: 's-old', name: 'Old cafe', canDisconnect: true as const, destinationId: 'd-old' }
const viewable = { sceneId: 's-their', name: 'Their cafe', canDisconnect: false as const }
const hidden = { name: null, canDisconnect: false as const }

describe('worldInUseView', () => {
  it('nothing to say for a World no scene uses, or the one this run is making', () => {
    expect(worldInUseView('cafe.dcl.eth', null)).toBeNull()
    expect(worldInUseView('cafe.dcl.eth', undefined)).toBeNull()
    expect(worldInUseView('cafe.dcl.eth', mine, 's-old')).toBeNull()
  })

  it('offers the disconnect for a scene the caller has full access to, with a link to it', () => {
    const v = worldInUseView('cafe.dcl.eth', mine)
    expect(v).toEqual({
      kind: 'disconnect',
      text: 'cafe.dcl.eth is connected to your scene “Old cafe”.',
      action: DISCONNECT_ACTION,
      confirm: disconnectFromWizardPrompt('cafe.dcl.eth', 'Old cafe'),
      destinationId: 'd-old',
      sceneHref: '/scenes?id=s-old',
      sceneName: 'Old cafe',
    })
    expect(DISCONNECT_ACTION).toBe('Disconnect it and use this World')
  })

  it('names a scene the caller can only view, and says who can disconnect it', () => {
    const v = worldInUseView('cafe.dcl.eth', viewable)
    expect(v?.kind).toBe('blocked')
    expect(v?.text).toContain('“Their cafe”')
    expect(v?.text).toMatch(/owner/)
    expect(v).not.toHaveProperty('destinationId')
  })

  it("never names a scene the caller can't see", () => {
    const v = worldInUseView('cafe.dcl.eth', hidden)
    expect(v).toEqual({
      kind: 'blocked',
      text: "cafe.dcl.eth is connected to a scene in another Virvi account. That scene's owner needs to disconnect it before you can use this World.",
    })
  })
})

describe('connectedSceneFromError', () => {
  it('reads the 409 world_in_use body, and nothing else', () => {
    expect(connectedSceneFromError(apiError(409, { error: 'world_in_use', sceneId: 's-old', connectedScene: mine }))).toEqual(mine)
    expect(connectedSceneFromError(apiError(409, { error: 'world_in_use', sceneId: 's-old' }))).toEqual(hidden)
    expect(connectedSceneFromError(apiError(409, { error: 'deploy_in_progress' }))).toBeNull()
    expect(connectedSceneFromError(new Error('boom'))).toBeNull()
    expect(connectedSceneFromError(null)).toBeNull()
  })
})

describe('disconnect copy', () => {
  it('a disconnect refused for lack of access says so plainly', () => {
    expect(wizardErrorMessage(apiError(403, { error: 'forbidden' }))).toBe('You need full access to this scene to do that. Ask its owner.')
  })

  it("the wizard's confirm says what stays live and what changes for the other scene", () => {
    const p = disconnectFromWizardPrompt('cafe.dcl.eth', 'Old cafe')
    expect(p).toContain('What’s live in cafe.dcl.eth stays there until this new scene deploys over it')
    expect(p).toContain('“Old cafe” keeps its models and deploy history')
    expect(p).toMatch(/stops deploying “Old cafe” to cafe\.dcl\.eth/)
  })

  it("the deploy page's confirm explains the World, redeploys and the permission", () => {
    const plain = disconnectFromCardPrompt('cafe.dcl.eth', null)
    expect(plain).toContain('cafe.dcl.eth keeps showing this scene until something else is deployed there')
    expect(plain).toContain('Virvi stops redeploying to it')
    expect(plain).not.toMatch(/permission/)
    const granted = disconnectFromCardPrompt('cafe.dcl.eth', 'Switch to signing each deploy')
    expect(granted).toMatch(/Virvi keeps its permission to deploy to cafe\.dcl\.eth until you remove it/)
    expect(granted).toContain('use “Switch to signing each deploy” first')
    expect(granted).toContain('Creator Hub')
    // After a partial grant the card's button reads differently, and the copy names it as it reads
    expect(disconnectFromCardPrompt('cafe.dcl.eth', "Remove Virvi's permission")).toContain("use “Remove Virvi's permission” first")
  })

  it('the Deploy page offers the disconnect to owners and co-hosts only', () => {
    expect([undefined, null, 'owner', 'cohost', 'editor', 'viewer'].map(canDisconnectScene)).toEqual([true, true, true, true, false, false])
  })

  it("after the wizard's disconnect: the run carries on, unless an unagreed scene turned up in the World", () => {
    expect(afterDisconnect(false, { hasScene: false })).toBe('run')
    expect(afterDisconnect(true, { hasScene: true })).toBe('run')
    expect(afterDisconnect(false, { hasScene: true })).toBe('confirm_replace')
  })

  it("after disconnecting: the server's permission sentence when there is one", () => {
    expect(disconnectedNotice({ world: 'cafe.dcl.eth', grantKept: false })).toBe('cafe.dcl.eth is disconnected from this scene.')
    expect(disconnectedNotice({ world: 'cafe.dcl.eth', grantKept: true, message: 'Virvi can still deploy.' }))
      .toBe('cafe.dcl.eth is disconnected from this scene. Virvi can still deploy.')
  })
})
