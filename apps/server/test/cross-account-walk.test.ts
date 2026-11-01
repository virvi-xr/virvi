import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { ringCodeOf } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import {
  users, scenes, scenePresets, sceneElements, sceneElementInstances, sceneCollaborators, sceneRoles, sceneLibrary,
  sceneDeployments, streamingServers, events, eventSceneLinks, eventGiveawayLinks, giveaways,
  giveawayItems, assetLibraryItems, mediaAssets, organizations, orgMembers, orgInvites, venues, bookings, accessGrants,
  uploadTokens, platformCallbacks, analyticsScenes, locationSetups, apiKeys, hyperfyWorlds, hyperfyPairings, arSpaces, arFloors, arMarkers, arAdjustments, roomScans, roomSets, arDevices,
  dclWorldDestinations, adSpaceSettings, adSpaceApprovals,
  studioDesigns, studioPieces, studioRevisions, studioJobs, studioMessages, studioRenders, studioUsageDays,
  studioPayments, studioEntitlements, studioMistakeReports, studioPromptCredits, studioUploads, studioScopeEvents, studioFlags, studioPauses,
} from '../src/db/schema.js'
import { config } from '../src/config.js'
import { memoryStudioStore, setStudioStore, uploadKey } from '../src/studio/store.js'
import { createVenue, createBooking, addGrant } from '../src/venues/service.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor, randomWallet, type TestUser } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'
import { Wallet } from 'ethers'
import { setWorldsClient } from '../src/services/dcl/worlds-client.js'
import { FakeWorldsClient } from './helpers/fake-worlds.js'

const H = 3600_000
const AD_ID = '00000000-0000-4000-8000-000000000001'
const PUBLIC_TARGET = { parcels: ['0,0'], contentServer: 'https://1.1.1.1' }

