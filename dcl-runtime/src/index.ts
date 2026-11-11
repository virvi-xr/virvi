/**
 * Virvi generic runtime scene.
 *
 * One pre-built scene serves every wizard World. The server rewrites scene.json at deploy time
 * (parcels, base, and a `virvi` block with apiUrl/wssUrl) and writes `virvi/placements.json` (LIV-134); nothing else
 * is scene-specific. The scene itself is found through the location setup, like any other virvi-dcl scene, so no
 * sceneId is passed.
 *
 * The deployed models are placed first, from the snapshot, before anything else: Decentraland's LOD/map builder runs
 * the scene with no network and made-up scene metadata (no `virvi` block), so this is all it sees, and visitors see the
 * buildings before the live scene arrives. The live scene adopts them, so it must only start once they are placed.
 */
import { createVirvi, placeDeployedModels } from '@virvixr/dcl'
// @ts-ignore provided by the Decentraland runtime
import { getSceneInformation } from '~system/Runtime'

async function main() {
  await placeDeployedModels() // never throws; places nothing without a snapshot; gives up after 5 s of frames
  try {
    const info = await getSceneInformation({})
    const virvi = JSON.parse(info.metadataJson || '{}').virvi ?? {}
    const { apiUrl, wssUrl } = virvi
    if (!apiUrl || !wssUrl) {
      console.error('Virvi runtime: scene.json is missing virvi.apiUrl / virvi.wssUrl, not connecting')
      return
    }
    await createVirvi({ apiUrl, wssUrl })
  } catch (err) {
    console.error('Virvi runtime failed to initialize:', err)
  }
}

main()
