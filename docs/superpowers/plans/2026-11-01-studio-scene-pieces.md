# Design Studio Buildings and Furnishings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third Design Studio kind, `scene`, where an agent builds a walk-in building and/or furniture with the
dcl-avatar-skills scene skills; the person inspects every angle, watches a rendered walk-through (buildings) or a
scale view (furniture), finalizes at the scene prices, and each piece lands in their private asset library.

**Architecture:** The worker collects scene pieces from `out/building/` and `out/furniture_<slug>/`, checks them with
the skills' `check_scene_model.py` and `check_walk.py`, and renders them with a new Babylon page of its own
(`scene-orbit`, `scale`, `tour` modes) through the existing render dispatcher. The server adds the kind, its view keys,
scene pricing and a post-finalize step that copies each paid piece's GLB and thumbnail to public storage as an
`asset_library_items` row. The web adds the kind to the picker and the Walk-through and Scale steps.

**Tech Stack:** Python worker (Playwright + Chrome, Blender 4.4.3), Babylon.js 7 vendored into the worker image,
Fastify + Drizzle server (Postgres via `drizzle-kit push`), Next.js web, vitest and pytest.

**Spec:** `docs/superpowers/specs/2026-11-01-studio-scene-pieces-design.md`

## Global Constraints

- The model never leaves before payment: every preview is rendered on the worker; no GLB, and nothing a browser could
  turn back into one, reaches it before finalize.
- Soft limits warn, never block: triangles, materials, textures and entities only warn; only the checker's FAILs
  (colliders, walkability, hard file limits) block a finalize.
- Footprints: `0.5x0.5`, `1x1`, `1x2`, `2x2`, `4x4` (parcels, X by Z; 1×2 is 16 m wide, 32 m deep).
- At most one building and 12 furniture pieces a design.
- Prices (cents, settings): furniture 900 first, 500 each extra in the same design, 500 revision; building 2900 for
  0.5x0.5 or 1x1, 4900 for 1x2 or 2x2, 7900 for 4x4; building revisions 1500, 2500, 4000 by the same tiers.
- Furniture in a design with a building is priced as extra pieces; charges already paid stand; a revision is priced by
  the building's footprint as revised; a gift credit covers a first finalize up to 2900 and takes 2900 off a bigger one.
- A finalized revision adds a new library row and leaves the old one. A door leaf is its own furniture piece (type
  `door`) and so its own row. A sittable piece's `sittables.json` is stored with its library row.
- The worker image pins dcl-avatar-skills at `a914875c0bba82a68783db8e0a6a0099200a94ce` and runs Blender 4.4.3.
- Deploy order: worker image before server.

## Review Focus

1. An agent names a folder Virvi can't store (`out/furniture_Round-Table/`, `out/chair/`): `collect` reports a clear
   problem the agent can fix, never a 400 on upload halfway through saving (Task 1 test).
2. A building without `route.json`, or with a route that ends on a floor it never reached: a checker FAIL that tells
   the agent what to write, not a crash (Task 1 test).
3. `layout.json` names a furniture piece that no longer exists, or none at all: the furnished walk and the tour skip
   it with a warning (Tasks 1 and 4 tests).
4. The building changes but the furniture doesn't: the walk-through re-renders, because set renders are keyed by every
   piece's latest revision (Task 6 test).
