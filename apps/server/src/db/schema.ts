import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  primaryKey,
  pgEnum,
  customType,
  index,
  uniqueIndex,
  check,
  bigserial,
  real,
  smallint,
  date,
  doublePrecision,
  bigint,
} from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'
import type { VenueRules, Vec3, RoomScanLayout, Plot } from '@virvixr/shared'

// ── Enums ────────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum('user_role', ['admin', 'creator', 'viewer'])
export const authMethodTypeEnum = pgEnum('auth_method_type', ['email', 'wallet', 'oauth'])
export const collaboratorRoleEnum = pgEnum('collaborator_role', ['owner', 'editor', 'viewer'])
export const elementTypeEnum = pgEnum('element_type', [
  'image',
  'video',
  'nft',
  'sound',
  'widget',
  'custom',
  'model',
  'ad_space',
])

export const orgRoleEnum = pgEnum('org_role', ['owner', 'admin', 'member'])
export const inviteStatusEnum = pgEnum('invite_status', ['pending', 'accepted', 'declined', 'expired'])

// ── Organizations ───────────────────────────────────────────────────────────

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  billingOwnerId: uuid('billing_owner_id'), // set after users table exists via migration
  logoUrl: text('logo_url'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  members: many(orgMembers),
  scenes: many(scenes),
  mediaAssets: many(mediaAssets),
  events: many(events),
  giveaways: many(giveaways),
  subscriptions: many(subscriptions),
}))

// ── Organization Members ────────────────────────────────────────────────────

export const orgMembers = pgTable(
  'org_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgRoleEnum('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.userId] }),
  }),
)

export const orgMembersRelations = relations(orgMembers, ({ one }) => ({
  org: one(organizations, {
    fields: [orgMembers.orgId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [orgMembers.userId],
    references: [users.id],
  }),
}))

// ── Organization Invites ────────────────────────────────────────────────────

export const orgInvites = pgTable('org_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: orgRoleEnum('role').notNull().default('member'),
  invitedBy: uuid('invited_by')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  status: inviteStatusEnum('status').notNull().default('pending'),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const orgInvitesRelations = relations(orgInvites, ({ one }) => ({
  org: one(organizations, {
    fields: [orgInvites.orgId],
    references: [organizations.id],
  }),
  inviter: one(users, {
    fields: [orgInvites.invitedBy],
    references: [users.id],
  }),
}))

// ── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  email: text('email'),
  role: userRoleEnum('role').notNull().default('creator'),
  activeOrgId: uuid('active_org_id'), // current org context (FK added via migration to avoid circular)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const usersRelations = relations(users, ({ one, many }) => ({
  authMethods: many(userAuthMethods),
  scenes: many(scenes),
  collaborations: many(sceneCollaborators),
  mediaAssets: many(mediaAssets),
  orgMemberships: many(orgMembers),
  activeOrg: one(organizations, {
    fields: [users.activeOrgId],
    references: [organizations.id],
  }),
}))

// ── User Auth Methods ────────────────────────────────────────────────────────

