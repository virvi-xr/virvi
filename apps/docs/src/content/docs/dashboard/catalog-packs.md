---
title: Catalog Packs
description: Free, ready-made 3D models from open-source collections, added to your scenes without using storage.
---

The **3D Asset Library** in the dashboard includes Virvi's catalog: free models from open-source collections by Mr Dhingia, the Last Slice In World Builder artists, and Decentraland's asset packs. Each collection is split into **packs** (one per artist or theme).

## Finding models

Filter the library by:

- **Style**: Cyberpunk, Sci-Fi, Fantasy, Western, Modern and so on.
- **Venue**: where a model fits, such as café, club, gallery, shop or beach. One model can fit several venues.
- **Category**: what the object is (Furniture, Lighting, Building, Decor…).
- **Pack**: one collection.

Each catalog model shows its artist, pack and license.

## Adding a model to a scene

Open a model and choose **Add to scene**. It appears in that scene's library (the **Media Library** panel in the in-world HUD), ready to place. See [Media Library and 3D Asset Library](/dashboard/media-library/).

Catalog models are hosted by Virvi and only linked into your scene, so they **never count toward your storage**.

## Credits

The public [credits page](/credits) lists every pack with its artists, license and source link, including the full MIT notice for Mr Dhingia's models.

## For admins: switching packs off

**Admin → Catalog packs** lists every pack with its model count and an on/off switch.

- **Off:** the pack's models disappear from the catalog right away, and nobody can add them to a scene. Models already in scenes or scene libraries keep working.
- **On:** they're back.

## For operators: importing

Packs and models are loaded with a one-off importer from tag files checked into the repo:

- `catalog/packs.json`: every pack's id, name, source, license, attribution and source link.
- `catalog/tags/<source>.json`: one row per model, with its file, thumbnail, name, artist, style, category, venue tags and a confidence score.

The tag files are drafted with `node scripts/catalog/draft-tags.mjs <repos-dir>` from shallow clones of the source repos. Missing thumbnails are rendered with `blender -b --factory-startup -P scripts/catalog/render-thumbs.py -- <repos-dir> catalog/review/render-list.json`.

The import itself:

```sh
# Validate only (no database needed)
pnpm --filter @virvixr/server catalog:import catalog/tags/decentraland.json --check

# Import into the configured database and storage
pnpm --filter @virvixr/server catalog:import catalog/tags/decentraland.json <repos-dir>
pnpm --filter @virvixr/server catalog:import catalog/tags/dhingia.json <repos-dir>
pnpm --filter @virvixr/server catalog:import catalog/tags/last-slice.json <repos-dir>
```

Import Decentraland first. When two packs carry the same file, the first import keeps it, and later duplicates are skipped and reported.

Re-running an import is safe: it updates models in place (same id and URL when the file is unchanged), never duplicates them, and never switches a pack back on. Files that can't be read are reported and skipped.
