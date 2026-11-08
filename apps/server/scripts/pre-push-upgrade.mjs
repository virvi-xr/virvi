// Idempotent schema clean-up that must run before `drizzle-kit push`.
//
// The pre-analytics schema had `analytics_actions` and an `analytics_sessions` table keyed by
// `user_id`. Pushing the new schema over them makes drizzle-kit ask interactively whether
// tables/columns were "created or renamed", which `yes` cannot answer, so boot hangs. Those
// legacy tables never held data, so drop them first and let push create the new ones.
import { randomBytes } from 'node:crypto'
import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) {
  console.log('[virvi-server] pre-push upgrade: DATABASE_URL not set, skipping')
  process.exit(0)
}

const sql = postgres(url, { max: 1, onnotice: () => {} })
try {
  await sql`DROP TABLE IF EXISTS analytics_actions CASCADE`
  await sql`DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'analytics_sessions' AND column_name = 'user_id'
    ) THEN
      DROP TABLE analytics_sessions CASCADE;
    END IF;
  END $$`
  // Key-value scene state was removed; drizzle push alone is unreliable at dropping it
  await sql`DROP TABLE IF EXISTS scene_state`
  // Per-user deploy wallets were replaced by World destinations. Push would ask whether
  // dcl_world_destinations was renamed from it; move it out of push's schema instead, keeping its rows.
  await sql`DO $$ BEGIN
    IF to_regclass('public.deployment_wallets') IS NOT NULL THEN
      CREATE SCHEMA IF NOT EXISTS retired;
      IF to_regclass('retired.deployment_wallets') IS NULL THEN
        ALTER TABLE public.deployment_wallets SET SCHEMA retired;
      END IF;
    END IF;
  END $$`
  // Virvi is now Virvi: rename the scene columns and their indexes before push, so push never asks "renamed or created?"
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'analytics_scenes' AND column_name = 'vlm_scene_id') -- virvi-rename: keep
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'analytics_scenes' AND column_name = 'virvi_scene_id') THEN
      ALTER TABLE analytics_scenes RENAME COLUMN vlm_scene_id TO virvi_scene_id; -- virvi-rename: keep
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'location_setups' AND column_name = 'vlm_scene_id') -- virvi-rename: keep
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'location_setups' AND column_name = 'virvi_scene_id') THEN
      ALTER TABLE location_setups RENAME COLUMN vlm_scene_id TO virvi_scene_id; -- virvi-rename: keep
    END IF;
  END $$`
  await sql`ALTER INDEX IF EXISTS analytics_scenes_vlm_scene_idx RENAME TO analytics_scenes_virvi_scene_idx` // virvi-rename: keep
  await sql`ALTER INDEX IF EXISTS location_setups_vlm_scene_idx RENAME TO location_setups_virvi_scene_idx` // virvi-rename: keep
  // Add streaming_servers.playback_id ahead of push (plain nullable column; push then has nothing to ask)
  await sql`ALTER TABLE IF EXISTS streaming_servers ADD COLUMN IF NOT EXISTS playback_id text`
  // Streams provisioned before playback ids exposed the stream key in their public URL: give them an id and move the URL off the key
  const [{ present }] = await sql`SELECT to_regclass('streaming_servers') IS NOT NULL AS present`
  if (present) {
    const hlsBase = process.env.HLS_BASE_URL || 'http://localhost:8000/streams'
    const legacy = await sql`SELECT id FROM streaming_servers WHERE playback_id IS NULL`
    for (const { id } of legacy) {
      const playbackId = randomBytes(16).toString('hex')
      await sql`UPDATE streaming_servers SET playback_id = ${playbackId}, hls_playlist_url = ${`${hlsBase}/${playbackId}/playlist.m3u8`} WHERE id = ${id} AND playback_id IS NULL`
    }
    if (legacy.length) console.log(`[virvi-server] pre-push upgrade: backfilled playback_id on ${legacy.length} stream(s)`)
  }
  // LIV-85: the heatmap gains a nullable cell_y (floor band), so its (scene_id, day, cell_x, cell_z) primary key becomes a
  // unique index over all five. Done here because push would otherwise ask whether to truncate the table.
  await sql`DO $$ DECLARE pk text; BEGIN
    IF to_regclass('analytics_heatmap_daily') IS NOT NULL THEN
      ALTER TABLE analytics_heatmap_daily ADD COLUMN IF NOT EXISTS cell_y smallint;
      SELECT conname INTO pk FROM pg_constraint WHERE conrelid = 'analytics_heatmap_daily'::regclass AND contype = 'p';
      IF pk IS NOT NULL THEN EXECUTE format('ALTER TABLE analytics_heatmap_daily DROP CONSTRAINT %I', pk); END IF;
      IF to_regclass('analytics_heatmap_daily_cell_uq') IS NULL THEN
        CREATE UNIQUE INDEX analytics_heatmap_daily_cell_uq ON analytics_heatmap_daily (scene_id, day, cell_x, cell_z, cell_y);
      END IF;
    END IF;
  END $$`
  console.log('[virvi-server] pre-push upgrade: legacy analytics tables cleared, scene_state dropped, deployment_wallets retired, vlm_scene_id renamed, playback_id ensured, heatmap cell_y ensured') // virvi-rename: keep
} finally {
  await sql.end()
}