/** Everything below is B's, except `aScene`/`aEvent`, which A owns and uses to reach for B's ids in a body. */
async function fixtures() {
  const a = await createUser({ wallet: randomWallet() })
  const b = await createUser({ wallet: randomWallet() })
  const collaborator = await createUser()
  const { scene, preset } = await createScene(b, 'B scene')
  const element = await createElement(preset.id)
  const instance = await createInstance(element.id)
  const adSpace = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1', formats: 'both' } })
  await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: collaborator.id, role: 'editor' })
  const roleWallet = randomWallet()
  await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: roleWallet, role: 'editor', grantedByUserId: b.id })
  const [dcl] = await db.insert(sceneDeployments).values({ sceneId: scene.id, platform: 'decentraland', deploymentType: 'parcel', target: PUBLIC_TARGET, deployedBy: b.id }).returning()
  const [hyperfy] = await db.insert(sceneDeployments).values({
    sceneId: scene.id, platform: 'hyperfy', deploymentType: 'instance', status: 'deployed',
    target: { instanceUrl: 'https://h.example', adminCode: 'sekret' }, deployedBy: b.id,
  }).returning()
  const [stream] = await db.insert(streamingServers).values({
    ownerId: b.id, name: 'B stream', status: 'ready', streamKey: 'b-key', playbackId: 'b-pb', sceneId: scene.id,
    rtmpUrl: 'rtmp://ingest.virvi.io/live/b-key', hlsPlaylistUrl: 'https://live.virvi.io/streams/b-pb/playlist.m3u8',
  }).returning()
  const [event] = await db.insert(events).values({ ownerId: b.id, name: 'B event' }).returning()
  const [giveaway] = await db.insert(giveaways).values({ ownerId: b.id, name: 'B giveaway' }).returning()
  const [item] = await db.insert(giveawayItems).values({ giveawayId: giveaway.id, name: 'B item' }).returning()
  await db.insert(eventSceneLinks).values({ eventId: event.id, sceneId: scene.id })
  await db.insert(eventGiveawayLinks).values({ eventId: event.id, giveawayId: giveaway.id })
  const [asset] = await db.insert(assetLibraryItems).values({ name: 'B private', storageKey: 'assets/b/x.glb', isPublic: false, uploadedBy: b.id }).returning()
  const [media] = await db.insert(mediaAssets).values({ ownerId: b.id, filename: 'b.png', contentType: 'image/png', sizeBytes: 1, storageKey: 'media/b/b.png', publicUrl: 'https://cdn.example/b.png' }).returning()
  const [libraryItem] = await db.insert(sceneLibrary).values({ sceneId: scene.id, mediaAssetId: media.id, addedBy: b.id }).returning()
  const [org] = await db.insert(organizations).values({ name: 'B org', slug: `b-org-${b.id.slice(0, 8)}`, billingOwnerId: b.id }).returning()
  await db.insert(orgMembers).values({ orgId: org.id, userId: b.id, role: 'owner' })
  const venue = await createVenue({ sceneId: scene.id, name: 'B venue', slug: `b-venue-${b.id.slice(0, 8)}` })
  const startsAt = new Date(Date.now() + 24 * H)
  const { booking } = await createBooking({
    venueId: venue.id, renterWallet: randomWallet(), title: 'B night',
    startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 2 * H).toISOString(), createdByUserId: b.id,
  })
  const grant = await addGrant({ bookingId: booking.id, walletAddress: randomWallet(), role: 'vj', grantedByUserId: b.id })
  await db.insert(uploadTokens).values({ code: 'bcode1', userId: b.id, sceneId: scene.id, expiresAt: new Date(Date.now() + H) })
  const [hook] = await db.insert(platformCallbacks).values({ sceneId: scene.id, platform: 'secondlife', callbackUrl: 'https://1.1.1.1/cb' }).returning()
  const location = await createAnalyticsScene({ claimedByUserId: b.id, claimStatus: 'active' })
  await createSetup(location.id, scene.id)
  const [world] = await db.insert(hyperfyWorlds).values({ sceneId: scene.id, ownerId: b.id, name: 'B world', keyHash: 'b-world-hash', keyPrefix: 'virviw_b' }).returning()
  const [pairing] = await db.insert(hyperfyPairings).values({
    worldId: world.id, userId: b.id, secretHash: 'b-secret-hash', status: 'claimed', codeExpiresAt: new Date(Date.now() + H), expiresAt: new Date(Date.now() + H),
  }).returning()
  const [arSpace] = await db.insert(arSpaces).values({ sceneId: scene.id, name: 'B space' }).returning()
  const [arFloor] = await db.insert(arFloors).values({ spaceId: arSpace.id, name: 'Ground floor' }).returning()
  const [arMarker] = await db.insert(arMarkers).values({ floorId: arFloor.id, ringId: 123456, code: '0000000' }).returning()
  await db.insert(arAdjustments).values({ spaceId: arSpace.id, instanceId: instance.id, dPosition: { x: 0, y: 1, z: 0 }, dRotation: { x: 0, y: 0, z: 0 }, scaleFactor: { x: 1, y: 1, z: 1 } })
  const [arDevice] = await db.insert(arDevices).values({
    userId: b.id, secretHash: 'b-device-secret-hash', kind: 'shared', status: 'claimed', codeExpiresAt: new Date(Date.now() + H), expiresAt: new Date(Date.now() + H),
  }).returning()
  const [destination] = await db.insert(dclWorldDestinations).values({
    sceneId: scene.id, ownerUserId: b.id, ownerWallet: b.wallet!, worldName: 'b-world.dcl.eth', base: '0,0', parcels: ['0,0'], mode: 'sign',
  }).returning()
  const [signDeploy] = await db.insert(sceneDeployments).values({
    sceneId: scene.id, platform: 'decentraland', deploymentType: 'world', destinationId: destination.id, target: { world: 'b-world.dcl.eth' }, status: 'awaiting_signature', deployedBy: b.id,
  }).returning()
  const [bKey] = await db.insert(apiKeys).values({ userId: b.id, name: 'B key', keyHash: 'b-hash', keyPrefix: 'virvi_k1' }).returning()

  const [design] = await db.insert(studioDesigns).values({ ownerId: b.id, name: 'B cap', kind: 'wearable', agent: 'claude' }).returning()
  const [designJob] = await db.insert(studioJobs).values({ designId: design.id, type: 'prompt', status: 'done', payload: {} }).returning()
  const [designPiece] = await db.insert(studioPieces).values({ designId: design.id, category: 'hat', name: 'B cap' }).returning()
  const [designRev] = await db.insert(studioRevisions).values({ pieceId: designPiece.id, number: 1, jobId: designJob.id, changeKind: 'new', meta: {}, files: [] }).returning()
  await db.update(studioPieces).set({ latestRevisionId: designRev.id }).where(eq(studioPieces.id, designPiece.id))
  // B paid for revision 1 as a revision (so a report would refund it); its package is ready to download
  const [designPayment] = await db.insert(studioPayments).values({
    userId: b.id, designId: design.id, kind: 'finalize', status: 'paid', amountCents: 1000, paidAt: new Date(), stripePaymentIntent: 'pi_b',
  }).returning()
  await db.insert(studioEntitlements).values({
    revisionId: designRev.id, paymentId: designPayment.id, userId: b.id, designId: design.id, category: 'hat', kind: 'revision', amountCents: 1000, status: 'ready',
    packageKey: `designs/${design.id}/jobs/${designJob.id}/final/hat/package.zip`,
  }).returning()
  await db.insert(studioPromptCredits).values({ userId: b.id, balance: 3 })
  const [designUpload] = await db.insert(studioUploads).values({ designId: design.id, name: 'b-logo.png', kind: 'image', contentType: 'image/png', size: 4 }).returning()

  const roomFloor: Array<[number, number]> = [[0, 0], [4, 0], [4, 3], [0, 3]]
  const [roomScan] = await db.insert(roomScans).values({
    userId: b.id, name: 'B scan', source: 'quest-mruk',
    layout: { version: 1, rooms: [{ label: 'B room', floor: roomFloor, floorY: 0, ceilingHeight: 2.5, walls: [], objects: [], anchor: { source: 'quest-mruk', roomId: 'b', floorAnchorId: null, floorPose: { position: [0, 0, 0], yaw: 0 } } }] },
  }).returning()
  const [roomSet] = await db.insert(roomSets).values({
    scanId: roomScan.id, userId: b.id, options: { style: 'plain' }, nudges: [], storageKey: `room-sets/${b.id}/b.glb`, glbUrl: 'https://cdn.test/b.glb',
    triangles: 100, plot: { width: 1, depth: 1, base: { x: 0, y: 0 } }, offset: { x: 0.62, y: 0, z: 0.62 }, sceneElementId: element.id,
  }).returning()
  const aScene = (await createScene(a, 'A scene')).scene
  const [aEvent] = await db.insert(events).values({ ownerId: a.id, name: 'A event' }).returning()
  return {
    a, b, collaborator, scene, preset, element, adSpace, instance, roleWallet, dcl, hyperfy, stream, event, giveaway, item,
    asset, media, libraryItem, org, venue, booking, grant, hook, location, bKey, destination, signDeploy, world, pairing, arSpace, arFloor, arMarker, arDevice, roomScan, roomSet, design, designUpload, aScene, aEvent,
  }
}
type F = Awaited<ReturnType<typeof fixtures>>

type Case = { route: string; url: (f: F) => string; body?: (f: F) => Record<string, unknown> }