export const userAuthMethods = pgTable('user_auth_methods', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  type: authMethodTypeEnum('type').notNull(),
  identifier: text('identifier').notNull(),
  credentialHash: text('credential_hash'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const userAuthMethodsRelations = relations(userAuthMethods, ({ one }) => ({
  user: one(users, {
    fields: [userAuthMethods.userId],
    references: [users.id],
  }),
}))

// ── Scenes ───────────────────────────────────────────────────────────────────

export const scenes = pgTable('scenes', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  thumbnailUrl: text('thumbnail_url'),
  activePresetId: uuid('active_preset_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const scenesRelations = relations(scenes, ({ one, many }) => ({
  org: one(organizations, {
    fields: [scenes.orgId],
    references: [organizations.id],
  }),
  owner: one(users, {
    fields: [scenes.ownerId],
    references: [users.id],
  }),
  presets: many(scenePresets),
  collaborators: many(sceneCollaborators),
}))

// ── Scene Presets ────────────────────────────────────────────────────────────

export const scenePresets = pgTable('scene_presets', {
  id: uuid('id').primaryKey().defaultRandom(),
  sceneId: uuid('scene_id')
    .notNull()
    .references(() => scenes.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  locale: text('locale'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const scenePresetsRelations = relations(scenePresets, ({ one, many }) => ({
  scene: one(scenes, {
    fields: [scenePresets.sceneId],
    references: [scenes.id],
  }),
  elements: many(sceneElements),
}))

// ── Scene Elements ───────────────────────────────────────────────────────────

export const sceneElements = pgTable('scene_elements', {
  id: uuid('id').primaryKey().defaultRandom(),
  presetId: uuid('preset_id')
    .notNull()
    .references(() => scenePresets.id, { onDelete: 'cascade' }),
  type: elementTypeEnum('type').notNull(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  customId: text('custom_id'),
  customRendering: boolean('custom_rendering').notNull().default(false),
  clickEvent: jsonb('click_event'),
  properties: jsonb('properties'),
  clonedFromId: uuid('cloned_from_id'), // set when copied into a booking preset
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const sceneElementsRelations = relations(sceneElements, ({ one, many }) => ({
  preset: one(scenePresets, {
    fields: [sceneElements.presetId],
    references: [scenePresets.id],
  }),
  instances: many(sceneElementInstances),
}))

// ── Scene Element Instances ──────────────────────────────────────────────────

export const sceneElementInstances = pgTable('scene_element_instances', {
  id: uuid('id').primaryKey().defaultRandom(),
  elementId: uuid('element_id')
    .notNull()
    .references(() => sceneElements.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  customId: text('custom_id'),
  customRendering: boolean('custom_rendering').notNull().default(false),
  position: jsonb('position'),
  rotation: jsonb('rotation'),
  scale: jsonb('scale'),
  clickEvent: jsonb('click_event'),
  parentInstanceId: uuid('parent_instance_id'),
  withCollisions: boolean('with_collisions').notNull().default(false),
  properties: jsonb('properties'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const sceneElementInstancesRelations = relations(sceneElementInstances, ({ one }) => ({
  element: one(sceneElements, {
    fields: [sceneElementInstances.elementId],
    references: [sceneElements.id],
  }),
  parentInstance: one(sceneElementInstances, {
    fields: [sceneElementInstances.parentInstanceId],
    references: [sceneElementInstances.id],
  }),
}))

// ── Scene Collaborators ──────────────────────────────────────────────────────

export const sceneCollaborators = pgTable(
  'scene_collaborators',
  {
    sceneId: uuid('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: collaboratorRoleEnum('role').notNull().default('viewer'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sceneId, table.userId] }),
  }),
)

export const sceneCollaboratorsRelations = relations(sceneCollaborators, ({ one }) => ({
  scene: one(scenes, {
    fields: [sceneCollaborators.sceneId],
    references: [scenes.id],
  }),
  user: one(users, {
    fields: [sceneCollaborators.userId],
    references: [users.id],
  }),
}))

// ── Analytics ────────────────────────────────────────────────────────────────

export const analyticsSceneKindEnum = pgEnum('analytics_scene_kind', ['parcels', 'world', 'preview', 'hyperfy', 'ar'])
export const analyticsClaimStatusEnum = pgEnum('analytics_claim_status', ['active', 'lapsed'])

export const analyticsScenes = pgTable('analytics_scenes', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: analyticsSceneKindEnum('kind').notNull(),
  locationKey: text('location_key').notNull().unique(),
  realm: text('realm').notNull(),
  baseParcel: text('base_parcel'),
  parcels: text('parcels').array().notNull().default(sql`'{}'::text[]`),
  worldName: text('world_name'),
  activeEntityId: text('active_entity_id'),
  title: text('title'),
  salt: text('salt').notNull(), // 64 hex chars; never sent to clients
  claimedByUserId: uuid('claimed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  claimStatus: analyticsClaimStatusEnum('claim_status'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  lapsedAt: timestamp('lapsed_at', { withTimezone: true }),
  virviSceneId: uuid('virvi_scene_id').references(() => scenes.id, { onDelete: 'set null' }),
  walletVisibility: boolean('wallet_visibility').notNull().default(false),
  isPreview: boolean('is_preview').notNull().default(false),
  verifiedSessionShare: real('verified_session_share').notNull().default(0),
  lastEntityCheckAt: timestamp('last_entity_check_at', { withTimezone: true }),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  virviSceneIdx: index('analytics_scenes_virvi_scene_idx').on(t.virviSceneId),
  claimerIdx: index('analytics_scenes_claimer_idx').on(t.claimedByUserId),
  lastActivityIdx: index('analytics_scenes_last_activity_idx').on(t.lastActivityAt),
}))

export const analyticsSessions = pgTable('analytics_sessions', {
  id: uuid('id').primaryKey(), // client-generated session id
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  visitorHash: text('visitor_hash').notNull(),
  wallet: text('wallet'),
  displayName: text('display_name'),
  isGuest: boolean('is_guest').notNull().default(false),
  verified: boolean('verified').notNull().default(false),
  platform: text('platform'),
  device: text('device'),
  realm: text('realm'),
  country: text('country'),
  cameraMode: text('camera_mode'),
  isReturning: boolean('is_returning').notNull().default(false),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  durationSec: integer('duration_sec').notNull().default(0),
  eventCount: integer('event_count').notNull().default(0),
}, (t) => ({
  sceneStartIdx: index('analytics_sessions_scene_started_idx').on(t.sceneId, t.startedAt),
  sceneSeenIdx: index('analytics_sessions_scene_seen_idx').on(t.sceneId, t.lastSeenAt),
  sceneVisitorIdx: index('analytics_sessions_scene_visitor_idx').on(t.sceneId, t.visitorHash),
  // Session-close sweep: open sessions by last_seen_at.
  openSeenIdx: index('analytics_sessions_open_seen_idx').on(t.lastSeenAt).where(sql`ended_at is null`),
}))

export const analyticsEvents = pgTable('analytics_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull(),
  seq: integer('seq').notNull(),
  visitorHash: text('visitor_hash').notNull(),
  type: text('type').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  verified: boolean('verified').notNull().default(false),
  data: jsonb('data'),
}, (t) => ({
  sessionSeqUq: uniqueIndex('analytics_events_session_seq_uq').on(t.sessionId, t.seq),
  sceneTimeIdx: index('analytics_events_scene_time_idx').on(t.sceneId, t.occurredAt),
}))

export const analyticsPositions = pgTable('analytics_positions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull(),
  seq: integer('seq').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  x: real('x').notNull(),
  y: real('y').notNull(),
  z: real('z').notNull(),
  heading: smallint('heading').notNull().default(0),
  moving: boolean('moving').notNull().default(false),
}, (t) => ({
  sessionSeqUq: uniqueIndex('analytics_positions_session_seq_uq').on(t.sessionId, t.seq),
  sceneTimeIdx: index('analytics_positions_scene_time_idx').on(t.sceneId, t.occurredAt),
}))

export const analyticsDirtyHours = pgTable('analytics_dirty_hours', {
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  hour: timestamp('hour', { withTimezone: true }).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.sceneId, t.hour] }) }))

export const analyticsJobRuns = pgTable('analytics_job_runs', {
  name: text('name').primaryKey(),
  lastRunDay: date('last_run_day').notNull(),
})

export const analyticsRollupHourly = pgTable('analytics_rollup_hourly', {
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  hour: timestamp('hour', { withTimezone: true }).notNull(),
  sessions: integer('sessions').notNull().default(0),
  uniqueVisitors: integer('unique_visitors').notNull().default(0),
  newVisitors: integer('new_visitors').notNull().default(0),
  returningVisitors: integer('returning_visitors').notNull().default(0),
  verifiedSessions: integer('verified_sessions').notNull().default(0),
  peakConcurrency: integer('peak_concurrency').notNull().default(0),
  dwellAvgSec: integer('dwell_avg_sec').notNull().default(0),
  dwellP50Sec: integer('dwell_p50_sec').notNull().default(0),
  dwellP90Sec: integer('dwell_p90_sec').notNull().default(0),
  interactions: jsonb('interactions').notNull().default({}),
  video: jsonb('video').notNull().default({}),
  emotes: jsonb('emotes').notNull().default({}),
  countries: jsonb('countries').notNull().default({}),
  platforms: jsonb('platforms').notNull().default({}),
  cameraModes: jsonb('camera_modes').notNull().default({}),
}, (t) => ({ pk: primaryKey({ columns: [t.sceneId, t.hour] }) }))

export const analyticsHeatmapDaily = pgTable('analytics_heatmap_daily', {
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),
  cellX: smallint('cell_x').notNull(),
  cellZ: smallint('cell_z').notNull(),
  dwellSec: integer('dwell_sec').notNull().default(0),
  visits: integer('visits').notNull().default(0),
}, (t) => ({ pk: primaryKey({ columns: [t.sceneId, t.day, t.cellX, t.cellZ] }) }))

export const analyticsCopresenceDaily = pgTable('analytics_copresence_daily', {
  sceneId: uuid('scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),
  visitorA: text('visitor_a').notNull(),
  visitorB: text('visitor_b').notNull(),
  overlapSec: integer('overlap_sec').notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.sceneId, t.day, t.visitorA, t.visitorB] }) }))

// ── Events ───────────────────────────────────────────────────────────────────

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  startTime: timestamp('start_time', { withTimezone: true }),
  endTime: timestamp('end_time', { withTimezone: true }),
  timezone: text('timezone').default('UTC'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const eventsRelations = relations(events, ({ one, many }) => ({
  owner: one(users, {
    fields: [events.ownerId],
    references: [users.id],
  }),
  sceneLinks: many(eventSceneLinks),
  giveawayLinks: many(eventGiveawayLinks),
}))

export const eventSceneLinks = pgTable('event_scene_links', {
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  sceneId: uuid('scene_id').notNull().references(() => scenes.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.eventId, table.sceneId] }),
}))

export const eventSceneLinksRelations = relations(eventSceneLinks, ({ one }) => ({
  event: one(events, {
    fields: [eventSceneLinks.eventId],
    references: [events.id],
  }),
  scene: one(scenes, {
    fields: [eventSceneLinks.sceneId],
    references: [scenes.id],
  }),
}))

// ── Giveaways ────────────────────────────────────────────────────────────────

export const giveaways = pgTable('giveaways', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  claimLimit: integer('claim_limit').default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const giveawaysRelations = relations(giveaways, ({ one, many }) => ({
  owner: one(users, {
    fields: [giveaways.ownerId],
    references: [users.id],
  }),
  items: many(giveawayItems),
  claims: many(giveawayClaims),
  eventLinks: many(eventGiveawayLinks),
}))

export const giveawayItems = pgTable('giveaway_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  giveawayId: uuid('giveaway_id').notNull().references(() => giveaways.id, { onDelete: 'cascade' }),
  name: text('name'),
  imageUrl: text('image_url'),
  contractAddress: text('contract_address'),
  tokenId: text('token_id'),
  metadata: jsonb('metadata'),
})

export const giveawayItemsRelations = relations(giveawayItems, ({ one }) => ({
  giveaway: one(giveaways, {
    fields: [giveawayItems.giveawayId],
    references: [giveaways.id],
  }),
}))

