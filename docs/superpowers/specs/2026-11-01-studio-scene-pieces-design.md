# Design Studio: buildings and furnishings

**Status:** draft for the owner's approval. Marks: **(owner)** the owner decided it; **(call)** the author's call, open
to change.

## Intent

Someone building a scene in Virvi wants a building or a piece of furniture the catalog doesn't have **(owner)**. Today
the Design Studio only makes wearables and emotes, and the agents that build them have skills for avatars only. This
design adds two things, in this order **(owner)**:

1. **Skills** for creating low-poly buildings and furnishings to Decentraland's standards, in the owner's
   `dcl-avatar-skills` repo next to the wearable and emote skills. They stand alone: anyone can use them with Claude
   Code, Codex or Grok Build on their own builds.
2. **A Design Studio update** so people can design buildings and furnishings as well as wearables and emotes. They
   describe the piece, an agent builds it with those skills, they check it from every angle and walk through it, and
   when they finalize (paying, as wearables do) it lands in their private asset library, ready to place in their scene
   **(owner)**.

This document is the design for both. The skills get built first; the Studio update gets a written plan for the owner
to approve before any of it is built **(owner)**.

## What was found (2026-11-01)

- **Decentraland's scene limits are soft except storage.** Triangles (`n × 10,000` for n parcels), entities
  (`n × 200`), bodies (`n × 300`), materials (`log2(n+1) × 20`), textures (`log2(n+1) × 10`) and height (330 m) only warn
  in the Creator Hub and cost performance. Deploys are refused only for total size (15 MB a parcel, 300 MB max), file
  count (200 a parcel) and file size (50 MB). Virvi now matches: triangles only warn (shipped today).
- **Colliders** (docs, 3d-modeling/colliders): a mesh whose name ends in `_collider` is invisible collision (`_box`,
  `_sphere`, `_capsule` after it mark primitives). Prefer boxes; keep arbitrary collider meshes convex; a single plane
  blocks from one side only. Players step up about 40 cm without jumping (45 cm needs a jump); comfortable steps are
  ≤25 cm high and ≥30 cm deep; walkable slopes go to 46°, comfortable ≤30°; put a ramp collider over stairs. The docs
  say nothing about doors.
- **Materials and textures** (docs): textures power of two, at most 1024 px (the explorer compresses to 1024 anyway);
  each material is a draw call, so share and atlas them; alpha clip over blend; emission glows but lights nothing;
  vertex colours aren't supported; backface culling on except true double-sided parts.
- **The owner's best pieces** (measured): The Silt's stools and bar tables are 400–1,400 triangles and ~20 KB with
  flat-colour materials (6 each, one per colour). The MetaPetal cat cafe was built entirely from Python scripts with one
  256 px swatch texture shared by every solid-coloured surface (one material a model, plus a metallic twin), 170
  `_collider` meshes in its interior, a separate `door-leaf.glb`, and its own limits checker. The MetaPetal HQ sofas have
  the look the owner likes but were meant to be low-poly and aren't (~40,000 triangles, 8 materials, 1.4–1.9 MB): the
  style is the target, the weight isn't **(owner)**.
- **dcl-lounge-kit's `dcl-sittables`** already defines what a sittable piece needs (`docs/custom-furniture.md`): origin on
  the floor under its middle, Y-up, facing +Z at facing 0, and per seat `across / forward / rise` plus an orb position,
  tuned to Decentraland's `sittingChair1/2` emotes (the hips end 0.64 m up and 0.37 m behind where the avatar stands).
  Nothing may collide where the sitter stands; tall stools need `collision: 'stool'`.
- **Virvi today:** a user's own models and the public catalog share `asset_library_items` (user rows: `uploadedBy` set,
  `isPublic` false). Nothing moves a finalized Studio piece into it; paid files leave only as a package download. The
  upload route never parses a GLB (triangles and size are trusted from the browser) and uploaded models get no thumbnail.
  Only room-scan GLBs ship `_collider` meshes. `studio_designs.kind` is free text validated as `wearable | emote`, and
  kind branches in pricing, routes, the worker's `instructions.closing()`, `pieces.collect/check`, render modes,
  `finalize._package` and the web steps.

## Goals

### The skills

- **Two new skills** in `dcl-avatar-skills`, laid out like `creating-dcl-wearables` (a `SKILL.md` with workflow, a
  quick-reference limits table and recurring pitfalls; a sourced `requirements.md`; a `lessons.md`; a `scripts/` checker
  the agent must pass) **(owner)**:
  - **`creating-dcl-buildings`:** walk-in buildings sized in parcels: 0.5×0.5, 1×1, 1×2, 2×2 or 4×4 **(owner)**, with
    doors and stairs visitors can use **(owner)**.
  - **`creating-dcl-furnishings`:** chairs, couches, tables, shelves, lamps, decor.