5. The library copy fails after payment (storage down): the entitlement is still `ready`, the package downloads, and
   the sweep adds the library rows later (Task 8 test).

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/studio-worker/studio_worker/scene.py` (new) | Scene piece rules: folder pattern, piece.json fields, extras, the two checkers' invocation and report merging |
| `apps/studio-worker/studio_worker/pieces.py` | `collect` and `check` branch to `scene.py` for `kind == 'scene'`; `Piece.extras` |
| `apps/studio-worker/studio_worker/instructions.py` | `closing('scene', …)` |
| `apps/studio-worker/studio_worker/scene_render.py` (new) | The scene renderer child process: the Babylon page, `scene-orbit`, `scale`, `tour` |
| `apps/studio-worker/scene_page/index.html`, `scene_page.js` (new) | The page: loads base64 GLBs, flat lighting, a 1.8 m mannequin, camera calls |
| `apps/studio-worker/scripts/fetch_babylon.sh` (new) | Downloads the pinned Babylon files into `scene_page/vendor/` and checks their SHA-256 |
| `apps/studio-worker/studio_worker/render.py` | `render()` dispatches scene modes to `scene_render`; `studio-preview` for scene pieces |
| `apps/studio-worker/studio_worker/jobs.py` | Scene prompt views, render and set (tour) jobs, extras uploaded with each piece |
| `apps/studio-worker/studio_worker/finalize.py` | Scene packages and `final/<category>/thumbnail.png` |
| `apps/studio-worker/Dockerfile`, `CONTRACT.md` | Skills pin, Babylon fetch; the scene contract |
| `apps/server/src/studio/scene.ts` (new) | `SCENE_CATEGORY`, footprints, scene view keys, scene prompt limits |
| `apps/server/src/studio/designs.ts`, `sets.ts`, `results.ts`, `routes/studio.ts` | The kind threaded through |
| `apps/server/src/studio/pricing.ts`, `payments.ts`, `config.ts` | Scene prices, the gift cap |
| `apps/server/src/studio/library.ts` (new) | Finalized scene pieces into `asset_library_items` |
| `apps/server/src/studio/store.ts`, `routes/studio-worker.ts` | `final/<category>/thumbnail.png` for finalize jobs |
| `apps/server/src/db/schema.ts` | `asset_library_items.sittables`, `studio_entitlements.asset_item_ids` |
| `apps/web/src/lib/studio.ts`, `app/(dashboard)/studio/page.tsx`, `[designId]/Preview.tsx`, `TourStep.tsx` (new), `Finalize.tsx` | Kind, steps, views, warnings |

Category names: a scene piece's `category` is `building`, or `furniture_<slug>` with `<slug>` matching
`[a-z0-9_]{1,32}`, so it fits the server's existing `[a-z_]+`-style path segments. Folder = category.

---

### Task 1: Worker collects and checks scene pieces

**Files:**
- Create: `apps/studio-worker/studio_worker/scene.py`
- Modify: `apps/studio-worker/studio_worker/pieces.py` (`Piece`, `collect`, `check`), `apps/studio-worker/studio_worker/jobs.py` (`_upload_piece`, `_piece_result`)
- Create: `apps/studio-worker/tests/make_scene_fixtures.py`, `apps/studio-worker/tests/fixtures/scene/` (generated, committed)
- Test: `apps/studio-worker/tests/test_scene_pieces.py`

**Interfaces:**
- Produces: `scene.CATEGORY = re.compile(r'^(building|furniture_[a-z0-9_]{1,32})$')`, `scene.MAX_FURNITURE = 12`,
  `scene.FOOTPRINTS = ('0.5x0.5', '1x1', '1x2', '2x2', '4x4')`;
  `scene.validate(category: str, meta: dict) -> str | None` (a problem, or None);
  `scene.extras(folder: Path, meta: dict) -> list[Path]` (`route.json`, `layout.json` for a building; `<glb stem>.sittables.json` for furniture, when present);
  `scene.check(piece: Piece, others: list[Piece]) -> dict` returning `{'ran', 'pass', 'failures', 'warnings', 'triangles': {'count', 'limit'} | None, 'report'}`;
  `Piece.extras: list[Path]` (default `[]`);
  piece.json fields for scene: `name`, `description`, `kind` (`building` | `furniture` | `decor`), `type` (str), `footprint` (buildings), `changeKind`.
  `layout.json` (building folder): `{"furniture": [{"category": "furniture_chair", "x": 1.0, "z": -2.0, "yaw": 90}]}`.
- Consumes: the skills at `config.SKILLS / 'skills/creating-dcl-buildings/scripts/'` (`check_scene_model.py`, `check_walk.py`).

- [ ] **Step 1: Generate fixtures.** `tests/make_scene_fixtures.py` writes, with a minimal GLB writer like the skills
  repo's `tests/glbfactory.py`: `fixtures/scene/building/` (a 10×10 m walled room with a 1.2 m doorway in the +Z wall,
  wall boxes as `*_collider`, `kiosk.glb`, `piece.json` with footprint `1x1`, `route.json` walking in through the
  door), `fixtures/scene/furniture_chair/` (`chair.glb` with a collider stopping short of the seat, `chair.sittables.json`
  as in the skills' tests, `piece.json` kind `furniture` type `chair`), and `fixtures/scene/furniture_wide_couch/`
  (a 2 m × 0.8 m couch for blocking the doorway). Run it once and commit the output.

- [ ] **Step 2: Write the failing tests** in `tests/test_scene_pieces.py`:

```python
def test_collects_a_building_and_a_chair_with_their_extras(tmp_path, skills): ...
    # pieces == ['building', 'furniture_chair']; building.extras names == ['layout.json', 'route.json'] (sorted);
    # chair.extras == ['chair.sittables.json']; both checker['pass'] is True