export const giveawayClaims = pgTable('giveaway_claims', {
  id: uuid('id').primaryKey().defaultRandom(),
  giveawayId: uuid('giveaway_id').notNull().references(() => giveaways.id),
  userId: text('user_id'),
  walletAddress: text('wallet_address'),
  itemId: uuid('item_id').references(() => giveawayItems.id),
  status: text('status').notNull().default('pending'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
})

export const giveawayClaimsRelations = relations(giveawayClaims, ({ one }) => ({
  giveaway: one(giveaways, {
    fields: [giveawayClaims.giveawayId],
    references: [giveaways.id],
  }),
  item: one(giveawayItems, {
    fields: [giveawayClaims.itemId],
    references: [giveawayItems.id],
  }),
}))

export const eventGiveawayLinks = pgTable('event_giveaway_links', {
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  giveawayId: uuid('giveaway_id').notNull().references(() => giveaways.id, { onDelete: 'cascade' }),
}, (table) => ({
  pk: primaryKey({ columns: [table.eventId, table.giveawayId] }),
}))

export const eventGiveawayLinksRelations = relations(eventGiveawayLinks, ({ one }) => ({
  event: one(events, {
    fields: [eventGiveawayLinks.eventId],
    references: [events.id],
  }),
  giveaway: one(giveaways, {
    fields: [eventGiveawayLinks.giveawayId],
    references: [giveaways.id],
  }),
}))

// ── Platform Callbacks (HTTP push for non-WebSocket platforms) ──────────────

export const platformCallbacks = pgTable('platform_callbacks', {
  id: uuid('id').primaryKey().defaultRandom(),
  sceneId: uuid('scene_id')
    .notNull()
    .references(() => scenes.id, { onDelete: 'cascade' }),
  elementId: text('element_id'), // customId or SK — null for controller/scene-level
  elementType: text('element_type'), // 'video' | 'image' | 'controller' — null for scene-level
  platform: text('platform').notNull(), // 'secondlife', etc.
  mode: text('mode').notNull().default('element'), // 'element' | 'controller'
  callbackUrl: text('callback_url').notNull(),
  region: text('region'), // platform-specific location for debugging
  metadata: jsonb('metadata'),
  failureCount: integer('failure_count').notNull().default(0),
  lastRegistered: timestamp('last_registered', { withTimezone: true }).notNull().defaultNow(),
})

export const platformCallbacksRelations = relations(platformCallbacks, ({ one }) => ({
  scene: one(scenes, {
    fields: [platformCallbacks.sceneId],
    references: [scenes.id],
  }),
}))

// ── Media Assets ────────────────────────────────────────────────────────────

export const mediaAssets = pgTable('media_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  storageKey: text('storage_key'), // path in storage provider; null until an in-flight upload is stored
  publicUrl: text('public_url'),
  folder: text('folder').default('/'),
  metadata: jsonb('metadata'), // dimensions, duration, etc.
  // 'uploading' | 'processing' | 'ready' | 'failed' (two-step companion uploads; everything else is stored ready)
  status: text('status').notNull().default('ready'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const mediaAssetsRelations = relations(mediaAssets, ({ one }) => ({
  owner: one(users, {
    fields: [mediaAssets.ownerId],
    references: [users.id],
  }),
}))

// ── 3D Asset Library ───────────────────────────────────────────────────────

/** A switchable group of open-source catalog models (one source × artist or collection). */
export const catalogPacks = pgTable('catalog_packs', {
  id: text('id').primaryKey(), // slug, e.g. 'last-slice-kirzoz'
  name: text('name').notNull(),
  source: text('source').notNull(), // 'dhingia' | 'last-slice' | 'decentraland'
  license: text('license').notNull(), // 'mit' | 'cc-by-nc-3.0' | 'unstated'
  attribution: text('attribution').notNull(),
  sourceUrl: text('source_url').notNull(),
  // Off: hidden from browsing and new scene-library links; already-linked models keep working
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const assetLibraryItems = pgTable('asset_library_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  category: text('category'), // 'architecture', 'nature', 'furniture', 'effects', etc.
  tags: text('tags').array(), // ['modern', 'outdoor', 'low-poly']
  storageKey: text('storage_key').notNull(),
  cdnUrl: text('cdn_url'),
  thumbnailUrl: text('thumbnail_url'),
  fileSizeBytes: integer('file_size_bytes').notNull().default(0),
  triangleCount: integer('triangle_count'),
  textureCount: integer('texture_count'),
  materialCount: integer('material_count'),
  dimensions: jsonb('dimensions'), // { width, height, depth }
  license: text('license'), // 'cc0', 'cc-by', 'proprietary', etc.
  author: text('author'),
  isPublic: boolean('is_public').notNull().default(true),
  uploadedBy: uuid('uploaded_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Catalog models (non-null packId): public, no uploader, never counted toward storage
  packId: text('pack_id').references(() => catalogPacks.id, { onDelete: 'restrict' }),
  style: text('style'),
  venueTags: text('venue_tags').array(),
  sourceRef: text('source_ref'), // the item's id or path in its source; re-imports upsert on (pack_id, source_ref)
  contentHash: text('content_hash'), // sha256 of the GLB
}, (t) => ({
  packRefUq: uniqueIndex('asset_library_items_pack_ref').on(t.packId, t.sourceRef),
  contentHashIdx: index('asset_library_items_content_hash_idx').on(t.contentHash),
}))

export const assetLibraryItemsRelations = relations(assetLibraryItems, ({ one }) => ({
  uploader: one(users, {
    fields: [assetLibraryItems.uploadedBy],
    references: [users.id],
  }),
}))

// ── Scene Deployments ──────────────────────────────────────────────────────

export const deploymentStatusEnum = pgEnum('deployment_status', [
  'pending',
  'building',
  'deploying',
  'deployed',
  'failed',
  'awaiting_signature',
])

export const sceneDeployments = pgTable('scene_deployments', {
  id: uuid('id').primaryKey().defaultRandom(),
  sceneId: uuid('scene_id')
    .notNull()
    .references(() => scenes.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(), // 'decentraland' | 'hyperfy'
  status: deploymentStatusEnum('status').notNull().default('pending'),
  deploymentType: text('deployment_type').notNull(), // 'parcel' | 'world' | 'instance'
  target: jsonb('target').notNull(), // DCL: { parcels, contentServer } / Hyperfy: { instanceUrl, region }
  assetBundle: jsonb('asset_bundle'), // list of asset IDs + config included in deploy
  deployedBy: uuid('deployed_by').references(() => users.id),
  errorMessage: text('error_message'),
  catalystEntityId: text('catalyst_entity_id'), // DCL catalyst entity hash
  infrastructureId: text('infrastructure_id'), // Hyperfy: Docker container ID, Fly machine ID
  destinationId: uuid('destination_id').references(() => dclWorldDestinations.id, { onDelete: 'set null' }),
  deployedAt: timestamp('deployed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const sceneDeploymentsRelations = relations(sceneDeployments, ({ one }) => ({
  scene: one(scenes, {
    fields: [sceneDeployments.sceneId],
    references: [scenes.id],
  }),
  deployer: one(users, {
    fields: [sceneDeployments.deployedBy],
    references: [users.id],
  }),
  destination: one(dclWorldDestinations, {
    fields: [sceneDeployments.destinationId],
    references: [dclWorldDestinations.id],
  }),
}))

export const dclDestinationModeEnum = pgEnum('dcl_destination_mode', ['virvi', 'sign'])
export const dclDestinationStatusEnum = pgEnum('dcl_destination_status', ['ok', 'needs_review', 'over_budget', 'unreachable'])

/** A Decentraland World a scene deploys to. Virvi never holds the owner's key. */
export const dclWorldDestinations = pgTable('dcl_world_destinations', {
  id: uuid('id').primaryKey().defaultRandom(),
  sceneId: uuid('scene_id')
    .notNull()
    .references(() => scenes.id, { onDelete: 'cascade' }),
  ownerUserId: uuid('owner_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  ownerWallet: text('owner_wallet').notNull(), // lowercased
  worldName: text('world_name').notNull().unique(), // lowercased
  base: text('base').notNull(), // "x,y"
  parcels: text('parcels').array().notNull(),
  mode: dclDestinationModeEnum('mode').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }), // null until mode A permission is confirmed
  status: dclDestinationStatusEnum('status').notNull().default('ok'),
  statusDetail: text('status_detail'),
  lastEntityId: text('last_entity_id'),
  deployedFiles: text('deployed_files').array().notNull().default(sql`'{}'::text[]`), // lowercased paths
  pendingSince: timestamp('pending_since', { withTimezone: true }),
  adopted: boolean('adopted').notNull().default(false), // true = the owner's own scene code, never touched
  spawn: jsonb('spawn').$type<{ x: number; y: number; z: number }>(), // metres, plot-relative; null = plot centre
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sceneIdx: index('dcl_world_destinations_scene_idx').on(t.sceneId),
}))

export const dclWorldDestinationsRelations = relations(dclWorldDestinations, ({ one }) => ({
  scene: one(scenes, {
    fields: [dclWorldDestinations.sceneId],
    references: [scenes.id],
  }),
  owner: one(users, {
    fields: [dclWorldDestinations.ownerUserId],
    references: [users.id],
  }),
}))

// ── Streaming Servers ──────────────────────────────────────────────────────

export const streamingServerTypeEnum = pgEnum('streaming_server_type', ['shared', 'dedicated'])
export const streamingServerStatusEnum = pgEnum('streaming_server_status', [
  'provisioning',
  'ready',
  'live',
  'offline',
  'error',
  'terminated',
])

export const streamingServers = pgTable('streaming_servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: streamingServerTypeEnum('type').notNull().default('shared'),
  status: streamingServerStatusEnum('status').notNull().default('provisioning'),
  rtmpUrl: text('rtmp_url'), // e.g. rtmp://ingest.virvi.io/live
  streamKey: text('stream_key'), // unique key for this stream — secret: only the owner and the media server see it
  playbackId: text('playback_id'), // public id (128-bit random) in the playback URL and HLS folder — never the stream key
  hlsPlaylistUrl: text('hls_playlist_url'), // e.g. https://cdn.virvi.io/streams/{id}/playlist.m3u8
  region: text('region').default('us-east-1'),
  infrastructureId: text('infrastructure_id'), // ECS task ARN, Fly machine ID, etc.
  sceneId: uuid('scene_id').references(() => scenes.id), // optional: auto-link to a scene's video
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const streamingServersRelations = relations(streamingServers, ({ one, many }) => ({
  owner: one(users, {
    fields: [streamingServers.ownerId],
    references: [users.id],
  }),
  scene: one(scenes, {
    fields: [streamingServers.sceneId],
    references: [scenes.id],
  }),
  sessions: many(streamingSessions),
}))

// ── Streaming Sessions ─────────────────────────────────────────────────────

export const streamingSessions = pgTable('streaming_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id')
    .notNull()
    .references(() => streamingServers.id, { onDelete: 'cascade' }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  durationSeconds: integer('duration_seconds'),
  peakBitrate: integer('peak_bitrate'), // kbps
  peakViewers: integer('peak_viewers'),
  recorded: boolean('recorded').notNull().default(false),
  vodStorageKey: text('vod_storage_key'), // S3 key for recorded VOD
  vodUrl: text('vod_url'), // public URL after processing
})

export const streamingSessionsRelations = relations(streamingSessions, ({ one }) => ({
  server: one(streamingServers, {
    fields: [streamingSessions.serverId],
    references: [streamingServers.id],
  }),
}))

// ── Subscriptions (Stripe Billing) ─────────────────────────────────────────

export const subscriptionTierEnum = pgEnum('subscription_tier', [
  'free',
  'creator',
  'pro',
  'studio',
  'enterprise',
])

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'past_due',
  'canceled',
  'trialing',
  'unpaid',
  'incomplete',
])

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  stripePriceId: text('stripe_price_id'),
  tier: subscriptionTierEnum('tier').notNull().default('free'),
  status: subscriptionStatusEnum('status').notNull().default('active'),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, {
    fields: [subscriptions.userId],
    references: [users.id],
  }),
}))

