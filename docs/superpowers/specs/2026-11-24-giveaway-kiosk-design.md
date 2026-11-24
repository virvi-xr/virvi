# Giveaway kiosk: design

Owner request, 2026-11-24. Old VLM had a claim point that hosts placed in a scene: a POAP-style booth with colors and
an image you could customize. Visitors walked up, clicked a button and claimed a wearable. The owner wants this back on
top of LIV-194 automatic giveaways. Owner decisions are marked **(owner)**. Calls I made are marked **(my call)**.

## What it is

A **Giveaway kiosk** is a new scene element (`claim_point`) that a host places and positions like any other element.
It is linked to one of the host's automatic giveaways. Clicking it in the scene opens the existing LIV-194 giveaway
claim card (`packages/adapter-dcl/src/giveaway/`). Claims, consent, minting and gas all stay exactly as they are.

## Display: every old VLM option is kept (owner)

The kiosk shows the giveaway item in one of four ways (`claimPointType`, enum `ClaimPointType` in
`packages/shared/src/enums/index.ts`):

1. `MARKETPLACE_IMAGE`: the giveaway's first item thumbnail (cached on `giveaway_items`).
2. `CUSTOM_IMAGE`: an image the host picks (`imgSrc`).
3. `MODEL`: a 3D model the host picks (`modelSrc`).
4. `MANNEQUIN`: an avatar wearing the giveaway's wearables (`mannequinType`: `MALE`, `FEMALE` or `MATCH_PLAYER`, which
   copies the visitor's own avatar). On Decentraland this is an `AvatarShape` with the items' wearable URNs.

**The booth is optional (owner)** (`enableKiosk`). When it's on, the item sits in a booth built from primitives,
colored with `color1`, `color2` and `color3` (roof and sides, panel, counter), plus an optional booth image
(`kioskImgSrc`, a banner on the booth). When it's off, the item stands on its own.

**Other settings:**
- `enableSpin`: the item spins.
- `hoverText`: the pointer hover text. It defaults to "Claim".
- `itemYOffset` and `itemScale`: where the item sits and how big it is.

All of these already exist in `ClaimPointProperties` (`packages/shared/src/types/elements.ts`). Keep those names. The
exact booth geometry is the builder's choice, but it must read as a POAP booth: a roof sign, a display panel and a
counter, with a visible Claim button.

## Behaviour (my calls)

- **Click:** opens the giveaway card for the kiosk's giveaway. In a scene that has a kiosk, the card no longer pops up
  by itself: it opens when the visitor clicks a kiosk, and closes the way it does today. A scene with no kiosk keeps
  today's behaviour.
- **One giveaway per scene:** a scene shows one current giveaway (`GET …/giveaway/current`). A kiosk whose
  `giveawayId` isn't the scene's current open giveaway still renders, but a click shows that nothing is available
  ("Not open right now"). That covers disabled giveaways, ended ones, and ones linked to another scene.
- **Linking:** when a host picks a giveaway for a kiosk, the server links that giveaway to the scene (`giveaway_scenes`)
  if it isn't linked yet. Only giveaways the host can manage can be picked: use the same owner and admin rules as the
  Drops routes. Any other `giveawayId` is refused with 403 or 404, the way the cross-account walk expects.
- **Studio editor:** add "Giveaway kiosk" to the scene editor's add-element choices. Its property panel holds the
  giveaway picker (the host's giveaways), the display type, the images, the model, the mannequin type, the booth toggle,
  the three color pickers, the spin toggle, the hover text, the height offset and the scale. Reuse the existing image,
  model and color pickers that other elements use. Use plain-English copy, and call it a "kiosk", never a "claim
  point".
- **Platforms:** Decentraland renders it. Other adapters (Hyperfy and others) ignore the element type without crashing.
- **Guests:** clicking shows the existing guest "Connect a wallet" notice.

## Known gaps to fix on the way

- `apps/server/src/db/schema.ts` `elementTypeEnum` has no `claim_point`. Add it with a migration, following the repo's
  migration convention.
- `apps/server/src/services/scene-serializer.ts:148` filters `byType('claimpoint')`. That is a bug: the type is
  `claim_point`.
- `ELEMENT_TYPES` in `apps/server/src/assistant/tools/write.ts`, the type union in `apps/server/src/routes/scenes.ts`,
  `permissions.ts` (the permission category) and the backup/snapshot code all need the new type wherever a sibling type
  like `ad_space` or `nft` appears. Use `git show 3cb8e397` (how `ad_space` was added) as the map.

## Shipping

- A runtime version bump for Virvi-built scenes, the same way LIV-194 bumped it (runtime v17 → v18). Rebuild
  `apps/server/dcl-runtime`.
- A `@virvixr/dcl` minor version bump. The owner publishes to npm, so don't publish.
- Docs: add a short section to `apps/docs/src/content/docs/dashboard/drops.md` on placing a kiosk.

## Not in scope

- Kiosks for raffles or BEATs.
- Multiple open giveaways per scene.