// One entry per collected route with a `:param` (B's id in it), plus routes that take B's id in the body.
// Some routes appear twice: once on B's resource, once on A's own resource with B's id in the body.
const CASES: Case[] = [
  // scenes
  { route: 'GET /api/scenes/:sceneId', url: (f) => `/api/scenes/${f.scene.id}` },
  { route: 'PUT /api/scenes/:sceneId', url: (f) => `/api/scenes/${f.scene.id}`, body: () => ({ name: 'pwned' }) },
  { route: 'DELETE /api/scenes/:sceneId', url: (f) => `/api/scenes/${f.scene.id}` },
  { route: 'POST /api/scenes/:sceneId/presets', url: (f) => `/api/scenes/${f.scene.id}/presets`, body: () => ({ name: 'pwned' }) },
  { route: 'POST /api/presets/:presetId/elements', url: (f) => `/api/presets/${f.preset.id}/elements`, body: () => ({ type: 'image', name: 'pwned' }) },
  { route: 'PUT /api/elements/:elementId', url: (f) => `/api/elements/${f.element.id}`, body: () => ({ name: 'pwned' }) },
  { route: 'DELETE /api/elements/:elementId', url: (f) => `/api/elements/${f.element.id}` },
  { route: 'POST /api/elements/:elementId/live', url: (f) => `/api/elements/${f.element.id}/live`, body: () => ({ enabled: true }) },
  { route: 'POST /api/elements/:elementId/instances', url: (f) => `/api/elements/${f.element.id}/instances`, body: () => ({ position: { x: 0, y: 0, z: 0 } }) },
  { route: 'PUT /api/instances/:instanceId', url: (f) => `/api/instances/${f.instance.id}`, body: () => ({ enabled: false }) },
  { route: 'DELETE /api/instances/:instanceId', url: (f) => `/api/instances/${f.instance.id}` },
  { route: 'GET /api/scenes/:sceneId/collaborators', url: (f) => `/api/scenes/${f.scene.id}/collaborators` },
  { route: 'POST /api/scenes/:sceneId/collaborators', url: (f) => `/api/scenes/${f.scene.id}/collaborators`, body: (f) => ({ email: f.a.email, role: 'editor' }) },
  { route: 'PUT /api/scenes/:sceneId/collaborators/:userId', url: (f) => `/api/scenes/${f.scene.id}/collaborators/${f.collaborator.id}`, body: () => ({ role: 'viewer' }) },
  { route: 'DELETE /api/scenes/:sceneId/collaborators/:userId', url: (f) => `/api/scenes/${f.scene.id}/collaborators/${f.collaborator.id}` },
  { route: 'GET /api/scenes/:sceneId/roles', url: (f) => `/api/scenes/${f.scene.id}/roles` },
  { route: 'POST /api/scenes/:sceneId/roles', url: (f) => `/api/scenes/${f.scene.id}/roles`, body: (f) => ({ wallet: f.a.wallet, role: 'cohost' }) },
  { route: 'DELETE /api/scenes/:sceneId/roles/:wallet', url: (f) => `/api/scenes/${f.scene.id}/roles/${f.roleWallet}` },
  { route: 'POST /api/scenes/:sceneId/transfer-host', url: (f) => `/api/scenes/${f.scene.id}/transfer-host`, body: (f) => ({ wallet: f.a.wallet }) },
  // scene library
  { route: 'GET /api/scenes/:sceneId/library', url: (f) => `/api/scenes/${f.scene.id}/library` },
  { route: 'POST /api/scenes/:sceneId/library', url: (f) => `/api/scenes/${f.scene.id}/library`, body: (f) => ({ mediaAssetId: f.media.id }) },
  { route: 'POST /api/scenes/:sceneId/library', url: (f) => `/api/scenes/${f.aScene.id}/library`, body: (f) => ({ mediaAssetId: f.media.id }) },
  { route: 'DELETE /api/scenes/:sceneId/library/:id', url: (f) => `/api/scenes/${f.scene.id}/library/${f.libraryItem.id}` },
  { route: 'PATCH /api/scenes/:sceneId/library/:id', url: (f) => `/api/scenes/${f.scene.id}/library/${f.libraryItem.id}`, body: () => ({ name: 'renamed' }) },
  { route: 'POST /api/scenes/:sceneId/library/upload', url: (f) => `/api/scenes/${f.scene.id}/library/upload`, body: () => ({ filename: 'x.png', contentType: 'image/png', data: 'iVBORw0KGgo=' }) },
  // room scans
  { route: 'GET /api/room-scans/:id', url: (f) => `/api/room-scans/${f.roomScan.id}` },
  { route: 'DELETE /api/room-scans/:id', url: (f) => `/api/room-scans/${f.roomScan.id}` },
  { route: 'GET /api/room-scans/:id/preview.glb', url: (f) => `/api/room-scans/${f.roomScan.id}/preview.glb` },
  { route: 'POST /api/room-sets/asset', url: () => '/api/room-sets/asset', body: (f) => ({ scanId: f.roomScan.id, name: 'pwned', options: {} }) },
  { route: 'GET /api/room-sets/:id', url: (f) => `/api/room-sets/${f.roomSet.id}` },
  { route: 'PUT /api/room-sets/:id', url: (f) => `/api/room-sets/${f.roomSet.id}`, body: () => ({ options: { style: 'house' } }) },
  // AR spaces
  { route: 'GET /api/scenes/:sceneId/ar/spaces', url: (f) => `/api/scenes/${f.scene.id}/ar/spaces` },
  { route: 'POST /api/scenes/:sceneId/ar/spaces', url: (f) => `/api/scenes/${f.scene.id}/ar/spaces`, body: () => ({ name: 'pwned' }) },
  { route: 'PUT /api/ar/spaces/:id', url: (f) => `/api/ar/spaces/${f.arSpace.id}`, body: () => ({ name: 'pwned' }) },
  { route: 'DELETE /api/ar/spaces/:id', url: (f) => `/api/ar/spaces/${f.arSpace.id}` },
  { route: 'POST /api/ar/spaces/:id/floors', url: (f) => `/api/ar/spaces/${f.arSpace.id}/floors`, body: () => ({ name: 'pwned', heightM: 3 }) },
  { route: 'PUT /api/ar/floors/:id', url: (f) => `/api/ar/floors/${f.arFloor.id}`, body: () => ({ name: 'pwned' }) },
  { route: 'DELETE /api/ar/floors/:id', url: (f) => `/api/ar/floors/${f.arFloor.id}` },
  { route: 'POST /api/ar/floors/:id/markers', url: (f) => `/api/ar/floors/${f.arFloor.id}/markers`, body: () => ({}) },
  { route: 'PUT /api/ar/markers/:id', url: (f) => `/api/ar/markers/${f.arMarker.id}`, body: () => ({ whereText: 'pwned' }) },
  { route: 'PUT /api/ar/markers/:id/pose', url: (f) => `/api/ar/markers/${f.arMarker.id}/pose`, body: () => ({ x: 9, y: 9, z: 9, headingDeg: 9, heightAboveFloorM: 0 }) },
  { route: 'PUT /api/ar/spaces/:id/adjustments/:instanceId', url: (f) => `/api/ar/spaces/${f.arSpace.id}/adjustments/${f.instance.id}`, body: () => ({ dPosition: { x: 9, y: 9, z: 9 }, dRotation: { x: 0, y: 0, z: 0 }, scaleFactor: { x: 1, y: 1, z: 1 } }) },
  { route: 'DELETE /api/ar/spaces/:id/adjustments/:instanceId', url: (f) => `/api/ar/spaces/${f.arSpace.id}/adjustments/${f.instance.id}` },
  { route: 'DELETE /api/ar/markers/:id', url: (f) => `/api/ar/markers/${f.arMarker.id}` },
  { route: 'GET /api/ar/markers/:id/files', url: (f) => `/api/ar/markers/${f.arMarker.id}/files?format=svg` },
  { route: 'GET /api/ar/markers/by-code/:code', url: () => `/api/ar/markers/by-code/${ringCodeOf(123456)}` },
  { route: 'POST /api/ar/spaces/:id/analytics', url: (f) => `/api/ar/spaces/${f.arSpace.id}/analytics`, body: () => ({ v: 1, platform: 'ar-quest', events: [{ type: 'enter', playerId: 'p1', t: Date.now() }] }) },
  { route: 'POST /api/ar/spaces/:id/report', url: (f) => `/api/ar/spaces/${f.arSpace.id}/report`, body: () => ({ reason: 'spam', platform: 'ar-quest' }) },
  { route: 'GET /api/ar/spaces/:id/feed', url: (f) => `/api/ar/spaces/${f.arSpace.id}/feed` },
  // AR headsets (B's shared headset; A guesses the secret)
  { route: 'POST /api/ar/devices/:id/pass', url: (f) => `/api/ar/devices/${f.arDevice.id}/pass`, body: (f) => ({ secret: 'guess', spaceId: f.arSpace.id }) },
  { route: 'POST /api/ar/devices/:id/end', url: (f) => `/api/ar/devices/${f.arDevice.id}/end`, body: () => ({ secret: 'guess' }) },
  { route: 'POST /api/ar/devices/:id/spaces', url: (f) => `/api/ar/devices/${f.arDevice.id}/spaces`, body: () => ({ secret: 'guess' }) },
  { route: 'POST /api/ar/devices/:id/scenes', url: (f) => `/api/ar/devices/${f.arDevice.id}/scenes`, body: () => ({ secret: 'guess' }) },
  { route: 'DELETE /api/ar/devices/:id', url: (f) => `/api/ar/devices/${f.arDevice.id}` },
  // deploy
  { route: 'GET /api/deploy/:id', url: (f) => `/api/deploy/${f.dcl.id}` },
  { route: 'GET /api/deploy/scene/:sceneId', url: (f) => `/api/deploy/scene/${f.scene.id}` },
  { route: 'POST /api/deploy/:id/cancel', url: (f) => `/api/deploy/${f.dcl.id}/cancel` },
  { route: 'POST /api/deploy/:id/signature', url: (f) => `/api/deploy/${f.signDeploy.id}/signature`, body: () => ({ chain: [] }) },
  // Decentraland World destinations
  { route: 'POST /api/dcl/destinations', url: () => '/api/dcl/destinations', body: (f) => ({ sceneId: f.scene.id, world: 'a-world.dcl.eth', mode: 'sign', plot: { width: 1, depth: 1, base: { x: 0, y: 0 } } }) },
  { route: 'GET /api/dcl/destinations/:id', url: (f) => `/api/dcl/destinations/${f.destination.id}` },
  { route: 'PATCH /api/dcl/destinations/:id', url: (f) => `/api/dcl/destinations/${f.destination.id}`, body: () => ({ mode: 'virvi' }) },
  { route: 'GET /api/dcl/destinations/:id/grant', url: (f) => `/api/dcl/destinations/${f.destination.id}/grant` },
  { route: 'POST /api/dcl/destinations/:id/grant', url: (f) => `/api/dcl/destinations/${f.destination.id}/grant`, body: () => ({ chains: [[], []], timestamp: Date.now() }) },
  { route: 'DELETE /api/dcl/destinations/:id/grant', url: (f) => `/api/dcl/destinations/${f.destination.id}/grant` },
  { route: 'POST /api/dcl/destinations/:id/revoke', url: (f) => `/api/dcl/destinations/${f.destination.id}/revoke`, body: () => ({ chains: [[]], timestamp: Date.now() }) },
  { route: 'POST /api/dcl/destinations/:id/deploy', url: (f) => `/api/dcl/destinations/${f.destination.id}/deploy` },
  { route: 'POST /api/dcl/destinations/:id/rebase', url: (f) => `/api/dcl/destinations/${f.destination.id}/rebase` },
  { route: 'GET /api/scenes/:sceneId/dcl/publish-status', url: (f) => `/api/scenes/${f.scene.id}/dcl/publish-status` },
  { route: 'GET /api/scenes/:sceneId/dcl/destinations', url: (f) => `/api/scenes/${f.scene.id}/dcl/destinations` },
  // events and command center
  { route: 'GET /api/events/:eventId', url: (f) => `/api/events/${f.event.id}` },
  { route: 'PUT /api/events/:eventId', url: (f) => `/api/events/${f.event.id}`, body: () => ({ name: 'pwned' }) },
  { route: 'DELETE /api/events/:eventId', url: (f) => `/api/events/${f.event.id}` },
  { route: 'POST /api/events/:eventId/link-scene', url: (f) => `/api/events/${f.event.id}/link-scene`, body: (f) => ({ sceneId: f.aScene.id }) },
  { route: 'POST /api/events/:eventId/link-scene', url: (f) => `/api/events/${f.aEvent.id}/link-scene`, body: (f) => ({ sceneId: f.scene.id }) },
  { route: 'POST /api/events/:eventId/link-giveaway', url: (f) => `/api/events/${f.event.id}/link-giveaway`, body: (f) => ({ giveawayId: f.giveaway.id }) },
  { route: 'POST /api/events/:eventId/link-giveaway', url: (f) => `/api/events/${f.aEvent.id}/link-giveaway`, body: (f) => ({ giveawayId: f.giveaway.id }) },
  { route: 'DELETE /api/events/:eventId/unlink-scene/:sceneId', url: (f) => `/api/events/${f.event.id}/unlink-scene/${f.scene.id}` },
  { route: 'DELETE /api/events/:eventId/unlink-giveaway/:giveawayId', url: (f) => `/api/events/${f.event.id}/unlink-giveaway/${f.giveaway.id}` },
  { route: 'GET /api/command-center/:eventId/status', url: (f) => `/api/command-center/${f.event.id}/status` },
  { route: 'POST /api/command-center/:eventId/broadcast', url: (f) => `/api/command-center/${f.event.id}/broadcast`, body: () => ({ action: { type: 'pwned' } }) },
  // streaming
  { route: 'POST /api/streaming/provision', url: () => '/api/streaming/provision', body: (f) => ({ name: 'pwned', sceneId: f.scene.id }) },
  { route: 'POST /api/hyperfy/worlds/:id/rotate-key', url: (f) => `/api/hyperfy/worlds/${f.world.id}/rotate-key` },
  { route: 'DELETE /api/hyperfy/pairings/:id', url: (f) => `/api/hyperfy/pairings/${f.pairing.id}` },
  { route: 'POST /api/hyperfy/pairings/:id/renew', url: (f) => `/api/hyperfy/pairings/${f.pairing.id}/renew`, body: () => ({ secret: 'guess' }) },
  // design studio
  { route: 'GET /api/studio/designs/:id', url: (f) => `/api/studio/designs/${f.design.id}` },
  { route: 'PATCH /api/studio/designs/:id', url: (f) => `/api/studio/designs/${f.design.id}`, body: () => ({ name: 'pwned', archived: true }) },
  { route: 'POST /api/studio/designs/:id/prompts', url: (f) => `/api/studio/designs/${f.design.id}/prompts`, body: () => ({ text: 'pwned' }) },
  { route: 'GET /api/studio/designs/:id/finalize', url: (f) => `/api/studio/designs/${f.design.id}/finalize` },
  { route: 'POST /api/studio/designs/:id/finalize', url: (f) => `/api/studio/designs/${f.design.id}/finalize`, body: () => ({ reports: { hat: 'pwned pwned pwned' } }) },
  { route: 'POST /api/studio/designs/:id/pieces/:category/revisions/:number/report', url: (f) => `/api/studio/designs/${f.design.id}/pieces/hat/revisions/1/report`, body: () => ({ text: 'the agent broke it, refund me' }) },
  { route: 'GET /api/studio/designs/:id/pieces/:category/revisions/:number/package', url: (f) => `/api/studio/designs/${f.design.id}/pieces/hat/revisions/1/package` },
  { route: 'POST /api/studio/designs/:id/pieces/:category/revisions/:number/package/retry', url: (f) => `/api/studio/designs/${f.design.id}/pieces/hat/revisions/1/package/retry` },
  { route: 'POST /api/studio/designs/:id/uploads', url: (f) => `/api/studio/designs/${f.design.id}/uploads?name=pwned.png`, body: () => ({ not: 'a file' }) },
  { route: 'GET /api/studio/designs/:id/uploads/:uploadId', url: (f) => `/api/studio/designs/${f.design.id}/uploads/${f.designUpload.id}` },
  { route: 'DELETE /api/studio/designs/:id/uploads/:uploadId', url: (f) => `/api/studio/designs/${f.design.id}/uploads/${f.designUpload.id}` },
  { route: 'POST /api/studio/designs/:id/renders', url: (f) => `/api/studio/designs/${f.design.id}/renders`, body: () => ({ category: 'hat', bodyShape: 'female', outfit: 'default', emote: null }) },
  { route: 'DELETE /api/hyperfy/worlds/:id', url: (f) => `/api/hyperfy/worlds/${f.world.id}` },
  { route: 'PATCH /api/hyperfy/worlds/:id', url: (f) => `/api/hyperfy/worlds/${f.world.id}`, body: () => ({ endsAt: null }) },
  { route: 'POST /api/hyperfy/worlds/:id/restore', url: (f) => `/api/hyperfy/worlds/${f.world.id}/restore` },
  { route: 'POST /api/hyperfy/worlds/:id/admin-code', url: (f) => `/api/hyperfy/worlds/${f.world.id}/admin-code` },
  { route: 'GET /api/streaming/:id', url: (f) => `/api/streaming/${f.stream.id}` },
  { route: 'DELETE /api/streaming/:id', url: (f) => `/api/streaming/${f.stream.id}` },
  { route: 'GET /api/streaming/:id/sessions', url: (f) => `/api/streaming/${f.stream.id}/sessions` },
  // giveaways
  { route: 'GET /api/giveaways/:giveawayId', url: (f) => `/api/giveaways/${f.giveaway.id}` },
  { route: 'PUT /api/giveaways/:giveawayId', url: (f) => `/api/giveaways/${f.giveaway.id}`, body: () => ({ name: 'pwned' }) },
  { route: 'DELETE /api/giveaways/:giveawayId', url: (f) => `/api/giveaways/${f.giveaway.id}` },
  { route: 'POST /api/giveaways/:giveawayId/items', url: (f) => `/api/giveaways/${f.giveaway.id}/items`, body: () => ({ name: 'pwned' }) },
  { route: 'DELETE /api/giveaways/:giveawayId/items/:itemId', url: (f) => `/api/giveaways/${f.giveaway.id}/items/${f.item.id}` },
  { route: 'GET /api/giveaways/:giveawayId/claims', url: (f) => `/api/giveaways/${f.giveaway.id}/claims` },
  // uploads, assets, media, hooks
  { route: 'POST /api/upload-tokens', url: () => '/api/upload-tokens', body: (f) => ({ sceneId: f.scene.id }) },
  { route: 'GET /api/assets/:id', url: (f) => `/api/assets/${f.asset.id}` },
  { route: 'PUT /api/assets/:id', url: (f) => `/api/assets/${f.asset.id}`, body: () => ({ isPublic: true }) },
  { route: 'DELETE /api/assets/:id', url: (f) => `/api/assets/${f.asset.id}` },
  { route: 'DELETE /api/media/:assetId', url: (f) => `/api/media/${f.media.id}` },
  { route: 'DELETE /api/hooks/:hookId', url: (f) => `/api/hooks/${f.hook.id}` },
  { route: 'DELETE /api/keys/:keyId', url: (f) => `/api/keys/${f.bKey.id}` },
  // analytics
  { route: 'GET /api/analytics/locations/:id/summary', url: (f) => `/api/analytics/locations/${f.location.id}/summary` },
  { route: 'GET /api/analytics/locations/:id/timeseries', url: (f) => `/api/analytics/locations/${f.location.id}/timeseries` },
  { route: 'GET /api/analytics/locations/:id/live', url: (f) => `/api/analytics/locations/${f.location.id}/live` },
  { route: 'GET /api/analytics/locations/:id/heatmap', url: (f) => `/api/analytics/locations/${f.location.id}/heatmap` },
  { route: 'GET /api/analytics/locations/:id/sessions', url: (f) => `/api/analytics/locations/${f.location.id}/sessions` },
  { route: 'PATCH /api/analytics/locations/:id', url: (f) => `/api/analytics/locations/${f.location.id}`, body: () => ({ walletVisibility: true }) },
  // orgs
  { route: 'PUT /api/orgs/:orgId', url: (f) => `/api/orgs/${f.org.id}`, body: () => ({ name: 'pwned' }) },
  { route: 'GET /api/orgs/:orgId/members', url: (f) => `/api/orgs/${f.org.id}/members` },
  { route: 'POST /api/orgs/:orgId/invites', url: (f) => `/api/orgs/${f.org.id}/invites`, body: (f) => ({ email: f.a.email }) },
  { route: 'PUT /api/orgs/:orgId/active', url: (f) => `/api/orgs/${f.org.id}/active` },
  { route: 'DELETE /api/orgs/:orgId/members/:userId', url: (f) => `/api/orgs/${f.org.id}/members/${f.b.id}` },
  // venues
  { route: 'POST /api/venues', url: () => '/api/venues', body: (f) => ({ sceneId: f.scene.id, name: 'pwned', slug: 'pwned' }) },
  { route: 'GET /api/venues/:venueId', url: (f) => `/api/venues/${f.venue.id}` },
  { route: 'PATCH /api/venues/:venueId', url: (f) => `/api/venues/${f.venue.id}`, body: () => ({ name: 'pwned' }) },
  { route: 'POST /api/venues/:venueId/bookings', url: (f) => `/api/venues/${f.venue.id}/bookings`, body: (f) => ({ renterWallet: f.a.wallet, title: 'pwned', startsAt: new Date(Date.now() + 72 * H).toISOString(), endsAt: new Date(Date.now() + 74 * H).toISOString() }) },
  { route: 'POST /api/venues/bookings/:bookingId/cancel', url: (f) => `/api/venues/bookings/${f.booking.id}/cancel` },
  { route: 'GET /api/venues/bookings/:bookingId/grants', url: (f) => `/api/venues/bookings/${f.booking.id}/grants` },
  { route: 'POST /api/venues/bookings/:bookingId/grants', url: (f) => `/api/venues/bookings/${f.booking.id}/grants`, body: (f) => ({ walletAddress: f.a.wallet, role: 'vj' }) },
  { route: 'PATCH /api/venues/grants/:grantId', url: (f) => `/api/venues/grants/${f.grant.id}`, body: () => ({ role: 'lighting' }) },
  { route: 'DELETE /api/venues/grants/:grantId', url: (f) => `/api/venues/grants/${f.grant.id}` },
  // admin (A is a creator)
  { route: 'GET /api/admin/users/:userId', url: (f) => `/api/admin/users/${f.b.id}` },
  { route: 'PUT /api/admin/users/:userId/role', url: (f) => `/api/admin/users/${f.b.id}/role`, body: () => ({ role: 'viewer' }) },
  { route: 'DELETE /api/admin/users/:userId', url: (f) => `/api/admin/users/${f.b.id}` },
  { route: 'DELETE /api/admin/orgs/:orgId', url: (f) => `/api/admin/orgs/${f.org.id}` },
  { route: 'PATCH /api/admin/catalog/packs/:id', url: () => '/api/admin/catalog/packs/any-pack', body: () => ({ enabled: false }) },
  { route: 'PATCH /api/admin/ar-reports/:id', url: () => `/api/admin/ar-reports/${AD_ID}`, body: () => ({ status: 'resolved' }) },
  { route: 'PATCH /api/admin/ads/:id', url: () => `/api/admin/ads/${AD_ID}`, body: () => ({ status: 'paused' }) },
  { route: 'POST /api/admin/ads/:id/creatives', url: () => `/api/admin/ads/${AD_ID}/creatives`, body: () => ({ mediaAssetId: AD_ID, shape: '1:1' }) },
  { route: 'DELETE /api/admin/ads/:id/creatives/:creativeId', url: () => `/api/admin/ads/${AD_ID}/creatives/${AD_ID}` },
  { route: 'PUT /api/admin/ads/:id/placements', url: () => `/api/admin/ads/${AD_ID}/placements`, body: () => ({ elementIds: [] }) },
  { route: 'GET /api/admin/ads/:id/report', url: () => `/api/admin/ads/${AD_ID}/report` },
  { route: 'POST /api/admin/ads/:id/review', url: () => `/api/admin/ads/${AD_ID}/review`, body: () => ({ decision: 'rejected', reason: 'x' }) },
  { route: 'POST /api/admin/studio/flags/:id/dismiss', url: () => `/api/admin/studio/flags/${AD_ID}/dismiss` },
  { route: 'POST /api/admin/studio/users/:userId/pause', url: (f) => `/api/admin/studio/users/${f.b.id}/pause` },
  { route: 'DELETE /api/admin/studio/users/:userId/pause', url: (f) => `/api/admin/studio/users/${f.b.id}/pause` },
  { route: 'POST /api/admin/studio/reports/:id/approve', url: () => `/api/admin/studio/reports/${AD_ID}/approve` },
  { route: 'POST /api/admin/studio/reports/:id/decline', url: () => `/api/admin/studio/reports/${AD_ID}/decline` },
  { route: 'POST /api/admin/studio/gift-codes/:id/off', url: () => `/api/admin/studio/gift-codes/${AD_ID}/off` },
  { route: 'GET /api/ad-spaces/:elementId', url: (f) => `/api/ad-spaces/${f.adSpace.id}` },
  { route: 'PUT /api/ad-spaces/:elementId/content', url: (f) => `/api/ad-spaces/${f.adSpace.id}/content`, body: () => ({ content: 'all' }) },
  { route: 'PUT /api/ad-spaces/:elementId/approvals/:adId', url: (f) => `/api/ad-spaces/${f.adSpace.id}/approvals/${AD_ID}`, body: () => ({ decision: 'approved' }) },
]