// ── API Keys ────────────────────────────────────────────────────────────────

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(), // SHA-256 hash of the key
  keyPrefix: text('key_prefix').notNull(), // first 8 chars for identification (e.g., "virvi_k1")
  scopes: text('scopes').array(), // ['scenes:read', 'scenes:write', 'media:read', 'media:write']
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
  org: one(organizations, {
    fields: [apiKeys.orgId],
    references: [organizations.id],
  }),
}))

// ── Hyperfy Worlds (self-run, connected with a world key) ───────────────────

export const hyperfyWorlds = pgTable('hyperfy_worlds', {
  id: uuid('id').primaryKey().defaultRandom(),
  sceneId: uuid('scene_id').notNull().references(() => scenes.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('self'),
  keyHash: text('key_hash').notNull().unique(), // SHA-256 hash of the world key
  keyPrefix: text('key_prefix').notNull(), // first 12 chars, for display
  // SHA-256 of VIRVI_WORLD_SECRET (hosted worlds only): proves a vouch comes from the world's own server. Never rotated with the key.
  worldSecretHash: text('world_secret_hash'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Hosted (Fly) worlds only; self-run rows leave these null and stay 'running'
  slug: text('slug'),
  address: text('address'),
  flyApp: text('fly_app'),
  status: text('status').notNull().default('running'), // provisioning | running | failed | ended
  errorMessage: text('error_message'),
  adminCodeEnc: text('admin_code_enc'),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  purgeAfter: timestamp('purge_after', { withTimezone: true }),
  // Reserved: never set. A purge deletes the row; the slug index and slot checks still treat a set value as purged
  purgedAt: timestamp('purged_at', { withTimezone: true }),
  // Set when a sweep starts destroying an ended world; the row (and its slug) stays until the destroy finishes
  purgeClaimedAt: timestamp('purge_claimed_at', { withTimezone: true }),
  // Set once an ended world's machines are confirmed stopped with autostart off; cleared on restore
  quiescedAt: timestamp('quiesced_at', { withTimezone: true }),
}, (t) => ({
  sceneIdx: index('hyperfy_worlds_scene_idx').on(t.sceneId),
  slugUq: uniqueIndex('hyperfy_worlds_slug_uq').on(t.slug).where(sql`${t.purgedAt} IS NULL`),
}))

// ── Hyperfy HUD pairings (a Hyperfy player is paired to a Virvi user, who approves on virvi.io) ──

export const hyperfyPairings = pgTable('hyperfy_pairings', {
  id: uuid('id').primaryKey().defaultRandom(),
  worldId: uuid('world_id').notNull().references(() => hyperfyWorlds.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }), // null until approval
  codeHash: text('code_hash').unique(), // SHA-256 of the pairing code; null once claimed
  secretHash: text('secret_hash'), // SHA-256 of the browser's claim secret; null for hosted (vouched) pairings
  hyperfyPlayerId: text('hyperfy_player_id'), // hosted worlds only
  playerName: text('player_name'),
  status: text('status').notNull().default('pending'), // pending | approved | refused | claimed | revoked
  codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }), // null for hosted pairings (idle-expiry instead)
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index('hyperfy_pairings_user_idx').on(t.userId),
  worldIdx: index('hyperfy_pairings_world_idx').on(t.worldId),
  // Self pairings have a browser secret; hosted ones have a vouched player id. Exactly one.
  kindCheck: check('hyperfy_pairings_kind_check', sql`(${t.secretHash} IS NOT NULL) <> (${t.hyperfyPlayerId} IS NOT NULL)`),
}))

// ── AR spaces ───────────────────────────────────────────────────────────────

