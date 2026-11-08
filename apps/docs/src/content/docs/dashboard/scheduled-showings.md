---
title: Scheduled Showings
description: Set show times on a video screen so it plays like a movie theatre, with everyone seeing the same moment.
---

A video screen in **Schedule** mode plays a programme of videos at set times. Everyone in the scene sees the same moment of the same video: a visitor who walks in twenty minutes into a film joins twenty minutes in, not at the start.

## Setting up a screen

1. Open the scene on the dashboard and pick the video screen.
2. Set its off mode to **Schedule**. A **Showings** list appears below.
3. Optionally choose an **off image** for the screen. In Schedule mode it's the holding image shown between shows.

## Adding a showing

Each showing has:

- **A title** (optional), shown on the countdown sign.
- **A programme:** videos played in order, chosen from Images & Video or pasted as links. Mark trailers and ads as **ads**; they play before the feature, never after it.
- **When it plays:** once, every day, or on chosen days, at a start time in a timezone. Daylight-saving changes are handled.

Every video needs a known length. Videos uploaded to Images & Video are measured on upload. For a video from elsewhere, type its length (h:mm:ss, m:ss or minutes). A programme can run up to 48 hours.

Showings on the same screen can't overlap. A save that would run into another showing is refused, with the time it would clash.

Paused showings keep their programme but don't play.

### Copying

- **Duplicate:** the same programme, starting when this one ends (on the next 5 minutes).
- **Copy to…:** the same showing on another video screen of the scene.
- **Copy to days…:** the same programme and time on other days.
- **Copy this week's one-off showings to next week.**

Copies that would clash with a showing already there are skipped and listed.

### Following an event

A showing can follow one of the scene's events: choose **Plays: When &lt;event&gt; starts**. It then plays once at the event's start, in the event's timezone, and moves when the event does. If the event loses its start time the showing pauses until it has one again. Unlinking the scene from the event, or deleting the event, pauses the showing and keeps its programme. The event's page lists the showings that play when it starts.

## What visitors see

- **Between shows:** the holding image, with a countdown: "Next: Film / in 0:30".
- **During the ads before the feature:** "Film starts in 0:30".
- **When the feature starts:** "Now showing: Film" for 15 seconds, then nothing over the picture.
- **After the last show:** the holding image again.

Players check themselves against the server's clock and correct any drift over 2 seconds.

| Platform | Plays showings | Countdown sign |
| --- | --- | --- |
| Decentraland | Yes | Yes |
| Hyperfy | Yes (load the latest `virvi.hyp`) | Yes |
| Quest | Yes (latest app build) | No |
| Vision Pro | Yes (latest app build) | No |

## Host controls

For a single show, without changing the schedule:

- **End now:** ends the show that's on.
- **Play now:** plays the programme now, between shows.
- **Delay 5 min:** pushes the next show back. Press again for more (up to 3 hours in all).

A control that would run into another showing is refused with the reason.

The controls are on the dashboard's Showings list, in the Decentraland HUD's Stream panel (from `@virvixr/dcl` 2.9.0), and in the Hyperfy HUD's Streams panel. Paused showings show "Paused on virvi.io" and have no controls.

## Who can manage showings

Anyone who may edit the screen's playlist: the host, co-hosts and editors, and booking crew with the playlist permission on a screen of their booking. Scheduled showings are on every plan. Only screen films you have the rights to show publicly.