// Collected routes with a `:param` (or a body id) that are not another account's resource, each with its reason.
const NOT_CROSS_ACCOUNT: Record<string, string> = {
  'GET /api/upload/:code': 'the upload code is the auth (companion phone upload)',
  'GET /api/upload/:code/qr.png': 'the upload code is the auth (companion phone upload)',
  'POST /api/upload/:code/start': 'the upload code is the auth (companion phone upload)',
  'POST /api/upload/:code/:assetId': 'the upload code is the auth (companion phone upload)',
  'GET /api/hyperfy/pair/:code/qr.png': 'the pairing code is the auth (QR of the approve link)',
  'GET /api/hyperfy/pair/:code': 'the pairing code is the auth: any signed-in user holding it sees the approval page',
  'POST /api/hyperfy/pair/:code/approve': 'the pairing code is the auth; approval checks the approver\'s own edit access to the world\'s scene (a stranger refuses the code, which is rate limited)',
  'POST /api/hyperfy/pair/:code/claim': 'the pairing code plus the browser secret is the auth',
  'GET /api/ar/pair/:code': 'the pairing code is the auth: any signed-in account holding it sees the approval page',
  'POST /api/ar/pair/:code/approve': "the pairing code is the auth; the headset then acts only with the approver's own build access, checked at each mint (rate limited)",
  'POST /api/ar/pair/:code/claim': 'the pairing code plus the headset secret is the auth',
  'POST /api/orgs/accept-invite': 'invite token only; the token names the org',
  'GET /api/auth/google/callback': 'OAuth callback; no bearer',
  'GET /api/auth/discord/callback': 'OAuth callback; no bearer',
  'POST /hook/register': 'public by owner decision: scene content is public in-world (address checks and the 20-per-scene cap guard it)',
  'GET /hook/config': 'public by owner decision: scene content is public in-world',
  'GET /hook/scene': 'public by owner decision: scene content is public in-world',
  'GET /api/dcl/worlds/:world': "public Decentraland data about a typed World name; it only says whether the caller's own wallets own it",
  'GET /api/studio/worker/designs/:designId/workspace': "the per-design worker token is the auth; another design's token is 403 (studio-worker-routes.test.ts)",
  'PUT /api/studio/worker/designs/:designId/workspace': "the per-design worker token is the auth; another design's token is 403 (studio-worker-routes.test.ts)",
  'GET /api/studio/worker/designs/:designId/jobs/next': "the per-design worker token is the auth; another design's token is 403 (studio-worker-routes.test.ts)",
  'POST /api/studio/worker/jobs/:jobId/events': "the per-design worker token is the auth; another design's token is 403 (studio-worker-routes.test.ts)",
  'PUT /api/studio/worker/jobs/:jobId/files/*': "the per-design worker token is the auth; another design's token is 403 (studio-worker-routes.test.ts)",
  'GET /api/studio/render-frames/*': 'the signed frame token is the auth; it names one frame of one design (studio-routes.test.ts)',
  'POST /api/studio/worker/jobs/:jobId/result': "the per-design worker token is the auth; another design's token is 403 (studio-worker-routes.test.ts)",
  'GET /api/studio/worker/jobs/:jobId/inputs/*': "the per-design worker token is the auth; another design's token is 403 (studio-finalize.test.ts)",
}