export const arSpaces = pgTable('ar_spaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  sceneId: uuid('scene_id').notNull().references(() => scenes.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  place: text('place'), // address or description
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  published: boolean('published').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sceneIdx: index('ar_spaces_scene_idx').on(t.sceneId),
}))

export const arFloors = pgTable('ar_floors', {
  id: uuid('id').primaryKey().defaultRandom(),
  spaceId: uuid('space_id').notNull().references(() => arSpaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  heightM: real('height_m').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => ({
  spaceIdx: index('ar_floors_space_idx').on(t.spaceId),
}))

export const arMarkers = pgTable('ar_markers', {
  id: uuid('id').primaryKey().defaultRandom(),
  floorId: uuid('floor_id').notNull().references(() => arFloors.id, { onDelete: 'cascade' }),
  ringId: bigint('ring_id', { mode: 'number' }).notNull().unique(),
  code: text('code').notNull().unique(),
  diameterMm: real('diameter_mm').notNull().default(140),
  whereText: text('where_text'), // where the ring is, shown to visitors before they arrive
  poseX: real('pose_x'),
  poseY: real('pose_y'),
  poseZ: real('pose_z'),
  headingDeg: real('heading_deg'),
  poseRecordedAt: timestamp('pose_recorded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  floorIdx: index('ar_markers_floor_idx').on(t.floorId),
}))

// A per-space tweak to one scene instance ("Just this place"): the AR feed applies it; the scene itself is untouched.
export const arAdjustments = pgTable('ar_adjustments', {
  id: uuid('id').primaryKey().defaultRandom(),
  spaceId: uuid('space_id').notNull().references(() => arSpaces.id, { onDelete: 'cascade' }),
  instanceId: uuid('instance_id').notNull().references(() => sceneElementInstances.id, { onDelete: 'cascade' }),
  dPosition: jsonb('d_position').$type<Vec3>().notNull(), // metres
  dRotation: jsonb('d_rotation').$type<Vec3>().notNull(), // degrees, per Euler component
  scaleFactor: jsonb('scale_factor').$type<Vec3>().notNull(), // multipliers
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  spaceInstanceUnique: uniqueIndex('ar_adjustments_space_instance_unique').on(t.spaceId, t.instanceId),
}))

// A headset paired to a Virvi user. The headset holds a secret (only its sha256 is stored) and shows a code; the user
// approves the code on the website as personal or shared. Codes and secrets are credentials: never logged.
export const arDevices = pgTable('ar_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }), // the approver; null until approval
  codeHash: text('code_hash').unique(), // SHA-256 of the pairing code; null once claimed
  secretHash: text('secret_hash').notNull(), // SHA-256 of the headset's secret, sent at start
  deviceName: text('device_name'),
  kind: text('kind'), // personal | shared, set on approval
  status: text('status').notNull().default('pending'), // pending | approved | refused | claimed | revoked
  codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }), // set on claim; slides forward on each pass for a personal headset
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index('ar_devices_user_idx').on(t.userId),
}))

// A visitor's report of a published space (Virvi Spaces menu → Report this space). Stores no identity: no IP, no device.
export const arReports = pgTable('ar_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  spaceId: uuid('space_id').notNull().references(() => arSpaces.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(), // offensive | unsafe | spam | other
  platform: text('platform').notNull(), // ar-quest
  status: text('status').notNull().default('open'), // open | resolved
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  statusIdx: index('ar_reports_status_idx').on(t.status, t.createdAt),
}))

// ── Password Reset Tokens ───────────────────────────────────────────────────

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const passwordResetTokensRelations = relations(passwordResetTokens, ({ one }) => ({
  user: one(users, {
    fields: [passwordResetTokens.userId],
    references: [users.id],
  }),
}))

// ── Upload Tokens (Companion Upload Flow) ──────────────────────────────────

export const uploadTokens = pgTable('upload_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(), // short alphanumeric code (e.g. "abc123")
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  sceneId: uuid('scene_id').references(() => scenes.id, { onDelete: 'cascade' }),
  maxUploads: integer('max_uploads').notNull().default(10),
  uploadCount: integer('upload_count').notNull().default(0),
  kinds: text('kinds').array(), // allowed upload kinds ('image' | 'model' | 'video'); null = any
  // The minter's identity at mint time, so uploads re-check their scene access as them
  minterWallet: text('minter_wallet'),
  minterVerified: boolean('minter_verified').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const uploadTokensRelations = relations(uploadTokens, ({ one }) => ({
  user: one(users, {
    fields: [uploadTokens.userId],
    references: [users.id],
  }),
  scene: one(scenes, {
    fields: [uploadTokens.sceneId],
    references: [scenes.id],
  }),
}))

// ── Venues, Bookings & Access Grants ─────────────────────────────────────────

const tstzrange = customType<{ data: string }>({
  dataType() {
    return 'tstzrange'
  },
})

export const venueKindEnum = pgEnum('venue_kind', ['permanent', 'popup'])
export const bookingStatusEnum = pgEnum('booking_status', ['pending', 'confirmed', 'live', 'ended', 'canceled'])
// Must match VENUE_SCOPES / VENUE_ROLES in @virvixr/shared (asserted in test/schema-venues.test.ts)
export const venueScopeEnum = pgEnum('venue_scope', [
  'screens',
  'playlist',
  'lights.cue',
  'lights.faders',
  'schedule',
  'presets',
  'audio',
  'moderation',
  'crew',
])
export const venueRoleEnum = pgEnum('venue_role', ['host', 'cohost', 'vj', 'lighting', 'performer', 'door'])

export const venues = pgTable('venues', {
  id: uuid('id').primaryKey().defaultRandom(),
  sceneId: uuid('scene_id')
    .notNull()
    .unique()
    .references(() => scenes.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  kind: venueKindEnum('kind').notNull().default('permanent'),
  defaultPresetId: uuid('default_preset_id')
    .notNull()
    .references(() => scenePresets.id),
  timezone: text('timezone').notNull().default('UTC'),
  rules: jsonb('rules').$type<VenueRules>().notNull(),
  rentableElementIds: uuid('rentable_element_ids').array().notNull().default(sql`'{}'::uuid[]`),
  isListed: boolean('is_listed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    venueId: uuid('venue_id')
      .notNull()
      .references(() => venues.id, { onDelete: 'cascade' }),
    renterUserId: uuid('renter_user_id').references(() => users.id, { onDelete: 'set null' }),
    renterWallet: text('renter_wallet'),
    title: text('title').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    status: bookingStatusEnum('status').notNull().default('pending'),
    bookingPresetId: uuid('booking_preset_id').references(() => scenePresets.id, { onDelete: 'set null' }),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
    paymentRef: jsonb('payment_ref'),
    blockedRange: tstzrange('blocked_range').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    venueIdx: index('bookings_venue_idx').on(t.venueId),
    statusIdx: index('bookings_status_idx').on(t.status),
    renterPresent: check('bookings_renter_present', sql`${t.renterUserId} IS NOT NULL OR ${t.renterWallet} IS NOT NULL`),
  }),
)

export const accessGrants = pgTable(
  'access_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    sceneId: uuid('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    walletAddress: text('wallet_address'), // lowercased
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    role: venueRoleEnum('role').notNull(),
    scopes: venueScopeEnum('scopes').array().notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    grantedByUserId: uuid('granted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bookingWallet: uniqueIndex('access_grants_booking_wallet_uq').on(t.bookingId, t.walletAddress),
    bookingUser: uniqueIndex('access_grants_booking_user_uq').on(t.bookingId, t.userId),
    sceneWallet: index('access_grants_scene_wallet_idx').on(t.sceneId, t.walletAddress),
    sceneUser: index('access_grants_scene_user_idx').on(t.sceneId, t.userId),
    subjectPresent: check('access_grants_subject_present', sql`${t.walletAddress} IS NOT NULL OR ${t.userId} IS NOT NULL`),
  }),
)

export const sceneRoleEnum = pgEnum('scene_role', ['cohost', 'editor', 'viewer'])
export const setupEndReasonEnum = pgEnum('setup_end_reason', ['redeployed', 'deleted', 'replaced'])

/** Permanent per-scene roles, addressed to a wallet (attached to a user once that wallet signs in). The host is scenes.ownerId, never a row here. */
export const sceneRoles = pgTable(
  'scene_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sceneId: uuid('scene_id').notNull().references(() => scenes.id, { onDelete: 'cascade' }),
    walletAddress: text('wallet_address').notNull(), // lowercased
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    role: sceneRoleEnum('role').notNull(),
    grantedByUserId: uuid('granted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    activeWallet: uniqueIndex('scene_roles_active_wallet_uq').on(t.sceneId, t.walletAddress).where(sql`${t.revokedAt} IS NULL`),
    byWallet: index('scene_roles_wallet_idx').on(t.walletAddress),
    byUser: index('scene_roles_user_idx').on(t.userId),
  }),
)