def test_a_folder_virvi_cannot_store_is_a_problem(tmp_path, skills): ...
    # out/furniture_Round-Table/ and out/chair/ -> error mentions 'furniture_<name>' and each folder; no pieces
def test_more_than_one_building_or_twelve_furniture_is_a_problem(tmp_path, skills): ...
def test_a_scene_piece_has_exactly_one_glb(tmp_path, skills): ...   # two GLBs in out/furniture_chair/ -> a problem naming the folder
def test_a_building_without_a_route_fails_its_check_with_what_to_write(tmp_path, skills): ...
    # checker pass False; 'route.json' in report
def test_a_route_that_never_reaches_its_floor_fails(tmp_path, skills): ...
def test_furniture_blocking_the_door_only_warns(tmp_path, skills): ...
    # layout puts furniture_wide_couch in the doorway: pass True, warnings >= 1, 'furnished' in report
def test_a_layout_naming_a_missing_piece_warns_and_skips_it(tmp_path, skills): ...
def test_triangles_over_the_recommendation_are_reported_not_failed(tmp_path, skills): ...
    # a 3,600-triangle building: pass True, triangles == {'count': 3600, 'limit': 3000}
def test_extras_upload_with_the_piece(api, tmp_path, skills): ...
    # a scene prompt job uploads pieces/building/route.json, pieces/building/layout.json,
    # pieces/furniture_chair/chair.sittables.json, and _piece_result's checker carries 'triangles'
