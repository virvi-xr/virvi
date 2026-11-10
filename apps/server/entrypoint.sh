#!/bin/sh
set -e

# Auto-create/update database tables on first boot
if [ -n "$DATABASE_URL" ]; then
  echo "[virvi-server] Running drizzle-kit push to sync schema..."
  cd /app/apps/server
  # Drop the legacy (never-populated) analytics tables first, or push stops at a rename prompt.
  node scripts/pre-push-upgrade.mjs 2>&1 || echo "[virvi-server] pre-push upgrade SQL failed"
  yes | npx drizzle-kit push 2>&1 || echo "[virvi-server] drizzle-kit push failed, trying raw SQL fallback..."

  # Fallback: ensure critical columns exist even if drizzle-kit push fails
  echo "[virvi-server] Ensuring critical schema columns exist..."
  node -e "
    const postgres = require('postgres');
    const sql = postgres(process.env.DATABASE_URL);
    (async () => {
      // Enums
      try {
        await sql\`DO \$\$ BEGIN CREATE TYPE org_role AS ENUM ('owner','admin','member'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$\`;
        await sql\`DO \$\$ BEGIN CREATE TYPE invite_status AS ENUM ('pending','accepted','declined','expired'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$\`;
        console.log('[virvi-server] enums ensured');
      } catch(e) { console.log('[virvi-server] enums:', e.message); }

      // Organizations table
      try {
        await sql\`CREATE TABLE IF NOT EXISTS organizations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, billing_owner_id UUID, logo_url TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())\`;
        console.log('[virvi-server] organizations table ensured');
      } catch(e) { console.log('[virvi-server] organizations:', e.message); }

      // streaming_servers.scene_id: deleting a scene unlinks its streaming server (was no action, so the delete failed)
      try {
        await sql\`DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'streaming_servers_scene_id_scenes_id_fk' AND confdeltype <> 'n') THEN ALTER TABLE streaming_servers DROP CONSTRAINT streaming_servers_scene_id_scenes_id_fk; ALTER TABLE streaming_servers ADD CONSTRAINT streaming_servers_scene_id_scenes_id_fk FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE SET NULL; END IF; END \$\$\`;
      } catch(e) { console.log('[virvi-server] streaming_servers scene fk:', e.message); }

      // trial account columns on users
      for (const def of ['is_trial BOOLEAN NOT NULL DEFAULT false', 'trial_last_active_at TIMESTAMPTZ', 'trial_ip_hash TEXT', 'trial_device_hash TEXT', 'trial_imports INTEGER NOT NULL DEFAULT 0']) {
        try {
          await sql.unsafe(\`ALTER TABLE users ADD COLUMN IF NOT EXISTS \${def}\`);
        } catch(e) { console.log('[virvi-server] users trial column:', e.message); }
      }
      try {
        await sql\`CREATE INDEX IF NOT EXISTS users_trial_idle_idx ON users (trial_last_active_at, id) WHERE is_trial\`;
      } catch(e) { console.log('[virvi-server] users trial index:', e.message); }

      // org_id columns on all data tables
      const orgIdTables = ['users', 'scenes', 'media_assets', 'events', 'giveaways', 'subscriptions', 'streaming_servers'];
      for (const table of orgIdTables) {
        const col = table === 'users' ? 'active_org_id' : 'org_id';
        try {
          await sql.unsafe(\`ALTER TABLE \${table} ADD COLUMN IF NOT EXISTS \${col} UUID\`);
          console.log('[virvi-server] ' + col + ' on ' + table + ' ensured');
        } catch(e) { console.log('[virvi-server] ' + table + '.' + col + ':', e.message); }
      }

      // Other new tables
      try {
        await sql\`CREATE TABLE IF NOT EXISTS org_members (org_id UUID NOT NULL, user_id UUID NOT NULL, role org_role NOT NULL DEFAULT 'member', joined_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (org_id, user_id))\`;
        await sql\`CREATE TABLE IF NOT EXISTS org_invites (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, email TEXT NOT NULL, role org_role NOT NULL DEFAULT 'member', invited_by UUID NOT NULL, status invite_status NOT NULL DEFAULT 'pending', token TEXT UNIQUE NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())\`;
        await sql\`CREATE TABLE IF NOT EXISTS api_keys (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, org_id UUID, name TEXT NOT NULL, key_hash TEXT NOT NULL, key_prefix TEXT NOT NULL, scopes TEXT[], last_used_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())\`;
        await sql\`CREATE TABLE IF NOT EXISTS password_reset_tokens (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, token TEXT UNIQUE NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())\`;
        console.log('[virvi-server] new tables ensured');
      } catch(e) { console.log('[virvi-server] new tables:', e.message); }

      // Hand-off codes (HUD Stats tab sign-in); matches authHandoffCodes in src/db/schema.ts
      try {
        await sql\`CREATE TABLE IF NOT EXISTS auth_handoff_codes (code_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, wallet TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`ALTER TABLE auth_handoff_codes ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'account'\`;
        await sql\`ALTER TABLE auth_handoff_codes ADD COLUMN IF NOT EXISTS scene_id UUID REFERENCES scenes(id) ON DELETE CASCADE\`;
        await sql\`ALTER TABLE auth_handoff_codes ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES analytics_scenes(id) ON DELETE CASCADE\`;
        await sql\`ALTER TABLE auth_handoff_codes ADD COLUMN IF NOT EXISTS pass_expires_at TIMESTAMPTZ\`;
        console.log('[virvi-server] auth_handoff_codes table ensured');
      } catch(e) { console.log('[virvi-server] auth_handoff_codes:', e.message); }

      // Per-scene media library; matches sceneLibrary in src/db/schema.ts
      try {
        await sql\`CREATE TABLE IF NOT EXISTS scene_library (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), scene_id UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE, media_asset_id UUID REFERENCES media_assets(id) ON DELETE CASCADE, asset_item_id UUID REFERENCES asset_library_items(id) ON DELETE CASCADE, added_by UUID REFERENCES users(id) ON DELETE SET NULL, booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CONSTRAINT scene_library_one_item CHECK ((media_asset_id IS NULL) <> (asset_item_id IS NULL)))\`;
        await sql\`CREATE UNIQUE INDEX IF NOT EXISTS scene_library_media_uq ON scene_library (scene_id, media_asset_id) WHERE media_asset_id IS NOT NULL\`;
        await sql\`CREATE UNIQUE INDEX IF NOT EXISTS scene_library_asset_uq ON scene_library (scene_id, asset_item_id) WHERE asset_item_id IS NOT NULL\`;
        await sql\`CREATE INDEX IF NOT EXISTS scene_library_scene_idx ON scene_library (scene_id)\`;
        console.log('[virvi-server] scene_library table ensured');
      } catch(e) { console.log('[virvi-server] scene_library:', e.message); }

      // Catalog packs; matches catalogPacks / assetLibraryItems in src/db/schema.ts
      try {
        await sql\`CREATE TABLE IF NOT EXISTS catalog_packs (id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, license TEXT NOT NULL, attribution TEXT NOT NULL, source_url TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`ALTER TABLE asset_library_items ADD COLUMN IF NOT EXISTS pack_id TEXT REFERENCES catalog_packs(id) ON DELETE RESTRICT\`;
        await sql\`ALTER TABLE asset_library_items ADD COLUMN IF NOT EXISTS style TEXT\`;
        await sql\`ALTER TABLE asset_library_items ADD COLUMN IF NOT EXISTS venue_tags TEXT[]\`;
        await sql\`ALTER TABLE asset_library_items ADD COLUMN IF NOT EXISTS source_ref TEXT\`;
        await sql\`ALTER TABLE asset_library_items ADD COLUMN IF NOT EXISTS content_hash TEXT\`;
        await sql\`CREATE UNIQUE INDEX IF NOT EXISTS asset_library_items_pack_ref ON asset_library_items (pack_id, source_ref)\`;
        await sql\`CREATE INDEX IF NOT EXISTS asset_library_items_content_hash_idx ON asset_library_items (content_hash)\`;
        console.log('[virvi-server] catalog packs ensured');
      } catch(e) { console.log('[virvi-server] catalog packs:', e.message); }

      // Scene imports; matches sceneImportStatusEnum / dclDestinationKindEnum / sceneImports and dclWorldDestinations'
      // pendingImportId, kind, nullable world_name and parcels base index in src/db/schema.ts.
      // markFailed and afterWorldDeploy touch scene_imports on every World deploy, so it must exist.
      try {
        await sql\`DO \$\$ BEGIN CREATE TYPE dcl_destination_kind AS ENUM ('world','parcels'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$\`;
        await sql\`DO \$\$ BEGIN CREATE TYPE scene_import_status AS ENUM ('uploaded','building','built','deploying','awaiting_signature','deployed','failed'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$\`;
        await sql\`CREATE TABLE IF NOT EXISTS scene_imports (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, scene_id UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE, world_name TEXT NOT NULL, kind TEXT NOT NULL, status scene_import_status NOT NULL DEFAULT 'uploaded', error_code TEXT, error_message TEXT, source_key TEXT NOT NULL, built_key_prefix TEXT, log_key TEXT, build_token_hash TEXT, machine_id TEXT, destination_id UUID REFERENCES dcl_world_destinations(id) ON DELETE SET NULL, deployment_id UUID REFERENCES scene_deployments(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), built_at TIMESTAMPTZ, finished_at TIMESTAMPTZ)\`;
        await sql\`ALTER TABLE scene_imports ADD COLUMN IF NOT EXISTS files_deleted_at TIMESTAMPTZ\`;
        await sql\`ALTER TABLE scene_imports ADD COLUMN IF NOT EXISTS original_key TEXT\`;
        await sql\`ALTER TABLE scene_imports ADD COLUMN IF NOT EXISTS virvi_already_present BOOLEAN NOT NULL DEFAULT FALSE\`;
        await sql\`ALTER TABLE scene_imports ADD COLUMN IF NOT EXISTS thumbnail_outcome TEXT, ADD COLUMN IF NOT EXISTS thumbnail_note TEXT\`;
        await sql\`ALTER TABLE scene_imports ADD COLUMN IF NOT EXISTS navmap_thumbnail TEXT\`;
        await sql\`ALTER TABLE scene_imports ADD COLUMN IF NOT EXISTS sandbox BOOLEAN NOT NULL DEFAULT FALSE\`;
        await sql\`ALTER TABLE scene_imports ALTER COLUMN world_name DROP NOT NULL\`;
        await sql\`ALTER TABLE scene_imports ADD COLUMN IF NOT EXISTS location_kind dcl_destination_kind NOT NULL DEFAULT 'world', ADD COLUMN IF NOT EXISTS base TEXT, ADD COLUMN IF NOT EXISTS parcels TEXT[] NOT NULL DEFAULT '{}'::text[]\`;
        await sql\`CREATE INDEX IF NOT EXISTS scene_imports_world_status_idx ON scene_imports (world_name, status)\`;
        await sql\`CREATE INDEX IF NOT EXISTS scene_imports_user_created_idx ON scene_imports (user_id, created_at)\`;
        await sql\`ALTER TABLE dcl_world_destinations ADD COLUMN IF NOT EXISTS pending_import_id UUID REFERENCES scene_imports(id) ON DELETE SET NULL\`;
        await sql\`ALTER TABLE dcl_world_destinations ADD COLUMN IF NOT EXISTS kind dcl_destination_kind NOT NULL DEFAULT 'world'\`;
        await sql\`ALTER TABLE dcl_world_destinations ALTER COLUMN world_name DROP NOT NULL\`;
        await sql\`CREATE UNIQUE INDEX IF NOT EXISTS dcl_destinations_parcels_base ON dcl_world_destinations (base) WHERE kind = 'parcels'\`;
        console.log('[virvi-server] scene_imports ensured');
      } catch(e) { console.log('[virvi-server] scene_imports:', e.message); }

      // LIV-135 map data (abgen Initial Scene State) per destination; matches dclWorldDestinations.map* in src/db/schema.ts
      try {
        await sql\`ALTER TABLE dcl_world_destinations ADD COLUMN IF NOT EXISTS map_status TEXT NOT NULL DEFAULT 'unknown', ADD COLUMN IF NOT EXISTS map_entity_id TEXT, ADD COLUMN IF NOT EXISTS map_assets INTEGER, ADD COLUMN IF NOT EXISTS map_since TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS map_check_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS map_checked_at TIMESTAMPTZ\`;
        await sql\`CREATE INDEX IF NOT EXISTS dcl_destinations_map_due ON dcl_world_destinations (map_check_at) WHERE map_status = 'pending'\`;
        console.log('[virvi-server] dcl_world_destinations map columns ensured');
      } catch(e) { console.log('[virvi-server] dcl_world_destinations map columns:', e.message); }

      // Hyperfy worlds; matches hyperfyWorlds in src/db/schema.ts
      try {
        await sql\`CREATE TABLE IF NOT EXISTS hyperfy_worlds (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), scene_id UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE, owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'self', key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL, last_seen_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE INDEX IF NOT EXISTS hyperfy_worlds_scene_idx ON hyperfy_worlds (scene_id)\`;
        await sql\`ALTER TABLE hyperfy_worlds ADD COLUMN IF NOT EXISTS slug TEXT, ADD COLUMN IF NOT EXISTS address TEXT, ADD COLUMN IF NOT EXISTS fly_app TEXT, ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'running', ADD COLUMN IF NOT EXISTS error_message TEXT, ADD COLUMN IF NOT EXISTS admin_code_enc TEXT, ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS purge_claimed_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS quiesced_at TIMESTAMPTZ\`;
        await sql\`ALTER TABLE hyperfy_worlds ADD COLUMN IF NOT EXISTS world_secret_hash TEXT\`;
        await sql\`CREATE UNIQUE INDEX IF NOT EXISTS hyperfy_worlds_slug_uq ON hyperfy_worlds (slug) WHERE purged_at IS NULL\`;
        console.log('[virvi-server] hyperfy worlds ensured');
      } catch(e) { console.log('[virvi-server] hyperfy worlds:', e.message); }
      // Ads; matches ads / adCreatives / adPlacements / adEvents / adReviews / adSpaceSettings / adSpaceApprovals in src/db/schema.ts
      try {
        await sql\`ALTER TYPE element_type ADD VALUE IF NOT EXISTS 'ad_space'\`;
        await sql\`CREATE TABLE IF NOT EXISTS ads (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, kind TEXT NOT NULL, click_url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE TABLE IF NOT EXISTS ad_creatives (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ad_id UUID NOT NULL REFERENCES ads(id) ON DELETE CASCADE, shape TEXT NOT NULL, kind TEXT NOT NULL, media_asset_id UUID REFERENCES media_assets(id) ON DELETE SET NULL, url TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE TABLE IF NOT EXISTS ad_placements (ad_id UUID NOT NULL REFERENCES ads(id) ON DELETE CASCADE, element_id UUID NOT NULL REFERENCES scene_elements(id) ON DELETE CASCADE, PRIMARY KEY (ad_id, element_id))\`;
        await sql\`CREATE TABLE IF NOT EXISTS ad_events (id BIGSERIAL PRIMARY KEY, ad_id UUID NOT NULL REFERENCES ads(id) ON DELETE CASCADE, element_id UUID NOT NULL, scene_id UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE, level TEXT NOT NULL, day DATE NOT NULL, viewer_key TEXT NOT NULL, verified BOOLEAN NOT NULL, house BOOLEAN NOT NULL, dwell_ms INTEGER, occurred_at TIMESTAMPTZ NOT NULL)\`;
        await sql\`DROP INDEX IF EXISTS ad_events_unique_view\`;
        await sql\`CREATE UNIQUE INDEX IF NOT EXISTS ad_events_unique_space_view ON ad_events (ad_id, element_id, level, day, viewer_key)\`;
        await sql\`CREATE INDEX IF NOT EXISTS ad_events_ad_day_idx ON ad_events (ad_id, day)\`;
        await sql\`ALTER TABLE ads ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending'\`;
        await sql\`ALTER TABLE ads ADD COLUMN IF NOT EXISTS audience TEXT\`;
        await sql\`ALTER TABLE ads ADD COLUMN IF NOT EXISTS reject_reason TEXT\`;
        await sql\`ALTER TABLE ads ADD COLUMN IF NOT EXISTS reviewer_kind TEXT\`;
        await sql\`ALTER TABLE ads ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL\`;
        await sql\`ALTER TABLE ads ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ\`;
        await sql\`CREATE TABLE IF NOT EXISTS ad_reviews (id BIGSERIAL PRIMARY KEY, ad_id UUID NOT NULL REFERENCES ads(id) ON DELETE CASCADE, decision TEXT NOT NULL, audience TEXT, reason TEXT, reviewer_kind TEXT NOT NULL, reviewer_id UUID, reviewer_label TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE INDEX IF NOT EXISTS ad_reviews_ad_idx ON ad_reviews (ad_id, created_at)\`;
        await sql\`CREATE TABLE IF NOT EXISTS ad_space_settings (element_id UUID PRIMARY KEY REFERENCES scene_elements(id) ON DELETE CASCADE, content TEXT NOT NULL, updated_by UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE TABLE IF NOT EXISTS ad_space_approvals (ad_id UUID NOT NULL REFERENCES ads(id) ON DELETE CASCADE, element_id UUID NOT NULL REFERENCES scene_elements(id) ON DELETE CASCADE, decision TEXT NOT NULL, decided_by UUID, decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (ad_id, element_id))\`;
        console.log('[virvi-server] ads ensured');
      } catch(e) { console.log('[virvi-server] ads:', e.message); }

      // Upload status (two-step companion uploads); matches mediaAssets / uploadTokens in src/db/schema.ts
      try {
        await sql\`ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ready'\`;
        await sql\`ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS error TEXT\`;
        await sql\`ALTER TABLE media_assets ALTER COLUMN storage_key DROP NOT NULL\`;
        await sql\`ALTER TABLE upload_tokens ADD COLUMN IF NOT EXISTS kinds TEXT[]\`;
        await sql\`ALTER TABLE upload_tokens ADD COLUMN IF NOT EXISTS minter_wallet TEXT\`;
        await sql\`ALTER TABLE upload_tokens ADD COLUMN IF NOT EXISTS minter_verified BOOLEAN NOT NULL DEFAULT false\`;
        console.log('[virvi-server] media status columns ensured');
      } catch(e) { console.log('[virvi-server] media status columns:', e.message); }

      // One-time startup job markers; matches systemFlags in src/db/schema.ts
      try {
        await sql\`CREATE TABLE IF NOT EXISTS system_flags (key TEXT PRIMARY KEY, set_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        console.log('[virvi-server] system_flags table ensured');
      } catch(e) { console.log('[virvi-server] system_flags:', e.message); }

      // Advertiser early-access list; matches advertiserLeads in src/db/schema.ts
      try {
        await sql\`CREATE TABLE IF NOT EXISTS advertiser_leads (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT NOT NULL UNIQUE, name TEXT, company TEXT, website TEXT, message TEXT, consent_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        console.log('[virvi-server] advertiser_leads table ensured');
      } catch(e) { console.log('[virvi-server] advertiser_leads:', e.message); }

      // Room scans and the sets built from them; matches roomScans / roomSets in src/db/schema.ts
      try {
        await sql\`CREATE TABLE IF NOT EXISTS room_scans (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, org_id UUID, name TEXT NOT NULL, source TEXT NOT NULL, layout JSONB NOT NULL, captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE INDEX IF NOT EXISTS room_scans_user_idx ON room_scans (user_id)\`;
        await sql\`ALTER TABLE room_scans ADD COLUMN IF NOT EXISTS plot JSONB\`;
        await sql\`CREATE TABLE IF NOT EXISTS room_sets (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), scan_id UUID REFERENCES room_scans(id) ON DELETE SET NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, options JSONB NOT NULL, nudges JSONB NOT NULL DEFAULT '{}'::jsonb, storage_key TEXT NOT NULL, glb_url TEXT NOT NULL, triangles INTEGER NOT NULL, plot JSONB NOT NULL, \"offset\" JSONB NOT NULL, scene_element_id UUID REFERENCES scene_elements(id) ON DELETE SET NULL, asset_item_id UUID REFERENCES asset_library_items(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE INDEX IF NOT EXISTS room_sets_scan_idx ON room_sets (scan_id)\`;
        await sql\`CREATE INDEX IF NOT EXISTS room_sets_scene_element_idx ON room_sets (scene_element_id)\`;
        console.log('[virvi-server] room_scans / room_sets tables ensured');
      } catch(e) { console.log('[virvi-server] room_scans / room_sets:', e.message); }

      // Design Studio scene pieces in the asset library; matches assetLibraryItems.sittables and studioEntitlements.assetItemIds
      try {
        await sql\`ALTER TABLE asset_library_items ADD COLUMN IF NOT EXISTS sittables JSONB\`;
        await sql\`ALTER TABLE asset_library_items ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ready'\`;
        await sql\`ALTER TABLE asset_library_items ADD COLUMN IF NOT EXISTS error TEXT\`;
        await sql\`ALTER TABLE asset_library_items ADD COLUMN IF NOT EXISTS upload_code TEXT\`;
        await sql\`ALTER TABLE studio_entitlements ADD COLUMN IF NOT EXISTS asset_item_ids JSONB\`;
        console.log('[virvi-server] scene library columns ensured');
      } catch(e) { console.log('[virvi-server] scene library columns:', e.message); }

      // uploaded_by: deleting an account leaves its public models ownerless (was no action, so the delete failed)
      try {
        await sql\`DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_library_items_uploaded_by_users_id_fk' AND confdeltype <> 'n') THEN ALTER TABLE asset_library_items DROP CONSTRAINT asset_library_items_uploaded_by_users_id_fk; ALTER TABLE asset_library_items ADD CONSTRAINT asset_library_items_uploaded_by_users_id_fk FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL; END IF; END \$\$\`;
        console.log('[virvi-server] asset_library_items.uploaded_by is ON DELETE SET NULL');
      } catch(e) { console.log('[virvi-server] asset_library_items.uploaded_by:', e.message); }

      // Signed-out trial funnel; matches trialEvents in src/db/schema.ts (user_id is deliberately not a foreign key)
      try {
        await sql\`CREATE TABLE IF NOT EXISTS trial_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID, kind TEXT NOT NULL, action TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE INDEX IF NOT EXISTS trial_events_user_kind_idx ON trial_events (user_id, kind)\`;
        await sql\`CREATE UNIQUE INDEX IF NOT EXISTS trial_events_blocked_uq ON trial_events (user_id) WHERE kind = 'blocked'\`;
        console.log('[virvi-server] trial_events ensured');
      } catch(e) { console.log('[virvi-server] trial_events:', e.message); }

      // Studio gift codes; matches studioGiftCodes / studioGiftRedemptions / studioFinalizeCredits in src/db/schema.ts
      try {
        await sql\`CREATE TABLE IF NOT EXISTS studio_trial_spend_days (day DATE PRIMARY KEY, cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0)\`;
        await sql\`CREATE TABLE IF NOT EXISTS studio_gift_codes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code_hash TEXT NOT NULL UNIQUE, code_hint TEXT NOT NULL, note TEXT, prompts INTEGER NOT NULL, finalizes INTEGER NOT NULL, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, expires_at TIMESTAMPTZ, disabled_at TIMESTAMPTZ, created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE TABLE IF NOT EXISTS studio_gift_redemptions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code_id UUID NOT NULL REFERENCES studio_gift_codes(id) ON DELETE CASCADE, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE UNIQUE INDEX IF NOT EXISTS studio_gift_redemptions_code_user_idx ON studio_gift_redemptions (code_id, user_id)\`;
        await sql\`CREATE TABLE IF NOT EXISTS studio_finalize_credits (user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, balance INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        console.log('[virvi-server] studio gift code tables ensured');
      } catch(e) { console.log('[virvi-server] studio gift codes:', e.message); }
      // Gift columns on existing tables, each on its own so a failure above can't skip them (usage reads both)
      try {
        await sql\`ALTER TABLE studio_prompt_credits ADD COLUMN IF NOT EXISTS gifted INTEGER NOT NULL DEFAULT 0\`;
        console.log('[virvi-server] studio_prompt_credits.gifted ensured');
      } catch(e) { console.log('[virvi-server] studio_prompt_credits.gifted:', e.message); }
      try {
        await sql\`ALTER TABLE studio_payments ADD COLUMN IF NOT EXISTS gifts_held INTEGER NOT NULL DEFAULT 0\`;
        console.log('[virvi-server] studio_payments.gifts_held ensured');
      } catch(e) { console.log('[virvi-server] studio_payments.gifts_held:', e.message); }

      // Scene thumbnail (LIV-88): matches scenes.thumbnailKey and scenes.thumbnailBytes in src/db/schema.ts
      try {
        await sql\`ALTER TABLE scenes ADD COLUMN IF NOT EXISTS thumbnail_key TEXT\`;
        await sql\`ALTER TABLE scenes ADD COLUMN IF NOT EXISTS thumbnail_bytes INTEGER\`;
        // LIV-89: where the thumbnail came from; every thumbnail from before it was recorded was uploaded in Virvi
        await sql\`ALTER TABLE scenes ADD COLUMN IF NOT EXISTS thumbnail_source TEXT\`;
        await sql\`UPDATE scenes SET thumbnail_source = 'upload' WHERE thumbnail_key IS NOT NULL AND thumbnail_source IS NULL\`;
        console.log('[virvi-server] scenes thumbnail columns ensured');
      } catch(e) { console.log('[virvi-server] scenes thumbnail columns:', e.message); }

      // Design Studio credit and MANA: new columns; matches studioPayments, studioEntitlements and studioMistakeReports in src/db/schema.ts
      try {
        await sql\`ALTER TABLE studio_payments ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'card'\`;
        await sql\`ALTER TABLE studio_payments ADD COLUMN IF NOT EXISTS credit_held_cents INTEGER NOT NULL DEFAULT 0\`;
        await sql\`ALTER TABLE studio_payments ADD COLUMN IF NOT EXISTS mana_amount_wei TEXT\`;
        await sql\`ALTER TABLE studio_payments ADD COLUMN IF NOT EXISTS mana_usd_rate TEXT\`;
        await sql\`ALTER TABLE studio_payments ADD COLUMN IF NOT EXISTS mana_tx_hash TEXT\`;
        await sql\`DO \$\$ BEGIN ALTER TABLE studio_payments ADD CONSTRAINT studio_payments_mana_tx_hash_unique UNIQUE (mana_tx_hash); EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END \$\$\`;
        await sql\`CREATE UNIQUE INDEX IF NOT EXISTS studio_payments_mana_open_idx ON studio_payments (mana_amount_wei) WHERE status = 'pending'\`;
        await sql\`ALTER TABLE studio_entitlements ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'card'\`;
        await sql\`ALTER TABLE studio_entitlements ADD COLUMN IF NOT EXISTS credit_cents INTEGER NOT NULL DEFAULT 0\`;
        await sql\`ALTER TABLE studio_mistake_reports ADD COLUMN IF NOT EXISTS credited_cents INTEGER NOT NULL DEFAULT 0\`;
        await sql\`ALTER TABLE studio_mistake_reports ADD COLUMN IF NOT EXISTS mana_cents INTEGER NOT NULL DEFAULT 0\`;
        console.log('[virvi-server] studio credit and MANA columns ensured');
      } catch(e) { console.log('[virvi-server] studio credit and MANA columns:', e.message); }
      // Design Studio credit and MANA: new tables; matches studioCredits, studioCreditLedger, studioManaTransfers, studioManaScan and studioManaRefunds
      try {
        await sql\`CREATE TABLE IF NOT EXISTS studio_credits (user_id UUID PRIMARY KEY CONSTRAINT studio_credits_user_id_users_id_fk REFERENCES users(id) ON DELETE CASCADE, balance_cents INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE TABLE IF NOT EXISTS studio_credit_ledger (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL CONSTRAINT studio_credit_ledger_user_id_users_id_fk REFERENCES users(id) ON DELETE CASCADE, delta_cents INTEGER NOT NULL, reason TEXT NOT NULL, ref_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE INDEX IF NOT EXISTS studio_credit_ledger_user_idx ON studio_credit_ledger (user_id, created_at)\`;
        await sql\`CREATE TABLE IF NOT EXISTS studio_mana_transfers (tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, from_address TEXT NOT NULL, amount_wei TEXT NOT NULL, block_number BIGINT NOT NULL, payment_id UUID CONSTRAINT studio_mana_transfers_payment_id_studio_payments_id_fk REFERENCES studio_payments(id) ON DELETE SET NULL, status TEXT NOT NULL, note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CONSTRAINT studio_mana_transfers_tx_hash_log_index_pk PRIMARY KEY (tx_hash, log_index))\`;
        await sql\`CREATE TABLE IF NOT EXISTS studio_mana_scan (id TEXT PRIMARY KEY, last_block BIGINT NOT NULL)\`;
        await sql\`CREATE TABLE IF NOT EXISTS studio_mana_refunds (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL CONSTRAINT studio_mana_refunds_user_id_users_id_fk REFERENCES users(id) ON DELETE CASCADE, report_id UUID CONSTRAINT studio_mana_refunds_report_id_studio_mistake_reports_id_fk REFERENCES studio_mistake_reports(id) ON DELETE SET NULL, usd_cents INTEGER NOT NULL, to_address TEXT NOT NULL, status TEXT NOT NULL, mana_amount_wei TEXT, tx_hash TEXT CONSTRAINT studio_mana_refunds_tx_hash_unique UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), decided_at TIMESTAMPTZ, decided_by UUID)\`;
        console.log('[virvi-server] studio credit and MANA tables ensured');
      } catch(e) { console.log('[virvi-server] studio credit and MANA tables:', e.message); }
      // Design Studio credit and MANA: a transfer and a MANA-back request outlive their payment and report (ON DELETE SET NULL)
      try {
        await sql\`DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'studio_mana_transfers_payment_id_studio_payments_id_fk' AND conrelid = 'studio_mana_transfers'::regclass AND confdeltype <> 'n') THEN ALTER TABLE studio_mana_transfers DROP CONSTRAINT studio_mana_transfers_payment_id_studio_payments_id_fk; ALTER TABLE studio_mana_transfers ADD CONSTRAINT studio_mana_transfers_payment_id_studio_payments_id_fk FOREIGN KEY (payment_id) REFERENCES studio_payments(id) ON DELETE SET NULL; END IF; END \$\$\`;
        await sql\`DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'studio_mana_refunds_report_id_studio_mistake_reports_id_fk' AND conrelid = 'studio_mana_refunds'::regclass AND confdeltype <> 'n') THEN ALTER TABLE studio_mana_refunds DROP CONSTRAINT studio_mana_refunds_report_id_studio_mistake_reports_id_fk; ALTER TABLE studio_mana_refunds ADD CONSTRAINT studio_mana_refunds_report_id_studio_mistake_reports_id_fk FOREIGN KEY (report_id) REFERENCES studio_mistake_reports(id) ON DELETE SET NULL; END IF; END \$\$\`;
        console.log('[virvi-server] studio MANA foreign keys ensured');
      } catch(e) { console.log('[virvi-server] studio MANA foreign keys:', e.message); }

      // Design Studio admin help: who in Virvi support sent a prompt or granted a finalize; matches studioJobs, studioMessages and studioPayments in src/db/schema.ts
      try {
        await sql\`ALTER TABLE studio_jobs ADD COLUMN IF NOT EXISTS by_admin_id UUID\`;
        await sql\`ALTER TABLE studio_messages ADD COLUMN IF NOT EXISTS by_admin_id UUID\`;
        await sql\`ALTER TABLE studio_payments ADD COLUMN IF NOT EXISTS by_admin_id UUID\`;
        console.log('[virvi-server] studio admin help columns ensured');
      } catch(e) { console.log('[virvi-server] studio admin help columns:', e.message); }

      // Design Studio ratings and lessons (LIV-142); matches studioRatings, studioLessons, studioDigestWeeks, studioKindDefaults and studioJobs.feedbackFor in src/db/schema.ts
      try {
        await sql\`ALTER TABLE studio_jobs ADD COLUMN IF NOT EXISTS feedback_for UUID\`;
        await sql\`CREATE UNIQUE INDEX IF NOT EXISTS studio_jobs_feedback_for_uq ON studio_jobs (feedback_for) WHERE feedback_for IS NOT NULL\`;
        await sql\`CREATE TABLE IF NOT EXISTS studio_ratings (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), job_id UUID NOT NULL CONSTRAINT studio_ratings_job_id_studio_jobs_id_fk REFERENCES studio_jobs(id) ON DELETE CASCADE, design_id UUID NOT NULL CONSTRAINT studio_ratings_design_id_studio_designs_id_fk REFERENCES studio_designs(id) ON DELETE CASCADE, user_id UUID NOT NULL CONSTRAINT studio_ratings_user_id_users_id_fk REFERENCES users(id) ON DELETE CASCADE, rating TEXT NOT NULL, tags JSONB NOT NULL DEFAULT '[]'::jsonb, note TEXT, kind TEXT NOT NULL, agent TEXT, model TEXT, prompt TEXT, cost_usd DOUBLE PRECISION, handled_at TIMESTAMPTZ, handled_by UUID, auto_check BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE UNIQUE INDEX IF NOT EXISTS studio_ratings_job_user_uq ON studio_ratings (job_id, user_id)\`;
        await sql\`CREATE INDEX IF NOT EXISTS studio_ratings_rating_idx ON studio_ratings (rating, created_at)\`;
        await sql\`CREATE INDEX IF NOT EXISTS studio_ratings_design_idx ON studio_ratings (design_id)\`;
        await sql\`CREATE TABLE IF NOT EXISTS studio_lessons (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), kind TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', enabled BOOLEAN NOT NULL DEFAULT true, source_rating_ids JSONB NOT NULL DEFAULT '[]'::jsonb, drafted TEXT NOT NULL DEFAULT 'admin', created_by UUID, updated_by UUID, approved_by UUID, approved_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE INDEX IF NOT EXISTS studio_lessons_kind_idx ON studio_lessons (kind, created_at)\`;
        await sql\`CREATE TABLE IF NOT EXISTS studio_digest_weeks (week_start DATE PRIMARY KEY, ratings INTEGER NOT NULL DEFAULT 0, claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`ALTER TABLE studio_digest_weeks ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\`;
        await sql\`CREATE TABLE IF NOT EXISTS studio_kind_defaults (kind TEXT PRIMARY KEY, agent TEXT NOT NULL, updated_by UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        console.log('[virvi-server] studio ratings and lessons ensured');
      } catch(e) { console.log('[virvi-server] studio ratings and lessons:', e.message); }

      // Design Studio prompt help: how many times a day an account asked to improve a prompt; matches studioUsageDays.promptHelps in src/db/schema.ts
      try {
        await sql\`ALTER TABLE studio_usage_days ADD COLUMN IF NOT EXISTS prompt_helps INTEGER NOT NULL DEFAULT 0\`;
        console.log('[virvi-server] studio_usage_days.prompt_helps ensured');
      } catch(e) { console.log('[virvi-server] studio_usage_days.prompt_helps:', e.message); }

      // Design Studio prompt ideas: the example prompts someone sent as a first prompt, retired for everyone; matches studioIdeaUses in src/db/schema.ts
      try {
        await sql\`CREATE TABLE IF NOT EXISTS studio_idea_uses (idea_id TEXT PRIMARY KEY, user_id UUID CONSTRAINT studio_idea_uses_user_id_users_id_fk REFERENCES users(id) ON DELETE SET NULL, design_id UUID CONSTRAINT studio_idea_uses_design_id_studio_designs_id_fk REFERENCES studio_designs(id) ON DELETE SET NULL, used_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        console.log('[virvi-server] studio_idea_uses ensured');
      } catch(e) { console.log('[virvi-server] studio_idea_uses:', e.message); }

      // Hyperfy HUD pairings; matches hyperfyPairings in src/db/schema.ts
      try {
        await sql\`CREATE TABLE IF NOT EXISTS hyperfy_pairings (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), world_id UUID NOT NULL REFERENCES hyperfy_worlds(id) ON DELETE CASCADE, user_id UUID REFERENCES users(id) ON DELETE CASCADE, code_hash TEXT UNIQUE, secret_hash TEXT, hyperfy_player_id TEXT, player_name TEXT, status TEXT NOT NULL DEFAULT 'pending', code_expires_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE INDEX IF NOT EXISTS hyperfy_pairings_user_idx ON hyperfy_pairings (user_id)\`;
        await sql\`CREATE INDEX IF NOT EXISTS hyperfy_pairings_world_idx ON hyperfy_pairings (world_id)\`;
        await sql\`ALTER TABLE hyperfy_pairings DROP CONSTRAINT IF EXISTS hyperfy_pairings_kind_check\`;
        await sql\`ALTER TABLE hyperfy_pairings ADD CONSTRAINT hyperfy_pairings_kind_check CHECK ((secret_hash IS NOT NULL) <> (hyperfy_player_id IS NOT NULL))\`;
        console.log('[virvi-server] hyperfy_pairings table ensured');
      } catch(e) { console.log('[virvi-server] hyperfy_pairings:', e.message); }

      // Deleting a scene (LIV-83): soft delete, deployment removals; matches scenes, sceneDeployments and sceneRemovals in src/db/schema.ts
      try {
        await sql\`ALTER TABLE scenes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ\`;
        await sql\`ALTER TABLE scenes ADD COLUMN IF NOT EXISTS deleted_by UUID CONSTRAINT scenes_deleted_by_users_id_fk REFERENCES users(id) ON DELETE SET NULL\`;
        await sql\`ALTER TABLE scenes ADD COLUMN IF NOT EXISTS deleted_org_id UUID\`;
        await sql\`ALTER TABLE scenes ADD COLUMN IF NOT EXISTS restorer_ids UUID[]\`;
        await sql\`ALTER TABLE scenes ADD COLUMN IF NOT EXISTS purging_at TIMESTAMPTZ\`;
        await sql\`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ\`;
        await sql\`CREATE INDEX IF NOT EXISTS scenes_deleted_at_idx ON scenes (deleted_at) WHERE deleted_at IS NOT NULL\`;
        await sql\`ALTER TABLE scene_deployments ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ\`;
        await sql\`ALTER TABLE scene_deployments ADD COLUMN IF NOT EXISTS removal_outcome TEXT\`;
        await sql\`CREATE TABLE IF NOT EXISTS scene_removals (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), scene_id UUID NOT NULL CONSTRAINT scene_removals_scene_id_scenes_id_fk REFERENCES scenes(id) ON DELETE CASCADE, kind TEXT NOT NULL, target_id UUID NOT NULL, label TEXT NOT NULL, target JSONB NOT NULL DEFAULT '{}'::jsonb, status TEXT NOT NULL DEFAULT 'pending', error_message TEXT, pending JSONB, requested_by UUID CONSTRAINT scene_removals_requested_by_users_id_fk REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ)\`;
        await sql\`CREATE INDEX IF NOT EXISTS scene_removals_scene_idx ON scene_removals (scene_id)\`;
        await sql\`CREATE UNIQUE INDEX IF NOT EXISTS scene_removals_scene_target_uq ON scene_removals (scene_id, target_id)\`;
        console.log('[virvi-server] scene delete columns ensured');
      } catch(e) { console.log('[virvi-server] scene delete columns:', e.message); }
      // Heatmap height (LIV-85): matches analyticsHeatmapDaily in src/db/schema.ts (and scripts/pre-push-upgrade.mjs)
      try {
        await sql\`DO \$\$ DECLARE pk text; BEGIN
          IF to_regclass('analytics_heatmap_daily') IS NOT NULL THEN
            ALTER TABLE analytics_heatmap_daily ADD COLUMN IF NOT EXISTS cell_y smallint;
            SELECT conname INTO pk FROM pg_constraint WHERE conrelid = 'analytics_heatmap_daily'::regclass AND contype = 'p';
            IF pk IS NOT NULL THEN EXECUTE format('ALTER TABLE analytics_heatmap_daily DROP CONSTRAINT %I', pk); END IF;
            IF to_regclass('analytics_heatmap_daily_cell_uq') IS NULL THEN
              CREATE UNIQUE INDEX analytics_heatmap_daily_cell_uq ON analytics_heatmap_daily (scene_id, day, cell_x, cell_z, cell_y);
            END IF;
          END IF;
        END \$\$\`;
        console.log('[virvi-server] heatmap cell_y ensured');
      } catch(e) { console.log('[virvi-server] heatmap cell_y:', e.message); }
      // Error reporting (LIV-66); matches errorSignatures, errorEvents, errorHourly, errorHourlyDims, errorHourlyUsers, errorReports, errorSettings, errorBudget, errorReleases, errorIpKeys, errorPromptState, errorPromptAsked and errorPromptKnown in src/db/schema.ts
      try {
        await sql\`CREATE TABLE IF NOT EXISTS error_signatures (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), hash TEXT NOT NULL, signature TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, status INTEGER, route TEXT, error_type TEXT, message TEXT, expected TEXT, first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), first_release TEXT, last_release TEXT, total_count BIGINT NOT NULL DEFAULT 0, resolved_at TIMESTAMPTZ, resolved_by UUID, regressed_at TIMESTAMPTZ, user_reports INTEGER NOT NULL DEFAULT 0, linear_issue_id TEXT, linear_issue_key TEXT, linear_issue_url TEXT, linear_filed_at TIMESTAMPTZ, linear_filed_reason TEXT, linear_commented_at TIMESTAMPTZ, linear_quiet_at TIMESTAMPTZ, linear_regression_at TIMESTAMPTZ, stored_day DATE, stored_today INTEGER NOT NULL DEFAULT 0, seen_users BOOLEAN NOT NULL DEFAULT false, linear_filing_at TIMESTAMPTZ, linear_done_at TIMESTAMPTZ, linear_closed_at TIMESTAMPTZ, linear_closed_state TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE UNIQUE INDEX IF NOT EXISTS error_signatures_hash_uq ON error_signatures (hash)\`;
        await sql\`CREATE INDEX IF NOT EXISTS error_signatures_last_seen_idx ON error_signatures (last_seen_at)\`;
        await sql\`CREATE INDEX IF NOT EXISTS error_signatures_first_seen_idx ON error_signatures (first_seen_at)\`;
        await sql\`CREATE TABLE IF NOT EXISTS error_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), signature_id UUID NOT NULL CONSTRAINT error_events_signature_id_error_signatures_id_fk REFERENCES error_signatures(id) ON DELETE CASCADE, occurred_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), source TEXT NOT NULL, kind TEXT NOT NULL, release TEXT, route TEXT, method TEXT, path TEXT, status INTEGER, request_id TEXT, browser TEXT, os TEXT, user_hash TEXT, org_id UUID, scene_id UUID, count INTEGER NOT NULL DEFAULT 1, user_facing BOOLEAN NOT NULL DEFAULT false, error_type TEXT, message TEXT, stack TEXT, error_body JSONB, breadcrumbs JSONB)\`;
        await sql\`CREATE INDEX IF NOT EXISTS error_events_signature_idx ON error_events (signature_id, occurred_at)\`;
        await sql\`CREATE INDEX IF NOT EXISTS error_events_request_idx ON error_events (request_id)\`;
        await sql\`CREATE INDEX IF NOT EXISTS error_events_received_idx ON error_events (received_at)\`;
        await sql\`CREATE TABLE IF NOT EXISTS error_hourly (signature_id UUID NOT NULL CONSTRAINT error_hourly_signature_id_error_signatures_id_fk REFERENCES error_signatures(id) ON DELETE CASCADE, hour TIMESTAMPTZ NOT NULL, count BIGINT NOT NULL DEFAULT 0, users BIGINT NOT NULL DEFAULT 0, ips BIGINT NOT NULL DEFAULT 0, CONSTRAINT error_hourly_signature_id_hour_pk PRIMARY KEY (signature_id, hour))\`;
        await sql\`CREATE INDEX IF NOT EXISTS error_hourly_hour_idx ON error_hourly (hour)\`;
        await sql\`CREATE TABLE IF NOT EXISTS error_hourly_dims (signature_id UUID NOT NULL CONSTRAINT error_hourly_dims_signature_id_error_signatures_id_fk REFERENCES error_signatures(id) ON DELETE CASCADE, hour TIMESTAMPTZ NOT NULL, dim TEXT NOT NULL, value TEXT NOT NULL, count BIGINT NOT NULL DEFAULT 0, CONSTRAINT error_hourly_dims_signature_id_hour_dim_value_pk PRIMARY KEY (signature_id, hour, dim, value))\`;
        await sql\`CREATE INDEX IF NOT EXISTS error_hourly_dims_hour_idx ON error_hourly_dims (hour)\`;
        await sql\`CREATE TABLE IF NOT EXISTS error_hourly_users (signature_id UUID NOT NULL CONSTRAINT error_hourly_users_signature_id_error_signatures_id_fk REFERENCES error_signatures(id) ON DELETE CASCADE, hour TIMESTAMPTZ NOT NULL, user_hash TEXT NOT NULL, CONSTRAINT error_hourly_users_signature_id_hour_user_hash_pk PRIMARY KEY (signature_id, hour, user_hash))\`;
        await sql\`CREATE INDEX IF NOT EXISTS error_hourly_users_hour_idx ON error_hourly_users (hour)\`;
        await sql\`CREATE TABLE IF NOT EXISTS error_reports (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), signature_id UUID NOT NULL CONSTRAINT error_reports_signature_id_error_signatures_id_fk REFERENCES error_signatures(id) ON DELETE CASCADE, user_id UUID CONSTRAINT error_reports_user_id_users_id_fk REFERENCES users(id) ON DELETE SET NULL, description TEXT NOT NULL, payload JSONB NOT NULL, release TEXT, screenshot_key TEXT, screenshot_type TEXT, screenshot_bytes INTEGER, linear_posted_at TIMESTAMPTZ, linear_skipped TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE INDEX IF NOT EXISTS error_reports_signature_idx ON error_reports (signature_id, created_at)\`;
        // Fix round 1 upgrades of tables made before it: 64-bit counters, per-day sampling and distinct addresses
        await sql\`DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'error_signatures' AND column_name = 'stored_day') THEN ALTER TABLE error_signatures ADD COLUMN stored_day DATE; END IF; END \$\$\`;
        await sql\`DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'error_signatures' AND column_name = 'stored_today') THEN ALTER TABLE error_signatures ADD COLUMN stored_today INTEGER NOT NULL DEFAULT 0; END IF; END \$\$\`;
        // Each ALTER runs only when needed: an ALTER TABLE locks the table even when it changes nothing (N3)
        await sql\`DO \$\$ BEGIN IF (SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'error_hourly' AND column_name = 'count') = 'integer' THEN ALTER TABLE error_hourly ALTER COLUMN count TYPE BIGINT; END IF; END \$\$\`;
        await sql\`DO \$\$ BEGIN IF (SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'error_hourly' AND column_name = 'users') = 'integer' THEN ALTER TABLE error_hourly ALTER COLUMN users TYPE BIGINT; END IF; END \$\$\`;
        await sql\`DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'error_hourly' AND column_name = 'ips') THEN ALTER TABLE error_hourly ADD COLUMN ips BIGINT NOT NULL DEFAULT 0; END IF; END \$\$\`;
        await sql\`DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'error_hourly' AND column_name = 'stored') THEN ALTER TABLE error_hourly DROP COLUMN stored; END IF; END \$\$\`;
        await sql\`DO \$\$ BEGIN IF (SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'error_hourly_dims' AND column_name = 'count') = 'integer' THEN ALTER TABLE error_hourly_dims ALTER COLUMN count TYPE BIGINT; END IF; END \$\$\`;
        // Fix round 2: shared daily budgets, known releases, per-day address keys, and who has hit a signature
        await sql\`DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'error_signatures' AND column_name = 'seen_users') THEN ALTER TABLE error_signatures ADD COLUMN seen_users BOOLEAN NOT NULL DEFAULT false; END IF; END \$\$\`;
        await sql\`CREATE TABLE IF NOT EXISTS error_budget (day DATE NOT NULL, key TEXT NOT NULL, n BIGINT NOT NULL DEFAULT 0, CONSTRAINT error_budget_day_key_pk PRIMARY KEY (day, key))\`;
        await sql\`CREATE TABLE IF NOT EXISTS error_releases (release TEXT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE TABLE IF NOT EXISTS error_ip_keys (day DATE PRIMARY KEY, key TEXT NOT NULL)\`;
        // Phase 2: report prompts, screenshots, reports posted to Linear, and Done read back from Linear
        await sql\`DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'error_signatures' AND column_name = 'linear_filing_at') THEN ALTER TABLE error_signatures ADD COLUMN linear_filing_at TIMESTAMPTZ; END IF; END \$\$\`;
        await sql\`DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'error_signatures' AND column_name = 'linear_done_at') THEN ALTER TABLE error_signatures ADD COLUMN linear_done_at TIMESTAMPTZ; END IF; END \$\$\`;
        await sql\`DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'error_reports' AND column_name = 'screenshot_key') THEN ALTER TABLE error_reports ADD COLUMN screenshot_key TEXT; END IF; END \$\$\`;
        await sql\`DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'error_reports' AND column_name = 'screenshot_type') THEN ALTER TABLE error_reports ADD COLUMN screenshot_type TEXT; END IF; END \$\$\`;
        await sql\`DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'error_reports' AND column_name = 'screenshot_bytes') THEN ALTER TABLE error_reports ADD COLUMN screenshot_bytes INTEGER; END IF; END \$\$\`;
        await sql\`DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'error_reports' AND column_name = 'linear_posted_at') THEN ALTER TABLE error_reports ADD COLUMN linear_posted_at TIMESTAMPTZ; END IF; END \$\$\`;
        await sql\`DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'error_reports' AND column_name = 'linear_skipped') THEN ALTER TABLE error_reports ADD COLUMN linear_skipped TEXT; END IF; END \$\$\`;
        await sql\`CREATE INDEX IF NOT EXISTS error_reports_posted_idx ON error_reports (linear_posted_at)\`;
        await sql\`CREATE TABLE IF NOT EXISTS error_prompt_state (user_id UUID PRIMARY KEY CONSTRAINT error_prompt_state_user_id_users_id_fk REFERENCES users(id) ON DELETE CASCADE, opted_out BOOLEAN NOT NULL DEFAULT false, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'error_signatures' AND column_name = 'linear_closed_at') THEN ALTER TABLE error_signatures ADD COLUMN linear_closed_at TIMESTAMPTZ; END IF; END \$\$\`;
        await sql\`DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'error_signatures' AND column_name = 'linear_closed_state') THEN ALTER TABLE error_signatures ADD COLUMN linear_closed_state TEXT; END IF; END \$\$\`;
        // Fix round 2: ask times by account hash only; the per-account table keeps the setting alone
        await sql\`DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'error_prompt_state' AND column_name = 'asked_at') THEN ALTER TABLE error_prompt_state DROP COLUMN asked_at; END IF; END \$\$\`;
        await sql\`CREATE TABLE IF NOT EXISTS error_prompt_asked (user_hash TEXT PRIMARY KEY, asked_at TIMESTAMPTZ NOT NULL)\`;
        await sql\`CREATE INDEX IF NOT EXISTS error_prompt_asked_asked_idx ON error_prompt_asked (asked_at)\`;
        await sql\`CREATE TABLE IF NOT EXISTS error_prompt_known (signature_id UUID NOT NULL CONSTRAINT error_prompt_known_signature_id_error_signatures_id_fk REFERENCES error_signatures(id) ON DELETE CASCADE, user_hash TEXT NOT NULL, shown_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CONSTRAINT error_prompt_known_signature_id_user_hash_pk PRIMARY KEY (signature_id, user_hash))\`;
        await sql\`CREATE INDEX IF NOT EXISTS error_prompt_known_shown_idx ON error_prompt_known (shown_at)\`;
        await sql\`CREATE TABLE IF NOT EXISTS error_settings (id TEXT PRIMARY KEY, thresholds JSONB NOT NULL DEFAULT '{}'::jsonb, updated_by UUID, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        console.log('[virvi-server] error reporting tables ensured');
      } catch(e) { console.log('[virvi-server] error reporting tables:', e.message); }
      // model enum value
      try {
        await sql\`ALTER TYPE element_type ADD VALUE IF NOT EXISTS 'model'\`;
        console.log('[virvi-server] model enum value ensured');
      } catch(e) { console.log('[virvi-server] model enum:', e.message); }
      // Hyperfy analytics location kind
      try {
        await sql\`ALTER TYPE analytics_scene_kind ADD VALUE IF NOT EXISTS 'hyperfy'\`;
        console.log('[virvi-server] hyperfy analytics kind ensured');
      } catch(e) { console.log('[virvi-server] hyperfy analytics kind:', e.message); }
      await sql.end();
    })();
  " 2>&1 || echo "[virvi-server] SQL fallback had errors"
  cd /app
fi

# Debug: verify dashboard exists
echo "[virvi-server] CWD: $(pwd)"
echo "[virvi-server] DASHBOARD_DIR: $DASHBOARD_DIR"
ls -la "${DASHBOARD_DIR:-./dashboard}/" 2>&1 | head -5 || echo "[virvi-server] WARNING: dashboard dir missing!"

# Start the server
exec node apps/server/dist/index.js