/** One tenure of a location being set up in Virvi. At most one active (ended_at IS NULL) per location. */
export const locationSetups = pgTable(
  'location_setups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    analyticsSceneId: uuid('analytics_scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
    virviSceneId: uuid('virvi_scene_id').notNull().references(() => scenes.id, { onDelete: 'cascade' }),
    hostUserId: uuid('host_user_id').references(() => users.id, { onDelete: 'set null' }),
    deploymentEntityId: text('deployment_entity_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: setupEndReasonEnum('end_reason'),
  },
  (t) => ({
    oneActive: uniqueIndex('location_setups_one_active_uq').on(t.analyticsSceneId).where(sql`${t.endedAt} IS NULL`),
    byScene: index('location_setups_virvi_scene_idx').on(t.virviSceneId),
  }),
)

export const venuesRelations = relations(venues, ({ one, many }) => ({
  scene: one(scenes, { fields: [venues.sceneId], references: [scenes.id] }),
  bookings: many(bookings),
}))

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  venue: one(venues, { fields: [bookings.venueId], references: [venues.id] }),
  grants: many(accessGrants),
}))

export const accessGrantsRelations = relations(accessGrants, ({ one }) => ({
  booking: one(bookings, { fields: [accessGrants.bookingId], references: [bookings.id] }),
}))

export const walletChallenges = pgTable('wallet_challenges', {
  nonce: text('nonce').primaryKey(),
  address: text('address').notNull(),
  message: text('message').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

/** Single-use in-world sign-in hand-off codes (60 s). Only sha256(code) is stored, never the code. */
export const authHandoffCodes = pgTable('auth_handoff_codes', {
  codeHash: text('code_hash').primaryKey(), // sha256(code) hex; the code itself is never stored
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  wallet: text('wallet').notNull(), // lowercased verified wallet from the HUD's token
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  kind: text('kind').notNull().default('account'), // 'account' | 'scene' — what the exchange issues
  sceneId: uuid('scene_id').references(() => scenes.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').references(() => analyticsScenes.id, { onDelete: 'cascade' }),
  passExpiresAt: timestamp('pass_expires_at', { withTimezone: true }), // scene codes: the minting pass's expiry, kept by the exchanged pass
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Scene Library ────────────────────────────────────────────────────────────
// One shared media library per scene. Items stay in the owner's account (media_assets / asset_library_items) and are linked here.

export const sceneLibrary = pgTable(
  'scene_library',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sceneId: uuid('scene_id').notNull().references(() => scenes.id, { onDelete: 'cascade' }),
    mediaAssetId: uuid('media_asset_id').references(() => mediaAssets.id, { onDelete: 'cascade' }),
    assetItemId: uuid('asset_item_id').references(() => assetLibraryItems.id, { onDelete: 'cascade' }),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneItem: check('scene_library_one_item', sql`(${t.mediaAssetId} IS NULL) <> (${t.assetItemId} IS NULL)`),
    mediaUq: uniqueIndex('scene_library_media_uq').on(t.sceneId, t.mediaAssetId).where(sql`${t.mediaAssetId} IS NOT NULL`),
    assetUq: uniqueIndex('scene_library_asset_uq').on(t.sceneId, t.assetItemId).where(sql`${t.assetItemId} IS NOT NULL`),
    byScene: index('scene_library_scene_idx').on(t.sceneId),
  }),
)

export const sceneLibraryRelations = relations(sceneLibrary, ({ one }) => ({
  scene: one(scenes, { fields: [sceneLibrary.sceneId], references: [scenes.id] }),
  mediaAsset: one(mediaAssets, { fields: [sceneLibrary.mediaAssetId], references: [mediaAssets.id] }),
  assetItem: one(assetLibraryItems, { fields: [sceneLibrary.assetItemId], references: [assetLibraryItems.id] }),
}))

// ── System Flags ─────────────────────────────────────────────────────────────
// Marker rows for one-time startup jobs (claimed atomically so replicas don't both run them).

export const systemFlags = pgTable('system_flags', {
  key: text('key').primaryKey(),
  setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Ads ──────────────────────────────────────────────────────────────────────
// Ad spaces are scene elements (type 'ad_space'); ads are placed on them and measured by adEvents.

export const ads = pgTable('ads', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  kind: text('kind').$type<'house' | 'partner'>().notNull(),
  clickUrl: text('click_url').notNull(),
  status: text('status').$type<'active' | 'paused'>().notNull().default('active'),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  reviewStatus: text('review_status').$type<'pending' | 'approved' | 'rejected'>().notNull().default('pending'),
  audience: text('audience').$type<'family' | 'mature'>(),
  rejectReason: text('reject_reason'),
  reviewerKind: text('reviewer_kind').$type<'human' | 'ai'>(),
  reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
})

export const adCreatives = pgTable('ad_creatives', {
  id: uuid('id').primaryKey().defaultRandom(),
  adId: uuid('ad_id').notNull().references(() => ads.id, { onDelete: 'cascade' }),
  shape: text('shape').notNull(), // '16:9' | '1:1' | '9:16' | '2:5'
  kind: text('kind').$type<'image' | 'video'>().notNull(),
  mediaAssetId: uuid('media_asset_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
  url: text('url').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const adPlacements = pgTable(
  'ad_placements',
  {
    adId: uuid('ad_id').notNull().references(() => ads.id, { onDelete: 'cascade' }),
    elementId: uuid('element_id').notNull().references(() => sceneElements.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.adId, t.elementId] }),
  }),
)

export const adEvents = pgTable(
  'ad_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    adId: uuid('ad_id').notNull().references(() => ads.id, { onDelete: 'cascade' }),
    elementId: uuid('element_id').notNull(),
    sceneId: uuid('scene_id').notNull().references(() => scenes.id, { onDelete: 'cascade' }),
    level: text('level').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    viewerKey: text('viewer_key').notNull(), // 'w:<wallet>' or 'u:<sessionId>'
    verified: boolean('verified').notNull(),
    house: boolean('house').notNull(),
    dwellMs: integer('dwell_ms'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    onePerViewer: uniqueIndex('ad_events_unique_space_view').on(t.adId, t.elementId, t.level, t.day, t.viewerKey),
    byAdDay: index('ad_events_ad_day_idx').on(t.adId, t.day),
  }),
)

/** Append-only log of review decisions; `ads` holds the current state. */
export const adReviews = pgTable(
  'ad_reviews',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    adId: uuid('ad_id').notNull().references(() => ads.id, { onDelete: 'cascade' }),
    decision: text('decision').$type<'approved' | 'rejected' | 'reset'>().notNull(),
    audience: text('audience').$type<'family' | 'mature'>(),
    reason: text('reason'),
    reviewerKind: text('reviewer_kind').$type<'human' | 'ai' | 'system'>().notNull(),
    reviewerId: uuid('reviewer_id'),
    reviewerLabel: text('reviewer_label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byAd: index('ad_reviews_ad_idx').on(t.adId, t.createdAt),
  }),
)

/** Owner content setting per ad space ('family' | 'all' | 'approve'); no row means the default. */
export const adSpaceSettings = pgTable('ad_space_settings', {
  elementId: uuid('element_id').primaryKey().references(() => sceneElements.id, { onDelete: 'cascade' }),
  content: text('content').$type<'family' | 'all' | 'approve'>().notNull(),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** An ad space owner's decision on a specific ad. */
export const adSpaceApprovals = pgTable(
  'ad_space_approvals',
  {
    adId: uuid('ad_id').notNull().references(() => ads.id, { onDelete: 'cascade' }),
    elementId: uuid('element_id').notNull().references(() => sceneElements.id, { onDelete: 'cascade' }),
    decision: text('decision').$type<'approved' | 'declined'>().notNull(),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.adId, t.elementId] }),
  }),
)