```

- [ ] **Step 3: Run them; expect FAIL** (`ModuleNotFoundError: studio_worker.scene`).
  Run: `cd apps/studio-worker && python3 -m pytest -q tests/test_scene_pieces.py`

- [ ] **Step 4: Implement** `scene.py` and the `pieces.py`/`jobs.py` branches. `check` runs `check_scene_model.py` with
  `--kind`, `--footprint`, `--type`, `--sittables` from the piece; for a building also `check_walk.py --route`, then a
  second walk with `--place <glb> x z yaw` per resolvable `layout.json` entry whose FAILs are counted as warnings and
  whose report section is headed `furnished walk`. `triangles` comes from the model checker's `WARN triangles` row
  (`<count>` value, `recommended <= <limit>` rule). A missing `route.json` is a FAIL row the worker writes itself:
  `route.json missing: write {"waypoints": [[x, z], [x, z, y], ...]} from outside, through the doorway, round every room
  and floor`.

- [ ] **Step 5: Run; expect PASS**, then the whole worker suite: `python3 -m pytest -q` → all pass.

- [ ] **Step 6: Commit** `feat(studio-worker): scene pieces collected and checked with the scene skills`.

### Task 2: The agent's instructions for scene designs

**Files:**
- Modify: `apps/studio-worker/studio_worker/instructions.py`
- Test: `apps/studio-worker/tests/test_pieces.py` (the `closing` tests live there)

**Interfaces:**
- Produces: `closing('scene', selected_slots=None, agent=None) -> str`.
- Consumes: Task 1's folder names and file formats.

- [ ] **Step 1: Write the failing test** `test_closing_for_a_scene_design_names_the_skills_folders_and_checks`:
  asserts the text contains `creating-dcl-buildings`, `creating-dcl-furnishings`, `out/building/`,
  `out/furniture_<name>/`, `at most one building and 12 furniture`, `route.json`, `layout.json`, `sittables.json`,
  `check_scene_model.py`, `check_walk.py`, `studio-preview`, and does NOT contain `rarity` or `check_wearable`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** One building per design, furniture as separate pieces (never baked into the building),
  a door leaf as a `furniture_door` piece, the piece.json fields from Task 1, write for Blender 4.4, run both checks and
  fix every FAIL, look with `studio-preview` (Task 3) before finishing. Shaping, when the idea isn't settled, goes
  through `shaping-dcl-item-ideas` and no proposal file (scene designs have no slots).
- [ ] **Step 4: Run; expect PASS** (whole `test_pieces.py`).
- [ ] **Step 5: Commit** `feat(studio-worker): instructions for scene designs`.

### Task 3: The scene renderer

**Files:**
- Create: `apps/studio-worker/scene_page/index.html`, `apps/studio-worker/scene_page/scene_page.js`,
  `apps/studio-worker/scripts/fetch_babylon.sh`, `apps/studio-worker/studio_worker/scene_render.py`
- Modify: `apps/studio-worker/studio_worker/render.py` (`render` dispatch, `main` / `studio-preview`),
  `apps/studio-worker/.gitignore` (`scene_page/vendor/`), `apps/studio-worker/Dockerfile`
- Test: `apps/studio-worker/tests/test_scene_render.py`

**Interfaces:**
- Produces: `render.SCENE_MODES = ('scene-orbit', 'scale', 'tour')`; `render.render(pieces, view, out, ...)` unchanged
  in signature, dispatching scene modes to `scene_render.render(pieces, view, out, frames, size, watchdog_sec)` with the
  same result shape (`ok`, `frames`, `error`, `bootSec`, `fps` for a tour, `blankFrame` on blank).
  Scene `pieces` entries: `{'category', 'glbs': {'unisex': Path}, 'meta', 'at': {'x', 'z', 'yaw'} | None}`.
  Views: `{'mode': 'scene-orbit', 'ring': bool}` (24 or 122 frames, the same grid as `orbit_steps`);
  `{'mode': 'scale'}` (36 frames, the camera turning once round the piece beside a 1.8 m mannequin);
  `{'mode': 'tour', 'path': [[x, y, z], ...]}` (eye-height points; frames at 24 fps; length
  `min(20 s, path length / 1.4 m/s)`, at least 4 s).
  `scene_render.tour_path(building_glb: Path, route: dict, place: list) -> list[list[float]]` (the walker's ground
  heights from the skills' `check_walk.walk`, plus 1.6 m, resampled every 0.05 m).
- Consumes: `render.orbit_steps`, `render.is_blank`, `render._blank`-style capture, `CHROME_ARGS`.

- [ ] **Step 1: Pin Babylon.** `fetch_babylon.sh` downloads `babylon.js` and `babylonjs.loaders.min.js` for one 7.x
  version at least two weeks old from cdnjs into `scene_page/vendor/`, and fails unless each file's SHA-256 matches the
  values written in the script. The Dockerfile runs it at build; a local run does the same.
- [ ] **Step 2: Write the failing tests** (skipped when Chrome or `scene_page/vendor/` is missing):

```python
def test_scene_orbit_renders_the_ring_and_the_sphere(tmp_path): ...   # 24 then 122 non-blank frames of fixtures' chair
def test_scale_turns_round_the_piece_beside_the_mannequin(tmp_path): ...  # 36 frames; frame 0 differs from frame 9
def test_tour_walks_into_the_building(tmp_path): ...   # fps 24.0; first frame (outside) differs from last (inside)
def test_tour_path_follows_the_floors(): ...   # tour_path over fixtures' route: every y == ground + 1.6 (±0.01)
def test_a_blank_scene_frame_is_kept(tmp_path): ...   # an invisible GLB: error 'blank', blankFrame index 0
def test_render_dispatches_scene_modes(tmp_path, monkeypatch): ...   # render.render with mode 'scale' calls scene_render.render
def test_studio_preview_on_a_scene_piece_writes_four_views(tmp_path): ...  # studio-preview out/furniture_chair -> front/right/back/left PNGs
```

- [ ] **Step 3: Run; expect FAIL.** `cd apps/studio-worker && bash scripts/fetch_babylon.sh && python3 -m pytest -q tests/test_scene_render.py`
- [ ] **Step 4: Implement.** The page exposes `window.__scene` with `load(files, items)` (base64 GLBs via Babylon's
  glTF loader; each item placed at its `at`), `orbit(alpha, beta)` relative moves on an ArcRotateCamera framed to the
  bounding box, `firstPerson(x, y, z, yaw, pitch)`, `mannequin(x, z)`, `frame()`. One hemispheric light at intensity 1
  and no shadows, approximating Decentraland's flat look; background `#5c6370`. `scene_render.py` follows `render.py`'s
  child-process-with-watchdog shape. `studio-preview` dispatches on the piece's `meta.kind`.
