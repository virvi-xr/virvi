/**
 * LIV-13: the headline of each @virvixr/dcl release, newest first, from the public changelog
 * (apps/docs/.../sdk/decentraland/changelog.md; a test keeps the two in step). The scene page lists what a scene
 * that's behind is missing.
 */
export const DCL_CHANGELOG: readonly { version: string; highlights: readonly string[] }[] = [
  { version: '2.24.0', highlights: ['Editing in an area', 'Widgets for scene code'] },
  { version: '2.23.0', highlights: ['Sound plays'] },
  { version: '2.22.0', highlights: ['Update notice'] },
  { version: '2.21.1', highlights: ['Version reporting'] },
  { version: '2.21.0', highlights: ['BEAT auto-claim', 'New consent text'] },
  { version: '2.20.0', highlights: ['Visitor privacy notice', 'Privacy entry', 'Nothing is sent before a decision'] },
  { version: '2.19.0', highlights: ['Giveaway kiosks', 'Kiosk look', 'Mannequins'] },
  { version: '2.18.0', highlights: ['Giveaway card', 'Stop tracking', 'Guests'] },
  { version: '2.17.0', highlights: ['Clearer consent', 'Stop tracking', 'Better status text', 'Blocked wallets'] },
  { version: '2.16.0', highlights: ['BEAT card', 'Guests', 'Test BEATs'] },
  { version: '2.15.0', highlights: ['Raffle card', 'Raffle tab', 'Missed draws'] },
  { version: '2.14.0', highlights: ['HUD version tracking', 'Scene Library', 'License'] },
  { version: '2.13.0', highlights: ['3D Models panel'] },
  { version: '2.12.0', highlights: ['Frames', 'Frame button', 'Entity limit'] },
  { version: '2.11.0', highlights: ['Models on the map', 'No visible change in the live scene', 'For scene builders'] },
  { version: '2.10.1', highlights: ['Type fix'] },
  { version: '2.10.0', highlights: ['Click actions', 'Hover text', 'Per copy'] },
  { version: '2.9.0', highlights: ['Showings list', 'Refusals'] },
  { version: '2.8.0', highlights: ['Stream panel', 'Off image', 'Clear', 'Next switch'] },
  { version: '2.7.0', highlights: ['Scheduled showings', 'Drift correction', 'Presets', 'Model colliders'] },
  { version: '2.6.0', highlights: ['Missing icon', 'Edit errors', 'Reconnect'] },
  { version: '2.5.0', highlights: ['Named items'] },
]