/** Advertisers who asked for early access from the landing page. One row per email (lowercased); a resubmit updates it. */
export const advertiserLeads = pgTable('advertiser_leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  company: text('company'),
  website: text('website'),
  message: text('message'),
  consentAt: timestamp('consent_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Room Scan ────────────────────────────────────────────────────────────────
/** A room scan a personal headset uploaded: the normalised layout only (metres, Y up), never images or raw device output. Owner-readable only. */
export const roomScans = pgTable('room_scans', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id'),
  name: text('name').notNull(),
  source: text('source').notNull(), // the first room's anchor.source
  layout: jsonb('layout').$type<RoomScanLayout>().notNull(),
  plot: jsonb('plot').$type<Plot>(), // computed once at upload; null for older rows and homes too big for any plot
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index('room_scans_user_idx').on(t.userId),
}))

/** A generated 3D set built from a scan. Deleting the scan keeps the set (scan_id goes null). */
export const roomSets = pgTable('room_sets', {
  id: uuid('id').primaryKey().defaultRandom(),
  scanId: uuid('scan_id').references(() => roomScans.id, { onDelete: 'set null' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  options: jsonb('options').notNull(),
  nudges: jsonb('nudges').notNull().default({}),
  storageKey: text('storage_key').notNull(),
  glbUrl: text('glb_url').notNull(),
  triangles: integer('triangles').notNull(),
  plot: jsonb('plot').notNull(),
  offset: jsonb('offset').notNull(),
  sceneElementId: uuid('scene_element_id').references(() => sceneElements.id, { onDelete: 'set null' }),
  assetItemId: uuid('asset_item_id').references(() => assetLibraryItems.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  scanIdx: index('room_sets_scan_idx').on(t.scanId),
  elementIdx: index('room_sets_scene_element_idx').on(t.sceneElementId),
}))

// ── Design Studio ────────────────────────────────────────────────────────────
// A design is one conversation that builds wearable pieces (or one emote) through an agent on a Fly worker machine.
// Files never live here: they are in the private studio bucket under designs/<id>/ (src/studio/store.ts).

export const studioDesigns = pgTable('studio_designs', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind').notNull(), // wearable | emote
  agent: text('agent').notNull(), // claude | codex | grok
  status: text('status').notNull().default('idle'), // idle | building
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  lastJobAt: timestamp('last_job_at', { withTimezone: true }),
  machineId: text('machine_id'),
  // Set while one server creates the design's machine, so concurrent prompts create it once (stale after 2 min)
  machineClaimedAt: timestamp('machine_claimed_at', { withTimezone: true }),
  // SHA-256 of the machine's STUDIO_WORKER_TOKEN; the token itself is never stored
  workerTokenHash: text('worker_token_hash').unique(),
  // Set by the first paid finalize: a finalized design no longer counts as open, even while it is revised
  finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ownerIdx: index('studio_designs_owner_idx').on(t.ownerId),
}))

export const studioPieces = pgTable('studio_pieces', {
  id: uuid('id').primaryKey().defaultRandom(),
  designId: uuid('design_id').notNull().references(() => studioDesigns.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  name: text('name').notNull(),
  latestRevisionId: uuid('latest_revision_id'), // no FK: revisions reference pieces
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  categoryUq: uniqueIndex('studio_pieces_design_category_uq').on(t.designId, t.category),
}))

export const studioRevisions = pgTable('studio_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  pieceId: uuid('piece_id').notNull().references(() => studioPieces.id, { onDelete: 'cascade' }),
  number: integer('number').notNull(),
  // The job that made it; the revision log reads the prompt, agent, model, skills SHA and cost from there
  jobId: uuid('job_id').notNull(),
  changeKind: text('change_kind').notNull(),
  meta: jsonb('meta').notNull(),
  checker: jsonb('checker'), // { pass, failures, warnings }
  files: jsonb('files').$type<string[]>().notNull(), // contract paths, under designs/<d>/jobs/<jobId>/
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  numberUq: uniqueIndex('studio_revisions_piece_number_uq').on(t.pieceId, t.number),
}))

export const studioJobs = pgTable('studio_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  designId: uuid('design_id').notNull().references(() => studioDesigns.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // prompt | render
  status: text('status').notNull().default('queued'), // queued | taken | done | failed
  payload: jsonb('payload').notNull(), // the contract's Job, without jobId
  result: jsonb('result'),
  // Whether the prompt used the owner's allowance, and on which UTC day (refunds and cost go to that day)
  counted: boolean('counted').notNull().default(false),
  countedDay: date('counted_day', { mode: 'string' }),
  countedFrom: text('counted_from'), // allowance | gift | credit: where a counted prompt is given back to
  // A render nobody is waiting on (the rest of an Inspect sphere): jobs/next hands these out after the others
  background: boolean('background').notNull().default(false),
  takenAt: timestamp('taken_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  designStatusIdx: index('studio_jobs_design_status_idx').on(t.designId, t.status, t.createdAt),
  // One prompt at a time per design, held by the database
  oneOpenPromptUq: uniqueIndex('studio_jobs_one_open_prompt_uq')
    .on(t.designId)
    .where(sql`${t.type} = 'prompt' AND ${t.status} IN ('queued', 'taken')`),
}))

export const studioMessages = pgTable('studio_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  designId: uuid('design_id').notNull().references(() => studioDesigns.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // user | agent | system
  agent: text('agent'),
  text: text('text').notNull(),
  jobId: uuid('job_id'),
  proposal: jsonb('proposal'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  designIdx: index('studio_messages_design_idx').on(t.designId, t.createdAt),
}))

// Files the owner gives the agent: images (references, textures, logos) and GLBs. Kept at uploadKey(designId, id).
export const studioUploads = pgTable('studio_uploads', {
  id: uuid('id').primaryKey().defaultRandom(),
  designId: uuid('design_id').notNull().references(() => studioDesigns.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), // cleaned, unique within the design; the agent sees it as uploads/<name>
  kind: text('kind').notNull(), // image | model
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  designIdx: index('studio_uploads_design_idx').on(t.designId, t.createdAt),
  nameUq: uniqueIndex('studio_uploads_design_name_uq').on(t.designId, t.name),
}))

// Prompts turned down as off-topic, by the scope check or by the agent (src/studio/scope.ts)
export const studioScopeEvents = pgTable('studio_scope_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  designId: uuid('design_id').references(() => studioDesigns.id, { onDelete: 'set null' }),
  jobId: uuid('job_id'),
  by: text('by').notNull(), // check | agent
  category: text('category').notNull(), // coding | writing | research | chat | other
  note: text('note').notNull(), // the model's own words: for the owner, never shown to the user
  message: text('message').notNull(), // the user's message, first 2,000 characters
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index('studio_scope_events_user_idx').on(t.userId, t.createdAt),
}))