- [ ] **Step 5: Run; expect PASS**, then the whole worker suite.
- [ ] **Step 6: Commit** `feat(studio-worker): a Babylon renderer for buildings and furniture`.

### Task 4: Scene prompt, render and walk-through jobs

**Files:**
- Modify: `apps/studio-worker/studio_worker/jobs.py` (`_prompt_views`, `_render_job`, `_set_render`, `view_key`), `apps/studio-worker/CONTRACT.md`
- Test: `apps/studio-worker/tests/test_jobs.py`

**Interfaces:**
- Produces: view keys `orbit-scene` (Inspect), `scale` (furniture), `tour` (design level, `renders/set/tour/NNN.webp`).
  `_prompt_views('scene', piece)`: building → `[{'mode': 'scene-orbit', 'ring': True}]`; furniture or decor →
  `[{'mode': 'scale'}, {'mode': 'scene-orbit', 'ring': True}]`. Render job spec `{'categories', 'mode': 'orbit', 'ring'}`
  on a scene design renders `scene-orbit`; set spec `{'set': True, 'tour': True}` renders the tour with the furniture
  placed from `layout.json` (missing pieces skipped and named in the result's `warnings`), result
  `set: {'viewKey': 'tour', 'frames', 'fps'}`.
- Consumes: Task 1 `Piece.extras`, Task 3 modes and `tour_path`.

- [ ] **Step 1: Write the failing tests:** `test_scene_building_prompt_renders_the_inspect_ring`,
  `test_scene_furniture_prompt_renders_scale_and_ring`, `test_scene_orbit_render_job_full_sphere` (122 frames under
  `renders/building/orbit-scene/`), `test_tour_set_job_places_the_furniture` (the fake render receives the building and
  chair with `at` from layout; result `set['viewKey'] == 'tour'`), `test_tour_skips_a_missing_layout_piece_and_says_so`,
  `test_tour_without_a_building_is_an_error`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement**, and document the three view keys, the scene folders and extras in `CONTRACT.md`.
- [ ] **Step 4: Run; expect PASS**, then the whole worker suite.
- [ ] **Step 5: Commit** `feat(studio-worker): scene prompt views, Inspect and walk-through jobs`.

### Task 5: Scene packages, the skills pin and the image

**Files:**
- Modify: `apps/studio-worker/studio_worker/finalize.py`, `apps/studio-worker/Dockerfile`
- Test: `apps/studio-worker/tests/test_finalize.py`

**Interfaces:**
- Produces: a scene `final/<category>/package.zip` holding the GLB, `piece.json`, the piece's extras, `thumbnail.png`,
  `renders/` (the four scale or orbit views; a building's tour frames as `tour.mp4` when ffmpeg is present, else
  skipped), `REPORT.md` (sections: model check, walk check for buildings); and `final/<category>/thumbnail.png`
  uploaded beside it. No `builder.json`, `listing.json`, `item.zip` or clipping section.
- Consumes: Task 3 render modes; `THUMBNAIL_BLEND` (renders any GLB alone).

- [ ] **Step 1: Write the failing tests:** `test_scene_package_has_its_files_and_no_wearable_ones`,
  `test_scene_finalize_uploads_the_thumbnail_beside_the_package`, `test_a_building_report_has_the_walk_check`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement**; set `ARG SKILLS_SHA=a914875c0bba82a68783db8e0a6a0099200a94ce` and run
  `scripts/fetch_babylon.sh` in the Dockerfile.
- [ ] **Step 4: Run; expect PASS**, then the whole worker suite.
- [ ] **Step 5: Commit** `feat(studio-worker): scene packages; skills a914875; Babylon in the image`.

### Task 6: Server: the `scene` kind, its views and limits

**Files:**
- Create: `apps/server/src/studio/scene.ts`
- Modify: `apps/server/src/routes/studio.ts` (create, renders, set-renders), `apps/server/src/studio/designs.ts`
  (`renderPayload`, `requestOrbit`, `queueFullOrbit`, `designDetail`, prompt limits), `apps/server/src/studio/sets.ts`,
  `apps/server/src/studio/results.ts` (prompt branch)
- Test: `apps/server/test/studio-scene.test.ts`

**Interfaces:**
- Produces: `SCENE_CATEGORY = /^(building|furniture_[a-z0-9_]{1,32})$/`; `FOOTPRINTS` (as Global Constraints);
  `sceneOrbitKey = 'orbit-scene'`, `SCALE_KEY = 'scale'`, `TOUR_KEY = 'tour'`;
  `orbitKeyFor(kind: string, bodyShape: BodyShape): string` (`orbit-scene` for scene, else `orbitKey(bodyShape)`);
  `SCENE_PROMPT_LIMITS = { timeoutSec: 2700, maxTurns: 150, costCeilingUsd: 6 }` and `limitsFor(agent, kind)`
  (a building took a skilled agent about 18 minutes in testing);
  `setViews` for a scene design with a `building` piece: `[{ viewKey: 'tour' }]`, else `[]`.
- Consumes: worker view keys from Task 4.

- [ ] **Step 1: Write the failing tests:**
  - `POST /designs` with `kind: 'scene'` → 201, name `Untitled scene piece`; `kind: 'house'` → 400 `kind must be wearable, emote or scene`.
  - renders route: `category: 'furniture_chair'` on a scene design → 202; `category: 'hat'` on a scene design → 400;
    `furniture_chair` on a wearable design → 400; `mode: 'orbit'` on a scene design queues `orbit-scene`.
  - a scene prompt result with a changed building queues the `tour` set render, and one with only furniture changed
    and a building present queues it too; a design with no building queues none.
  - **Review Focus 4:** after the building's revision changes, `set-renders` for `tour` reports the old row stale and
    queues a new render (the revisions key differs).
  - a scene prompt job's payload carries `SCENE_PROMPT_LIMITS`.
  - renders route `mode: 'scale'` on a scene furniture piece queues a `scale` render (the retry when the prompt's
    failed); on a building or a wearable → 400 `unknown mode`.
- [ ] **Step 2: Run; expect FAIL.**
  Run: `cd apps/server && TEST_DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/<fresh db> npx vitest run test/studio-scene.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; expect PASS**, then the full server suite and `npx tsc --noEmit -p .`.
- [ ] **Step 5: Commit** `feat(studio): the scene design kind, its views and limits`.

### Task 7: Scene pricing and the gift cap

**Files:**
- Modify: `apps/server/src/config.ts` (`studioPrices`), `apps/server/src/studio/pricing.ts` (`priceLines`, `quoteFinalize`),
  `apps/server/src/studio/payments.ts` (Stripe line amounts, grant-time repricing), `apps/server/src/db/schema.ts` (`PaymentLine.giftCents?: number`)
- Test: `apps/server/test/studio-pricing.test.ts`, `apps/server/test/studio-payments.test.ts`

**Interfaces:**
- Produces: `studioPrices` gains `furniture` (900, `STUDIO_PRICE_FURNITURE_CENTS`), `furnitureExtra` (500,
  `STUDIO_PRICE_FURNITURE_EXTRA_CENTS`), `revisionFurniture` (500, `STUDIO_REVISION_FURNITURE_CENTS`),
  `buildingSmall`/`buildingMedium`/`buildingLarge` (2900/4900/7900, `STUDIO_PRICE_BUILDING_{SMALL,MEDIUM,LARGE}_CENTS`),
  `revisionBuildingSmall`/`Medium`/`Large` (1500/2500/4000, `STUDIO_REVISION_BUILDING_{SMALL,MEDIUM,LARGE}_CENTS`),
  `giftCapCents` (2900, `STUDIO_GIFT_CAP_CENTS`). Tiers: small = 0.5x0.5, 1x1; medium = 1x2, 2x2; large = 4x4.
  `priceLines(designKind, pieces: { kind: 'first' | 'revision'; category: string; footprint?: string }[], designHasFirst)`;
  a gift line has `gift: true` and `giftCents = min(amountCents, giftCapCents)`; a line charges
  `amountCents - (giftCents ?? 0)` (an old line with `gift: true` and no `giftCents` charges 0).
- Consumes: the revision's `meta.footprint` (piece.json) for buildings.

- [ ] **Step 1: Write the failing tests** (each with its exact total):
  - furniture alone: chair + table first finalize → `[900, 500]`; a third piece later → `[500]`; a chair revision → `[500]`.
  - building 1x1 + two chairs in one checkout → `[2900, 500, 500]`; a 4x4 alone → `[7900]`; a 2x2 → `[4900]`.
  - furniture finalized at 900, then a building added later → building `[2900]`, the earlier 900 untouched.
  - a 1x1 revised into a 2x2 → revision `[2500]`.
  - a gift on a 4x4 → total 5000 with `giftCents: 2900`; on a chair → total 0 with `giftCents: 900`.
  - wearable and emote quotes unchanged (the existing tests still pass).
  - payments: a Stripe session for a gifted 4x4 has one line of 5000; grant-time repricing keeps it.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; expect PASS**, then the full server suite and tsc.
- [ ] **Step 5: Commit** `feat(studio): scene prices, and a gift covers up to $29`.

### Task 8: Finalized scene pieces into the asset library

**Files:**
- Create: `apps/server/src/studio/library.ts`
- Modify: `apps/server/src/db/schema.ts` (`assetLibraryItems.sittables jsonb`, `studioEntitlements.assetItemIds jsonb`),
  `apps/server/src/studio/store.ts` (`final/<category>/thumbnail.png`), `apps/server/src/routes/studio-worker.ts`
  (a finalize job may upload it), `apps/server/src/studio/results.ts` (after the finalize branch commits),
  the Design Studio sweep (`addMissingLibraryRows`), `apps/server/entrypoint.sh` (fallback `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for both columns)
