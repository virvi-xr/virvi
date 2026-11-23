# Dashboard navigation by product line (LIV-200) + Cities (LIV-202) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard menu reads Studio, Sync, Events, Drops, AR, Cities (BEATs keeps its own item); Studio has Scenes / Wearables / Emotes / Buildings / Decor tabs; old addresses keep working; "furniture" reads "decor" everywhere a person sees it; a Cities list exists in the dashboard and publicly at /cities.

**Architecture:** Pure web reorganisation plus one small server change (designs carry a scene shape so Buildings and Decor can be told apart). Pages that move get a client redirect stub at their old path that keeps the query and hash. The city list is static config in `@virvixr/shared`.

**Tech Stack:** Next.js static export (apps/web), Fastify + Drizzle (apps/server), vitest, Starlight docs (apps/docs).

**Spec:** Linear LIV-200 and LIV-202 (owner rulings 2026-11-22: BEATs keeps its own menu item; rename furniture → Decor everywhere people see it).

## Global Constraints

- Old links keep working: `/scenes`, `/scenes/<id>`, `/studio`, `/studio/<id>`, `/deploy`, `/giveaways` (and their query strings) all still land on the right page.
- Same access as today: Design Studio tabs only where the Studio is available (`useStudioAvailable()`), or for a trial; a trial's open/demo/locked rules unchanged in meaning (`/drops` is a demo like `/giveaways` was; `/sync` locked like `/deploy`).
- Internal names don't change: design kind stays `scene`, piece categories stay `building` / `furniture_<name>`, API routes unchanged. Only words people read change.
- Sentence case, plain words; no new dependencies.

## Rulings (controller)

- **URLs.** Sync lives at `/sync` (today's `/deploy` page moved), Drops at `/drops` (today's `/giveaways` moved). `/deploy` and `/giveaways` become redirect stubs (`router.replace` keeping `search` + `hash`). Scenes keep `/scenes` and `/scenes/<id>`; designs keep `/studio` and `/studio/<id>`; the design tabs are `/studio?kind=wearable|emote|building|decor`. Cost if wrong: the scenes list URL doesn't say "studio" — cosmetic.
- **Studio menu item** goes to `/scenes` (its first tab) and stays highlighted on `/scenes*`, `/studio*` and `/import`. One `StudioTabs` bar sits on top of the Scenes page and the designs page.
- **`/studio` with no kind** keeps listing all designs, shown as a last tab "All designs" (so old links and the "Design Studio" landing still show everything). Cost: one tab beyond the ticket's five.
- **Buildings vs Decor.** A scene design's shape is its pieces when it has any (a `building` piece → building; only `furniture_*` → decor); before it has pieces, the shape chosen at creation (new nullable column `studio_designs.scene_shape`, `'building' | 'decor'`); none → building. The server's design list returns `sceneShape`. The agent isn't told the shape (follow-up). Cost: a Decor design whose agent builds a building moves to Buildings — that's correct by pieces.
- **Cities.** Public page `/cities` (outside the dashboard, like `/ar`); dashboard page `/virvi-cities` (inside, like `/ar-apps`), both rendering one `CityList` from `CITIES` in `@virvixr/shared`. Decentraland link: `https://decentraland.org/jump/?realm=<world>` (verified 2026-11-22: 200, "Virvi City | Decentraland"). No picture asset exists yet: cards use a generated gradient tile with the city's initials (`image: null` in config). Events per city: none exist to link yet; config has optional `eventsHref`.
- **Assistant `open_page`** accepts `sync`, `drops`, `virvi-cities`, `cities` besides the old names (old ones still redirect).

## Review Focus

1. `/deploy?scene=…` (or any old query) → `/sync?scene=…` with the query intact; same for `/giveaways?…` → `/drops?…`.
2. A trial on `/drops` sees the demo, on `/sync` the lock; a scene pass still only reaches its analytics.
3. Self-hosted (Studio off): Studio menu shows, tabs show only Scenes; `/studio?kind=…` doesn't crash.
4. A shared design (role collaborator/viewer) appears under the right tab, and the "Shared with me" section still works within a tab.
5. "Furniture" no longer appears in user-facing web copy, pricing answers or the Finalize screen; `furniture_` internals still parse.