// An account flagged to the owner for repeated turn-downs; at most one open at a time
export const studioFlags = pgTable('studio_flags', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('open'), // open | dismissed
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: uuid('closed_by'),
}, (t) => ({
  openUq: uniqueIndex('studio_flags_open_uq').on(t.userId).where(sql`status = 'open'`),
}))

// An account whose studio access the owner paused: no prompts, designs, renders, uploads or top-ups
export const studioPauses = pgTable('studio_pauses', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  pausedAt: timestamp('paused_at', { withTimezone: true }).notNull().defaultNow(),
  pausedBy: uuid('paused_by'),
})

export const studioRenders = pgTable('studio_renders', {
  id: uuid('id').primaryKey().defaultRandom(),
  revisionId: uuid('revision_id').notNull().references(() => studioRevisions.id, { onDelete: 'cascade' }),
  viewKey: text('view_key').notNull(), // <mode>-<bodyShape>-<outfit>[-<emote>], as the contract names render folders
  jobId: uuid('job_id').notNull(), // frames are stored under this job's files
  frames: integer('frames').notNull().default(0),
  status: text('status').notNull(), // queued | ready | failed
  // An Inspect view showing its ring while the full sphere renders: the job whose frames will replace it
  pendingJobId: uuid('pending_job_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  viewUq: uniqueIndex('studio_renders_revision_view_uq').on(t.revisionId, t.viewKey),
}))

// An emote view with every piece of the design worn: tied to the set of piece revisions it was rendered from
// (`revisions`, their ids sorted and comma-joined), so a change to any piece leaves it behind
export const studioSetRenders = pgTable('studio_set_renders', {
  id: uuid('id').primaryKey().defaultRandom(),
  designId: uuid('design_id').notNull().references(() => studioDesigns.id, { onDelete: 'cascade' }),
  revisions: text('revisions').notNull(),
  viewKey: text('view_key').notNull(), // walk-<bodyShape>-<outfit>-<emote|own>
  jobId: uuid('job_id').notNull(), // frames are stored under this job's files, at renders/set/<viewKey>/
  frames: integer('frames').notNull().default(0),
  fps: doublePrecision('fps'),
  status: text('status').notNull(), // queued | ready | failed
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  viewUq: uniqueIndex('studio_set_renders_view_uq').on(t.designId, t.revisions, t.viewKey),
}))

// What the owner said about an emote on a body shape, for one set of piece revisions
export const studioEmoteChecks = pgTable('studio_emote_checks', {
  id: uuid('id').primaryKey().defaultRandom(),
  designId: uuid('design_id').notNull().references(() => studioDesigns.id, { onDelete: 'cascade' }),
  revisions: text('revisions').notNull(),
  emote: text('emote').notNull(), // a base emote, or own for an emote design
  bodyShape: text('body_shape').notNull(),
  state: text('state').notNull(), // fine | clipping
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  checkUq: uniqueIndex('studio_emote_checks_uq').on(t.designId, t.revisions, t.emote, t.bodyShape),
}))

export const studioUsageDays = pgTable('studio_usage_days', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  day: date('day', { mode: 'string' }).notNull(), // UTC
  prompts: integer('prompts').notNull().default(0),
  costUsd: doublePrecision('cost_usd').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.day] }),
}))

/** One line of a studio checkout: a piece's revision and what it costs (src/studio/pricing.ts). */
export type PaymentLine = {
  category: string
  revisionId: string
  revisionNumber: number
  pieceName: string
  priceKind: 'first' | 'first_extra' | 'revision' | 'revision_extra'
  amountCents: number
  waived: boolean
  gift?: boolean // a first-finalize line paid by a free-finalize credit
  held?: boolean // a mistake report past the instant limit: charged, and its report waits for the owner
  reportText?: string // a waived or held line's mistake report, stored as a report at grant time
}

// A one-time Stripe Checkout: finalizing pieces, or a prompt top-up. Nothing is charged when every line is waived.
export const studioPayments = pgTable('studio_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  designId: uuid('design_id').references(() => studioDesigns.id, { onDelete: 'cascade' }), // null for a top-up
  kind: text('kind').notNull(), // finalize | topup
  status: text('status').notNull().default('pending'), // pending | paid | expired
  amountCents: integer('amount_cents').notNull(),
  lines: jsonb('lines').$type<PaymentLine[]>().notNull().default([]),
  prompts: integer('prompts').notNull().default(0), // a top-up's prompts
  giftsHeld: integer('gifts_held').notNull().default(0), // free-finalize credits held for this checkout's gift lines
  stripeSessionId: text('stripe_session_id').unique(),
  stripeSessionUrl: text('stripe_session_url'),
  stripePaymentIntent: text('stripe_payment_intent'),
  refundedCents: integer('refunded_cents').notNull().default(0),
  // Owed back (a duplicate, or an overcharge found at grant time) until Stripe confirms it; the sweep retries
  refundDueCents: integer('refund_due_cents').notNull().default(0),
  refundAttempts: integer('refund_attempts').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
}, (t) => ({
  userIdx: index('studio_payments_user_idx').on(t.userId, t.createdAt),
}))

// A paid revision: its files can be downloaded as the package the finalize job builds
export const studioEntitlements = pgTable('studio_entitlements', {
  id: uuid('id').primaryKey().defaultRandom(),
  revisionId: uuid('revision_id').notNull().unique().references(() => studioRevisions.id, { onDelete: 'cascade' }),
  paymentId: uuid('payment_id').notNull().references(() => studioPayments.id),
  userId: uuid('user_id').notNull(),
  designId: uuid('design_id').notNull().references(() => studioDesigns.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  kind: text('kind').notNull(), // first | revision
  amountCents: integer('amount_cents').notNull(), // 0 when waived
  status: text('status').notNull(), // packaging | ready | failed
  jobId: uuid('job_id'), // the finalize job
  packageKey: text('package_key'),
  checks: jsonb('checks'), // the finalize job's check summary
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  designIdx: index('studio_entitlements_design_idx').on(t.designId),
}))

// The customer said a paid revision fixed the agent's mistake: refunded (or waived at checkout), never argued
export const studioMistakeReports = pgTable('studio_mistake_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  entitlementId: uuid('entitlement_id').notNull().unique().references(() => studioEntitlements.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  text: text('text').notNull(),
  refundCents: integer('refund_cents').notNull(),
  status: text('status').notNull(), // pending (refund in flight) | refunded | waived | in_review (waits for the owner) | approving (the owner's refund in flight) | declined
  stripeRefundId: text('stripe_refund_id'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedBy: uuid('reviewed_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Bought prompts: used after the day's allowance, never expiring
export const studioPromptCredits = pgTable('studio_prompt_credits', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  balance: integer('balance').notNull().default(0),
  gifted: integer('gifted').notNull().default(0), // prompts from gift codes, spent before purchased ones
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Free first-finalizes from gift codes
export const studioFinalizeCredits = pgTable('studio_finalize_credits', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  balance: integer('balance').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// An admin-made code that gives a user gifted prompts and free first-finalizes; stored hashed
export const studioGiftCodes = pgTable('studio_gift_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  codeHash: text('code_hash').notNull().unique(),
  codeHint: text('code_hint').notNull(), // last 4 characters of the normalized code
  note: text('note'),
  prompts: integer('prompts').notNull(),
  finalizes: integer('finalizes').notNull(),
  maxUses: integer('max_uses').notNull(),
  uses: integer('uses').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const studioGiftRedemptions = pgTable('studio_gift_redemptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  codeId: uuid('code_id').notNull().references(() => studioGiftCodes.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUserUnique: uniqueIndex('studio_gift_redemptions_code_user_idx').on(t.codeId, t.userId),
}))