- Test: `apps/server/test/studio-library.test.ts`

**Interfaces:**
- Produces: `addToLibrary(entitlementId: string, now: Date): Promise<string[]>` (the new asset ids; returns the stored
  ids without copying again when `assetItemIds` is set); `addMissingLibraryRows(now: Date): Promise<number>` for the
  sweep. Each row: `name` (piece name, `"<name> (revision <n>)"` from revision 2), `description`, `category`
  (`building` | `furniture`), `tags` (`[type]`), `storageKey` `assets/<ownerId>/<uuid>.glb`, `cdnUrl`, `thumbnailUrl`
  (the finalize thumbnail copied to `assets/<ownerId>/<uuid>.png`), `fileSizeBytes`, `triangleCount` and `dimensions`
  from `glbStats`, `isPublic: false`, `uploadedBy: ownerId`, `sourceRef: 'studio:<entitlementId>:<glb file name>'`,
  `sittables` (the parsed `*.sittables.json`, else null). Paid pieces don't count against the upload storage quota.
- Consumes: Task 5's thumbnail path; the revision's `files`; `glbStats` (`apps/server/src/catalog/glb-stats.ts`).

- [ ] **Step 1: Write the failing tests:**
  - a finalized chair → one private row owned by the designer, triangles and dimensions from the GLB, the thumbnail
    URL set, `sittables` equal to the uploaded JSON; the entitlement's `assetItemIds` holds its id.
  - calling it twice adds nothing the second time.
  - a revision 2 finalize adds a second row named `Neon Chair (revision 2)` and leaves the first.
  - a wearable finalize adds no row.
  - **Review Focus 5:** the public store throws on upload → the entitlement stays `ready`, the package route still
    streams, `assetItemIds` stays null; the sweep run after the store recovers adds the row.
  - the finalize route accepts `final/furniture_chair/thumbnail.png` from a finalize job and refuses it from a prompt job.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; expect PASS**, then the full server suite and tsc.
