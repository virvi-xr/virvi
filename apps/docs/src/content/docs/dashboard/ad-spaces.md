---
title: Ad Spaces
description: Panels in your scene that show ads, how to place them, and what visitors see.
---

An **ad space** is a flat panel in your scene that shows ads from Virvi. Ads are images or videos. Visitors can click an ad to open its link. Every ad carries a small **Ad** label.

Buying ads and owner payouts are coming later. For now, ads are set up by Virvi admins.

## Adding an ad space

1. Open your scene in the dashboard and go to the **Ad spaces** tab.
2. Add an ad space. It starts as a 16:9 panel that shows images and video.
3. Place it in the world, in the dashboard or with the in-world HUD, like any other element.

Each ad space can have several instances, so one setup can appear in more than one spot.

## Shape

Every ad space has exactly one shape:

- **16:9 landscape**
- **1:1 square**
- **9:16 portrait**
- **2:5 tall**

An ad only shows in a space with its exact shape. Ads are never stretched or cropped. If no ad fits your shape, the space shows its fallback image instead.

The space's height follows its width and shape. Set the width (the X scale) and the height is worked out from the shape, so ads always keep their proportions. A panel whose shorter side is under half a metre shows no ads, so keep spaces at least that big.

## Images, videos or both

Choose what the space may show:

- **Images and video**: the default.
- **Images only**.
- **Video only**.

Image ads show for 10 seconds each. Ads in a space take turns.

## Fallback image

The fallback image is what the space shows when it has no ad to show. That includes:

- no ad fits the shape;
- no ad the space's setting allows is available (for example, nothing approved yet on an Approve each ad space);
- Virvi can't be reached;
- a stream is live and the space is video only;
- a venue booking is running.

Upload one, pick one from your Images & Video, or paste a URL. It has no Ad label and no link.

**Without a fallback image, the space hides itself.** The panel and its collider disappear until there is an ad to show. You never get a blank or black panel.

## Video screens that show ads

Any video screen can become an ad space. Open the screen and set **Off Type** to one of:

- **Ads**: while no stream is live, the screen rotates ads like an ad space. It is a 16:9 space that shows images and video.
- **Playlist + ads**: the screen plays its playlist and shows one ad after every playlist video.

When a stream is live on the screen, it switches to the stream. Ads come back when the stream ends.

A screen in an ads mode uses its off image as its fallback image: it shows when no ad can play. A screen in any other mode never shows ads.

## Live streams

Video ads only play when no live stream is running in your scene. While a stream is live:

- A space set to **Images and video** shows image ads only.
- A **Video only** space shows its fallback image. With no fallback image, it disappears completely.
- Screens in an ads mode switch to the stream.

A video ad that is already playing stops at once. Everything goes back to normal when the stream ends.

## Venue bookings

While a venue is booked, ads on that venue's rentable screens pause. Those screens show their fallback image, or hide. Ads return when the booking ends.

## What visitors see

- Video ads play **muted**.
- Every ad has a small **Ad** label in its top-left corner.
- One visitor sees the same ad at most six times an hour in your scene.
- At most two video ads play at once in a scene.
- Clicking an ad opens its link.

## What gets counted

Virvi measures ads at four levels: in the scene, on screen, looked at, and clicked. The paid number is **on screen**: the ad was in clear view for at least a second.

- Only players with a verified wallet count towards paid numbers.
- Each wallet counts once per ad per day at each level.
- Players who haven't moved for a minute stop counting.
- Guests and unverified players are recorded as a separate, unpaid number.

## House ads and partner ads

- **Partner ads** run only on the spaces an admin places them on.
- **House ads** are Virvi's own. They fill any space with no partner ad.

House ads pay owners nothing. For now, owners are paid for partner ads manually, using the per-space numbers in the report.

## Who can advertise here

Each ad space has a **Who can advertise here** setting. It decides which approved ads can show:

- **Family-friendly only**: only ads reviewed as safe for all ages.
- **Allow all**: any approved ad, including mature ones such as alcohol.
- **Approve each ad**: nothing shows until the owner approves that specific ad.

Virvi reviews every ad first. Each ad is marked family-friendly or mature, or rejected with a reason. Your setting then decides which reviewed ads your space shows.

Only the scene's owner, co-hosts and Virvi admins can change the setting. You find it in the ad space editor, and in video screens set to an ads mode, under **Who can advertise here**.

On a space set to Approve each ad, you approve or decline each ad, house ads included. The list only shows ads Virvi has already approved that fit the space. You can change a decision later. Booking copies share the original space's setting and approvals.

If an ad's link or images change, the ad goes back to Virvi's review before it can show again.

## For admins

**Admin → Ads** is where ads are made and read.

- **New ad:** give it a name, choose **Partner** or **House**, and set a click URL. The URL must start with `https://`.
- **Review queue:** a new ad waits in the review queue and shows nowhere until it is approved. Approving needs a **Family-friendly** or **Mature** label. Rejecting needs a reason. Changing an ad's link or creatives sends it back to review. An approved or rejected ad can be reviewed again with **Review again**.
- **Creatives:** open an ad, pick a shape, and upload an image or video. Add one creative per shape you want to cover. Files that are still processing can't be added yet.
- **Placements:** partner ads only. Tick the ad spaces and ads-mode screens that should run the ad. A space shows a warning if the ad has no creative in its shape. House ads have no placements.
- **Pause / Resume:** takes an ad out of rotation and brings it back.
- **Report:** per ad, with totals for in scene, on screen (paid), looked at and clicked, the click rate, and the unverified numbers beside them. Break-downs by space and by day show what each scene delivered.

If a partner ad that fits the space is placed on it, the space shows only partner ads. Otherwise it shows house ads.