- **Low-poly, with the MetaPetal sofa's style:** soft, cushioned, characterful shapes at stool-like weights **(owner)**.
- **Shared conventions** **(call)**: metres; +Y up; origin on the floor under the middle of the footprint; front faces +Z;
  transforms applied; one shared swatch texture for solid colours (the cafe's approach) so most pieces need one or two
  materials, plus a metallic, glass or emissive material only when the look needs it; textures power of two, ≤1024 px;
  collider meshes named `*_collider` (primitives preferred), no material, kept convex.
- **Triangles are guidance, never a FAIL** **(owner)**: the checker reports them against a recommended budget and warns
  over it. Recommended **(call)**: chair or stool 300–800, couch up to 1,500, table up to 800, small decor up to 300; a
  building about 30% of its footprint's scene budget (1×1 ≈ 3,000, 2×2 ≈ 12,000, 4×4 ≈ 48,000), leaving room for
  furniture and everything else in the scene.
- **Buildings are walkable** **(owner)**: walls block from both sides (closed boxes, not planes); floors and upper floors
  have colliders; stairs ≤25 cm a step and ≥30 cm deep, under a ramp collider ≤40°; doorways at least 1 m wide and
  2.2 m high **(call)**; nothing a visitor can get stuck in.
- **Doors** **(call)**: open doorways by default. A door leaf, when wanted, is a separate GLB (as the cafe's
  `door-leaf.glb`), hinged at its own origin, so a future door kit can swing it. The skill doesn't animate it.
- **Seating works with `dcl-sittables`** **(owner: kits handle behaviour; seating is the kit that exists)**: anything
  sittable ships a `sittables.json` beside its GLB holding a `FurnitureModel` (file, scale, uprightX, yawOffset,
  collision, kind, seats) with seats placed by the kit's rules, and its colliders stop short of every seat's standing
  spot.
- **Checkers that test what goes wrong**, each proven on a known-bad file first (the repo's rule):
  `check_scene_model.py <glb> --kind building|furniture [--footprint 1x1]` FAILs on: a missing or materialed collider; a
  collider that isn't closed or isn't convex; origin off the floor or off the footprint's middle; a model outside its
  footprint (buildings) or taller than 330 m; a texture that isn't a power of two or is over 1024; file over the hard
  limit; a `sittables.json` that doesn't parse, or a seat whose standing spot is inside a collider. It WARNs on
  triangles, materials and textures over the recommended counts, BLEND where MASK would do, and backface culling off.
  Buildings also get `check_walk.py` (below) for stairs, ramps and doorways.
- **`shaping-dcl-item-ideas`** gains a section for scene pieces (footprint, walk-in or not, rooms and floors, seating,
  furnished or not, style) instead of a new shaping skill **(call)**.
- The README and `install.sh` cover the new skills; the repo keeps its name for now **(call)**.

### The Studio update

- **A third design kind for scene pieces** **(call: `scene`)**. A design can hold one building and its furniture, or
  furniture alone, designed together **(owner)**. Each piece is a category: `building`, or `furniture` with a free-text
  type (chair, couch, table, lamp…) **(call)**.
- **Steps** for a scene design: **Design → Inspect → Walk-through** (buildings) **or Scale** (furniture only) **→
  Finalize** **(owner for Inspect and the walk-through; call for Scale)**.
  - **Design:** the same conversation. The agent settles building or furniture, and for a building its footprint.
  - **Inspect:** each piece alone from every direction, as wearables work now: rendered frames, never the model
    **(owner)**.
  - **Walk-through:** a first-person video at eye height (~1.6 m) through the building **(owner)**, furnished when the
    design has furniture **(owner: designed together)**. The agent writes the route (waypoints in the building's frame:
    in at the door, through every room, up every stair) **(call)**. The worker walks it against the colliders the way an
    avatar moves (step ≤40 cm, slope ≤46°, a capsule ~0.6 m wide and ~1.8 m tall that can't pass a collider) before
    rendering; a route that can't be walked is a checker FAIL the agent must fix, so the person never sees a video of
    walking through a wall **(call)**. Two checks, two weights **(call)**: the building alone must be walkable (a FAIL
    that blocks its finalize); the furnished walk counts furniture colliders too, and a failure there sends the agent
    back to rearrange, but if it persists it's only a warning, since the arrangement is a preview and never blocks a
    building that's fine on its own.
  - **Scale:** each furniture piece on a floor beside a standing avatar, from a few angles, so a chair reads as
    chair-sized **(call)**.
  - **Finalize:** as wearables, with the prices below **(owner)**.
- **The model never leaves before payment** **(owner)**: every preview is rendered on the worker; no GLB and nothing a
  browser could turn back into one reaches it before finalize.
- **A scene renderer on the worker** **(call)**: Decentraland's wearable-preview only renders wearables on an avatar, so
  the worker gets its own small page (Babylon, the engine Decentraland's preview uses) that loads a GLB with flat,
  Decentraland-like lighting, and renders orbit (Inspect), scale and walk views as frames the existing frame routes
  serve.
- **Finalize puts each piece in the person's asset library** **(owner)**: one private row per piece (`uploadedBy` the
  person, `isPublic` false, category `building` or `furniture`), the GLB on the CDN, triangles, size and file size read
  from the GLB itself (the server's `glbStats`, never trusted from the browser), and the finalize thumbnail. The package
  stays downloadable as wearables' are: GLBs, door leaves, `sittables.json`, renders, the walk-through video and a report
  **(call)**.
- **The seat description travels with the library item** **(owner: sittable at the asset level, worked out later)**:
  a sittable piece's `sittables.json` is kept with its library row (stored with the asset, not only in the package), so
  a later "sittable in Virvi" feature can seat people on pieces finalized before it exists. Nothing in Virvi's scene
  runtime seats anyone in this version.
- **A door leaf gets its own library row** (placeable as a static door) as well as going in the package **(call)**.
- **A finalized revision adds a new library row** and leaves the old one, so a scene already using a piece doesn't
  change under its owner **(call)**.
- **Prices** **(owner, from the author's recommendation)**, as settings (`studioPrices`):

  | Piece | First | Each extra in the same design | Revision |
  |---|---|---|---|
  | Furniture | $9 | $5 | $5 |
  | Building, 0.5×0.5 or 1×1 | $29 | — | $15 |
  | Building, 1×2 or 2×2 | $49 | — | $25 |
  | Building, 4×4 | $79 | — | $40 |

  Furniture in a design with a building is priced as extra pieces. Prompt allowances and top-ups are unchanged.
  How these combine with today's checkout rules **(call)**:
  - Charges already paid stand: furniture finalized at $9 before a building existed isn't repriced when one is added.
    "Extra" means the same rule as wearables today (any piece after the design's first paid piece).
  - A revision is priced by the building's footprint as revised: a 1×1 revised into a 2×2 is a $25 revision.
  - A gift credit covers a first finalize up to $29 (furniture, or a building up to 1×1); on a bigger building it takes
    $29 off.
- **At most one building and 12 furniture pieces a design** **(call)**, so a prompt's work, its checks and its renders
  stay predictable; prompts change several pieces at once, as wearable sets do today.
- **Soft limits warn, never block** **(owner)**: a piece over its recommended triangles shows a warning on its tab and in
  Finalize, as scenes do; only the checker's FAILs (colliders, walkability, hard file limits) block a finalize.

## Non-goals (first version)

- Behaviour beyond seating: doors that open, lamps that switch, anything interactive. That comes later as kits, like
  `dcl-cat-kit` and `dcl-lounge-kit` **(owner)**.
- Sitting in Virvi scenes: making a placed asset sittable (storing seats per asset, the kit in Virvi's Decentraland
  runtime, seats that follow a resized or rotated piece) is its own later design **(owner)**. This version only keeps
  the seat data ready for it.
- "Add furnished": placing a building and its furniture in one go as the agent arranged them. The first version places
  each piece on its own **(call)**.
- Selling scene pieces to other users, or publishing them to the public catalog.
- An interactive walk-through in the browser (it would need the model there) **(owner: keep the rule)**.
- Fixing the asset upload route's trust in browser-sent triangle counts, or thumbnails for uploads. Noticed, separate.
- Curation-style review: scene pieces aren't Marketplace items.

## Anti-goals

- A walk-through that shows walking through walls or floating up stairs: the route must be walkable by the colliders.
- Pieces as heavy as the MetaPetal sofas: the style, not the weight.
- Blocking anyone on triangles, entities, materials or textures.
- A chair whose collider pushes the sitter off.

## Constraints

- The Studio worker image installs the skills from `dcl-avatar-skills` at a pinned commit (`SKILLS_SHA`, via
  `install.sh claude codex`); the new skills reach the Studio by bumping that pin.
- Agents work in Blender (the worker's), scripting builds so every fix is repeatable, as the wearable skill requires.
- Deploy order stays: worker image before server.

## Left to the builder

- The checker's internals and the walk simulation's exact method (capsule sweep, step logic), within the numbers above.
- Walk-through pacing and length, frame rate and resolution, within "short waits" as the preview steps do.
- The scene renderer's camera framing for buildings of each footprint, and the scale view's avatar (a static export of
  the base avatar is fine).
- Database shape for footprint, piece type and layout; the route and layout file formats.
- How Inspect handles a 4×4 building (more distance, same frame grid).