---

### Task 1: Server — designs carry a scene shape

**Files:** `apps/server/src/db/schema.ts`, `apps/server/entrypoint.sh`, `apps/server/src/routes/studio.ts` (create + list), `apps/server/src/studio/designs.ts` (shape helper), tests in `apps/server/test/studio-routes.test.ts` (or the file that covers design create/list).

- [ ] Column: `sceneShape: text('scene_shape')` on `studioDesigns`; entrypoint `ALTER TABLE studio_designs ADD COLUMN IF NOT EXISTS scene_shape TEXT` next to the other studio_designs ALTERs.
- [ ] `POST /api/studio/designs` accepts optional `sceneShape: 'building' | 'decor'`, only with `kind: 'scene'` (else 400 `bad_request`, "Only a scene design takes a shape."). Default name for decor: `Untitled decor`; building: `Untitled building` (scene without shape keeps `Untitled scene piece`).
- [ ] `export function sceneShapeOf(stored: string | null, categories: string[]): 'building' | 'decor'` in designs.ts: any `building` → building; categories non-empty and all `furniture_*` → decor; else stored ?? 'building'.
- [ ] Design list and design detail responses include `sceneShape` for scene designs (null for other kinds), computed from the latest revisions' piece categories (reuse whatever query already yields `pieceCount`).
- [ ] Tests: create with shape (scene ok, wearable 400); list shape for: empty decor → decor, empty no shape → building, building piece → building, only furniture → decor, stored decor + building piece → building.
- [ ] Commit.

### Task 2: Web — Sync and Drops move, old paths redirect, access rules follow

**Files:** move `apps/web/src/app/(dashboard)/deploy/` → `sync/`, `giveaways/` → `drops/`; new stubs `deploy/page.tsx`, `giveaways/page.tsx`; `apps/web/src/lib/redirect.ts` (new, `movedTo(path)` hook/component); `apps/web/src/lib/trial.ts`, `apps/web/src/lib/session.ts`, `apps/web/src/lib/landing-route.ts`; every web reference to `/deploy` or `/giveaways` as a dashboard link; `apps/server/src/assistant/tools/local.ts` PAGES; tests beside each lib.

