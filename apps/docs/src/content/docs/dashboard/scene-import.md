---
title: Scene Import
description: Bring a Decentraland scene into Virvi and deploy it to a World or to Genesis City parcels.
---

Scene Import takes a Decentraland scene you built elsewhere (the Creator Hub or the SDK7) and deploys it from Virvi, so Virvi's ads, analytics and live controls can run in it.

## Upload your scene
Upload the scene's project folder from the Creator Hub or an SDK7 project. Virvi builds it in an isolated environment and reads `scene.json` to find where it goes.

## Worlds and Genesis City
What `scene.json` says decides the destination:

- **Worlds:** a scene with a World name deploys to that World.
- **Genesis City:** a scene with parcels deploys to those parcels.

## Virvi models on the map
When an upload deploys with Virvi models placed in-world, Virvi adds `virvi/placements.json` next to your files. Your code can then place those models before it connects, so they show up on the Decentraland map and in the distant view. Call `await placeDeployedModels()` before `createVirvi()`: see [Show your Virvi models on the Decentraland map](/docs/sdk/decentraland/install/#show-your-virvi-models-on-the-decentraland-map). The file counts towards the scene's file and storage limits, like the models themselves.

## Thumbnail
Importing a World scene takes its own thumbnail, `display.navmapThumbnail` in `scene.json`, as the Virvi scene's thumbnail: it shows on your Scenes list straight away. It can be a file in the scene (a path like `images/thumbnail.png`) or an `https://` link, which Virvi downloads (public addresses only, at most 2 MB). It must be a PNG, JPEG or WebP of at least 64 × 64 px; it is kept in its own shape, never cropped, scaled down only to fit 1920 × 1920, and counts towards your storage. A thumbnail that is missing, isn't an image, points outside the scene folder, can't be downloaded or would go over your storage limit is skipped, and the import page says why; the import itself carries on. The import page shows the thumbnail it picked up with **Replace**, which opens the thumbnail upload. Genesis City parcel imports don't take a thumbnail yet.

Uploading again replaces a thumbnail that came from an earlier import, and removes it when your `scene.json` no longer names one; if the one it names can't be used, the earlier one stays. A thumbnail you uploaded in Virvi is never replaced or removed by an upload. Removing an imported scene's own thumbnail in Virvi changes nothing in Decentraland. A thumbnail taken from your `scene.json` isn't added to the deployment: your scene already has it, and deploys as built.

A thumbnail you upload in Virvi (**Settings** on the scene's page, or **Replace** on the import page) is added to the deployment, and the deployed `scene.json` gets `display.navmapThumbnail` pointing at it; nothing else in it changes. If your `scene.json` had a `navmapThumbnail` of its own, Virvi's replaces it. The image counts towards the scene's file and storage limits.

Removing the thumbnail in Virvi takes it out on the next deploy, and leaves the scene with no thumbnail: your own `navmapThumbnail` comes back only the next time you deploy an upload. A World built outside Virvi and connected to a scene (not uploaded) works the same way, except that Virvi never redeploys your own scene.json, so its thumbnail doesn't come back until you deploy it yourself.

## Who can sign for parcels
Deploying to parcels is signed with a wallet that can deploy to every parcel in the scene. Any verified wallet on your account that is, for each parcel, one of these will do:

- the owner
- the operator
- the update operator
- an update manager
- a wallet the owner approved for all of their land

Estate parcels count through the estate's owner and operators. If no single wallet covers every parcel, split the scene or sign with the wallet that does.

## Make Virvi an operator (optional)
By default you sign each deploy in your browser. If you would rather let Virvi deploy for you, you can make Virvi an operator on your parcels.

- It is an Ethereum mainnet transaction, so it costs gas, once.
- You can undo it with a second transaction, from the same page.
- It replaces an existing update operator on those parcels.
- Estate parcels are granted per parcel, not estate-wide.

After the transaction confirms, press **Check again** and Virvi starts deploying for you. If you left before it confirmed, come back to the deploy page and press **Let Virvi deploy**: that step is free, with no transaction.

To sign each deploy yourself again, press **Sign each deploy myself**. That is free too, and Virvi stays an operator on-chain until you remove it with **Remove Virvi as operator** (a second transaction).

Only the parcels' owner, operator or a wallet approved for all their land can send these transactions. An update operator can still press **Let Virvi deploy** once the owner has made Virvi an operator.

## Aetheria parcels
Aetheria parcels are managed by their deed. Sign with the deed holder's wallet. The operator option is not offered for them.

## Download what went live
After a deploy, use **Download what went live** to get the exact files that were deployed.

## Your backup without Virvi
Use **Download backup (no Virvi)** to get your scene as a Decentraland project that runs on its own. The button sits beside **Download what went live** on the Import page and on the deploy cards. It is on every plan, and it works for imported scenes (your scene plus the baked content) and for scenes built in Virvi (the baked content alone). For a scene built in Virvi, a deploy card's button places the project at that card's World or parcels.

**Who gets your scene's own code.** Anyone who can edit the scene can download a backup, but the scene's own code (what was imported) is only in it for the person who imported it and for full-access members. Other editors get the baked content alone, and the README says the scene's code was left out.

**When Virvi no longer has your code.** If the imported scene's files have been deleted, or its import never deployed, the backup holds only the baked content, and the README opens with a warning: deploying it as it is would replace your scene's code. Copy `src/virvi-baked.ts` (and the files it uses) into your own project instead.

**What is in it**
- Only the live preset, as it is now.
- Models, images, video screens, sounds and ad spaces. Ad spaces come as empty slots at the ad's shape (with the space's own fallback image, if it has one), never the current advertiser's creative.
- A `README.md` saying what was and wasn't carried over. When needed, an `ATTRIBUTION.md` (when MIT-licensed catalog items are bundled) and a `MISSING-ASSETS.md` (when some files must be added by hand).

**Bundled, referenced or linked**
- Bundled: files you uploaded and catalog items under the MIT license are in the project, and `ATTRIBUTION.md` credits each MIT pack.
- Referenced: catalog items whose license doesn't allow bundling (such as CC BY-NC) or doesn't say (most of the catalog, including all the Decentraland Builder packs) are not included. The project points at the local path each file would have, and `MISSING-ASSETS.md` lists where to get each one. Add the files there before you build.
- Links: live streams, files hosted outside Virvi, and Virvi-hosted files that don't exactly match one of your uploads or a library item stay as links to their address. A link on Virvi's servers stops loading if Virvi removes the file, so download it into the project and change its address if you want to keep it. A video or sound over Decentraland's 50 MB file limit is linked the same way, and the README lists it.

Click events (for example a button that opens a link or plays a sound) are not baked in. A sound clip does not start by itself.

**Size limit.** A backup can be at most 500 MB. If yours is bigger, Virvi names the largest files so you can shrink or remove them.

**Deploy it yourself**
1. Unzip the project and add any files listed in `MISSING-ASSETS.md`.
2. If the README lists your own Virvi code (files that still import Virvi's package), remove that code before you build: the project doesn't install the package.
3. Run `npm install`, then `npx @dcl/sdk-commands build`.
4. Test with `npx @dcl/sdk-commands start`, then deploy with `npx @dcl/sdk-commands deploy` using the wallet that owns your World or parcels. For a World, add `--target-content https://worlds-content-server.decentraland.org`.

To import the backup into Virvi again, first remove the `bakeVirviContent()` call from `main()`, or everything Virvi placed shows twice.