- [ ] **Step 5: Commit** `feat(studio): finalized buildings and furniture land in the asset library`.

### Task 9: Web: the kind, the steps and the warnings

**Files:**
- Modify: `apps/web/src/lib/studio.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/app/(dashboard)/studio/page.tsx`,
  `apps/web/src/app/(dashboard)/studio/[designId]/Preview.tsx`, `apps/web/src/app/(dashboard)/studio/[designId]/Finalize.tsx`
- Create: `apps/web/src/app/(dashboard)/studio/[designId]/TourStep.tsx`
- Test: `apps/web/src/lib/studio-steps.test.ts`, `apps/web/src/lib/studio.test.ts`

**Interfaces:**
- Produces: `StudioKind = 'wearable' | 'emote' | 'scene'`; `STEPS` gains `tour` ('Walk-through') and `scale` ('Scale');
  `stepsFor(kind, categories: string[]): Step[]` (scene: `design, inspect, tour` when a `building` exists, `scale` when a
  `furniture_*` exists, `finalize`); `pieceLabel(category)` (`building` → `Building`, `furniture_round_table` →
  `Round table`); `orbitKeyFor(kind, bodyShape)` matching the server; `triangleWarning(name, checker)` → `"<name> has
  <n> triangles, more than the <limit> recommended. It still works in Decentraland, but a lighter piece leaves room for
  the rest of the scene."` or null.