- [ ] `Moved({ to })` client component: on mount `router.replace(to + location.search + location.hash)`, renders a one-line "Moved to …" link for no-JS.
- [ ] Update in-app links to the new paths (grep `'/deploy`, `"/deploy`, `` `/deploy``, same for giveaways; leave API paths alone).
- [ ] trial.ts: `TRIAL_DEMOS` gets `/drops` (keep `/giveaways` so the stub can redirect inside a trial); session.ts trial-allowed rules unchanged in meaning for the new paths.
- [ ] Assistant PAGES add `sync`, `drops`, `virvi-cities`, `cities`; its description lists the new names first. Test in assistant-tools test that `/sync` and `/drops` are dashboard paths.
- [ ] Tests: trial nav for `/drops` (demo) and `/sync` (locked); `movedTo` keeps query+hash (unit test the pure function `movedHref(to, search, hash)`).
- [ ] Commit.

### Task 3: Web — the menu and Studio's tabs

**Files:** `apps/web/src/app/(dashboard)/layout.tsx`, `apps/web/src/components/studio/StudioTabs.tsx` (new), `apps/web/src/app/(dashboard)/scenes/page.tsx`, `apps/web/src/app/(dashboard)/studio/page.tsx`, `apps/web/src/components/KindPicker.tsx`, `apps/web/src/lib/studio.ts` (`StudioDesign.sceneShape`, `KIND_CHOICES`, tab filter helper), `apps/web/src/lib/api.ts` (create design body), tests.

- [ ] Menu (Workspace section, in order): Command Center, Studio (`/scenes`, active for `/scenes`, `/studio`, `/import`), Sync (`/sync`, description "Where each scene runs and its deploys"), Events, Drops (`/drops`, "Giveaways and other rewards"), AR (`/ar-apps`), Cities (`/virvi-cities`), then BEATs when on. Tools: Media Library, Asset Library, Streaming, Analytics (Deploy leaves Tools). `STUDIO_ITEM` ("Design Studio") is gone: the Studio item is always there (Scenes is always available); the design tabs are what's conditional.
- [ ] `StudioTabs({ active })`: Scenes `/scenes`, Wearables `/studio?kind=wearable`, Emotes `/studio?kind=emote`, Buildings `/studio?kind=building`, Decor `/studio?kind=decor`, All designs `/studio`; design tabs only when `useStudioAvailable()` or trial. Tab links to /studio use full loads like `designHref` does if needed by the server's /studio routing (`/studio/?kind=` is served by `studio/index.html`).
- [ ] `filterDesigns(designs, tab)` in studio.ts: wearable/emote by kind; building/decor by `kind==='scene' && sceneShape===tab`; all → everything. Unit tests.
- [ ] Designs page: reads `kind` from the URL, filters both "mine" and "shared", the page title is the tab's name (Wearables, Emotes, Buildings, Decor, Design Studio for all), New starts that kind (building/decor → `kind: 'scene', sceneShape`). KindPicker choices: Wearable, Emote, Building, Decor.
- [ ] Scenes page: `StudioTabs active="scenes"` above its header; crumbs `['Studio', 'Scenes']`.
- [ ] Commit.

### Task 4: Cities (LIV-202)

**Files:** `packages/shared/src/cities.ts` (+ export), `apps/web/src/components/cities/CityList.tsx`, `apps/web/src/app/cities/page.tsx` (public), `apps/web/src/app/(dashboard)/virvi-cities/page.tsx`, tests.

- [ ] `CITIES: City[]` where `City = { id, name, description, image: string | null, worlds: Array<{ platform: 'decentraland' | 'hyperfy' | 'ar'; url: string | null; status: 'live' | 'coming' }>, eventsHref?: string }`. First entry: `virvicity`, "Virvi City", one-line description, worlds: decentraland live `https://decentraland.org/jump/?realm=virvicity.dcl.eth`; hyperfy coming, url null.
- [ ] `CityList`: a card per city — tile (image, or initials tile when null), name, description, one action per world: live → "Visit in Decentraland"/"Visit in Hyperfy"/"Visit in AR" link (new tab, rel noopener); coming → "Coming to Hyperfy" muted text. Live badge when any world is live.
- [ ] Public `/cities` page with metadata, same shell as `/ar`'s landing (header/footer components it uses); dashboard `/virvi-cities` with `PageHeader` title "Cities".
- [ ] Tests: config shape (every live world has an https url, every coming one null); CityList renders the Decentraland link and "Coming to Hyperfy".
- [ ] Commit.

### Task 5: Words — Decor everywhere, new names in docs, help and assistant

**Files:** web copy containing "furniture" (studio page, KindPicker, studio.ts labels, Finalize, Steps, TourStep, Preview copy, summit blurb), `apps/server/src/studio/pricing.ts` user-facing strings, `apps/server/src/studio/prompt-help.ts` label, `apps/server/src/studio/lesson-drafts.ts` wording, assistant prompt/tool descriptions mentioning furniture or Deploy/Giveaways pages, docs pages under `apps/docs/src/content/docs/` (dashboard pages for deploy → Sync, giveaways → Drops, studio tabs, new Cities page), in-app help search index if it lists page names.

- [ ] Replace user-facing "furniture" with "decor" (keep `furniture_` identifiers, regexes and data keys). Update tests whose expected strings change.
- [ ] Docs: rename page titles/sections to Sync and Drops (keep old slugs working: if a docs page moves, add a redirect the docs site supports, else keep the slug and change the title), describe the Studio tabs and Cities, update menu names in any "go to X" instructions.
- [ ] Commit.

### Final: full web + server checks, whole-branch review, merge, deploy.