// Every table holding B's fixtures; a refused request must leave all of them as they were.
const TABLES = [
  users, scenes, scenePresets, sceneElements, sceneElementInstances, sceneCollaborators, sceneRoles, sceneLibrary,
  sceneDeployments, streamingServers, events, eventSceneLinks, eventGiveawayLinks, giveaways,
  giveawayItems, assetLibraryItems, mediaAssets, organizations, orgMembers, orgInvites, venues, bookings, accessGrants,
  uploadTokens, platformCallbacks, analyticsScenes, locationSetups, hyperfyWorlds, hyperfyPairings, arSpaces, arFloors, arMarkers, arAdjustments, arDevices, roomScans, roomSets,
  dclWorldDestinations,
  studioDesigns, studioPieces, studioRevisions, studioJobs, studioMessages, studioRenders, studioUsageDays,
  studioPayments, studioEntitlements, studioMistakeReports, studioPromptCredits, studioUploads, studioScopeEvents, studioFlags, studioPauses,
]
async function snapshot(f: F) {
  const all = await Promise.all(TABLES.map((t) => db.select().from(t as any)))
  // API keys: only B's (A's own key gets lastUsedAt stamped on every request).
  const keys = (await db.select().from(apiKeys)).filter((k) => k.userId === f.b.id)
  return [...all, keys].map((rows) => rows.map((r) => JSON.stringify(r)).sort())
}

