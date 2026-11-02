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

      // Studio gift codes; matches studioGiftCodes / studioGiftRedemptions / studioFinalizeCredits in src/db/schema.ts
      try {
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

      // Hyperfy HUD pairings; matches hyperfyPairings in src/db/schema.ts
      try {
        await sql\`CREATE TABLE IF NOT EXISTS hyperfy_pairings (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), world_id UUID NOT NULL REFERENCES hyperfy_worlds(id) ON DELETE CASCADE, user_id UUID REFERENCES users(id) ON DELETE CASCADE, code_hash TEXT UNIQUE, secret_hash TEXT, hyperfy_player_id TEXT, player_name TEXT, status TEXT NOT NULL DEFAULT 'pending', code_expires_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE INDEX IF NOT EXISTS hyperfy_pairings_user_idx ON hyperfy_pairings (user_id)\`;
        await sql\`CREATE INDEX IF NOT EXISTS hyperfy_pairings_world_idx ON hyperfy_pairings (world_id)\`;
        await sql\`ALTER TABLE hyperfy_pairings DROP CONSTRAINT IF EXISTS hyperfy_pairings_kind_check\`;
        await sql\`ALTER TABLE hyperfy_pairings ADD CONSTRAINT hyperfy_pairings_kind_check CHECK ((secret_hash IS NOT NULL) <> (hyperfy_player_id IS NOT NULL))\`;
        console.log('[virvi-server] hyperfy_pairings table ensured');
      } catch(e) { console.log('[virvi-server] hyperfy_pairings:', e.message); }

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