- Consumes: server view keys (Task 6), prices from the quote (Task 7), `checker.triangles` (Task 1).

- [ ] **Step 1: Write the failing tests:** `stepsFor('scene', ['building'])` → `['design','inspect','tour','finalize']`;
  `stepsFor('scene', ['furniture_chair'])` → `['design','inspect','scale','finalize']`; both → all five; wearable and
  emote steps unchanged; `pieceLabel` cases; `triangleWarning` cases; the picker offers `Building or furniture`.
- [ ] **Step 2: Run; expect FAIL.** `cd apps/web && npx vitest run src/lib`
- [ ] **Step 3: Implement.** `TourStep` requests the `tour` set render and plays its frames with `SpinStage` at the
  result's fps (Loading / Rendering / Try again, as `EmotesStep`). Scale shows the piece's `scale` frames in
  `SpinStage`. A finalized scene piece's line in Finalize says "Added to your asset library" with a link to `/assets`.
  The design list labels the kind `Building or furniture`.
- [ ] **Step 4: Run; expect PASS**, then the whole web suite and `npx tsc --noEmit -p .`.
- [ ] **Step 5: Commit** `feat(web): design buildings and furniture in the studio`.

### Task 10: End to end on Fly

**Files:**
- Modify: `apps/studio-worker/e2e/real_prompt.py` (`--scene`), `apps/studio-worker/e2e/fly.sh` (a scene run)

- [ ] **Step 1:** `real_prompt.py --scene` prompts Codex for "a small 0.5x0.5 kiosk you can walk into, and one stool",
  then checks: both pieces collected, checker pass, 24 non-blank `orbit-scene` frames each, 36 `scale` frames for the
  stool, a `tour` set render with fps 24 and no blank frame, and a finalize producing both packages and thumbnails.
- [ ] **Step 2:** Build the image (`fly deploy --build-only --push --remote-only --image-label <sha>` from
  `.worktrees/hud-test/apps/studio-worker`, where the avatar `.blend` assets are) and run `bash e2e/fly.sh <image>`.
  Expected: `E2E-PASSED`. Look at the tour frames by eye.
- [ ] **Step 3: Commit** `test(studio-worker): scene end to end on Fly`.