const paramRoutes = (app: any) =>
  ((app.registeredRoutes as Array<{ method: string; url: string }>) ?? [])
    .map((r) => `${r.method} ${r.url}`)
    .filter((k) => /\/:/.test(k))

describe('cross-account route walk', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let f: F
  const prevStreaming = config.streamingEnabled
  const prevStudio = config.studioEnabled
  const prevDeployKey = config.virviDclDeployKey
  beforeEach(async () => {
    await resetDb()
    ;(config as any).streamingEnabled = true
    ;(config as any).studioEnabled = true
    // Never reach Decentraland: B's World is owned by B in the fake
    ;(config as any).virviDclDeployKey = Wallet.createRandom().privateKey
    const worlds = new FakeWorldsClient()
    setWorldsClient(worlds)
    app = await testApp()
    f = await fixtures()
    const store = memoryStudioStore()
    setStudioStore(store)
    const [paid] = await db.select().from(studioEntitlements)
    await store.put(paid.packageKey!, Buffer.from('PK-b-package'), 'application/zip')
    await store.put(uploadKey(f.design.id, f.designUpload.id), Buffer.from('b-png'), 'image/png')
    worlds.deployers.set('b-world.dcl.eth', { owner: f.b.wallet, deployers: [] })
  })
  afterEach(async () => {
    ;(config as any).streamingEnabled = prevStreaming
    ;(config as any).studioEnabled = prevStudio
    setStudioStore(null)
    ;(config as any).virviDclDeployKey = prevDeployKey
    setWorldsClient(null)
    await app.close()
  })

  async function walk(bearer: string) {
    const offenders: string[] = []
    for (const c of CASES) {
      const before = await snapshot(f)
      const [method] = c.route.split(' ')
      const res = await app.inject({ method: method as any, url: c.url(f), headers: { authorization: `Bearer ${bearer}` }, payload: c.body?.(f) })
      // Fastify's own 404 means the URL matched no route: the case is broken, not refused.
      if (res.statusCode === 404 && /^Route .* not found$/.test(res.json().message ?? '')) offenders.push(`${c.route} (${c.url(f)}) matched no route`)
      else if (![401, 403, 404].includes(res.statusCode)) offenders.push(`${c.route} (${c.url(f)}) → ${res.statusCode} ${res.body.slice(0, 120)}`)
      else if (JSON.stringify(await snapshot(f)) !== JSON.stringify(before)) offenders.push(`${c.route} (${c.url(f)}) → ${res.statusCode} but changed B's data`)
    }
    return offenders
  }

  it("A's account token cannot read or change any of B's resources", async () => {
    expect(await walk(tokenFor(f.a))).toEqual([])
  })

  it("an API key for A cannot read or change any of B's resources", async () => {
    const res = await app.inject({ method: 'POST', url: '/api/keys', headers: { authorization: `Bearer ${tokenFor(f.a)}` }, payload: { name: 'A key' } })
    expect(res.statusCode).toBe(201)
    expect(await walk(res.json().key)).toEqual([])
  }, 30_000) // every route, each with a table snapshot: past 15 s on a loaded machine

  it("B's own token reads every GET case (the fixtures are real, so A's refusals are not misses)", async () => {
    const failed: string[] = []
    for (const c of CASES.filter((c) => c.route.startsWith('GET ') && !c.route.includes('/hyperfy/') && !c.route.includes('/admin/'))) {
      const res = await app.inject({ method: 'GET', url: c.url(f), headers: { authorization: `Bearer ${tokenFor(f.b)}` } })
      if (res.statusCode !== 200) failed.push(`${c.route} → ${res.statusCode}`)
    }
    expect(failed).toEqual([])
  })

  it('every collected route with a :param is walked or listed in NOT_CROSS_ACCOUNT', async () => {
    const covered = new Set([...CASES.map((c) => c.route), ...Object.keys(NOT_CROSS_ACCOUNT)])
    expect(paramRoutes(app).filter((k) => !covered.has(k))).toEqual([])
  })

  it('every CASES and NOT_CROSS_ACCOUNT entry is a registered route (no stale entries)', async () => {
    const keys = new Set(((app as any).registeredRoutes as Array<{ method: string; url: string }>).map((r) => `${r.method} ${r.url}`))
    expect([...CASES.map((c) => c.route), ...Object.keys(NOT_CROSS_ACCOUNT)].filter((k) => !keys.has(k))).toEqual([])
  })
})
