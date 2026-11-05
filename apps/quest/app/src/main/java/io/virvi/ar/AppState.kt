package io.virvi.ar

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.virvi.ar.api.FeedStatus
import io.virvi.ar.builder.AlignUi
import io.virvi.ar.builder.AssetsState
import io.virvi.ar.builder.AuthState
import io.virvi.ar.builder.BuilderHudModel
import io.virvi.ar.builder.BuilderPrompt
import io.virvi.ar.builder.RingCheckUi
import io.virvi.ar.builder.StreamsState
import io.virvi.ar.ring.CameraStatus
import io.virvi.ar.ring.RING_TEST_MARKERS
import io.virvi.ar.roomscan.RoomScanUi
import io.virvi.ar.visitor.RecentSpace
import io.virvi.ar.visitor.SpacePageInfo
import io.virvi.ar.visitor.VisitorCopy

/** What the panels show. Written on the main thread by MainActivity and the visitor and builder controllers, read by Compose. */
class AppState {
  // ── visitor ──
  /** The hint card's line, or null when the card is hidden (the scene is shown). */
  var hint by mutableStateOf<String?>(VisitorCopy.HINT)
  var sceneShown by mutableStateOf(false)
  /** The "⋯" button shows (see `menuButtonShown`). */
  var menuButtonShown by mutableStateOf(false)
  var menuOpen by mutableStateOf(false)
  /** A line under the menu's buttons, such as why builder mode closed; null for none. */
  var menuNote by mutableStateOf<String?>(null)
  /** The space the menu's **Report this space** would report, or null (the button hides). */
  var reportSpaceId by mutableStateOf<String?>(null)
  /** The menu shows the report's reason picker in place of its buttons. */
  var reportPicking by mutableStateOf(false)
  var occlusion by mutableStateOf(Occlusion.DEPTH)
  /** The menu's Spaces list is open. */
  var spacesOpen by mutableStateOf(false)
  /** Spaces opened or visited, newest first. */
  var recentSpaces by mutableStateOf<List<RecentSpace>>(emptyList())
  /** The space page's content, or null when the page is closed. */
  var spacePage by mutableStateOf<SpacePageInfo?>(null)
  /** Why the open space page can't show its space (the lookup failed), or null. */
  var spaceProblem by mutableStateOf<String?>(null)

  // ── builder (written by the builder controller) ──
  /** Builder mode holds the space (placing, aligning or building); visitor mode is paused. */
  var builderActive by mutableStateOf(false)
  /** The menu's owner-only items show: builder mode is active or the headset is paired. */
  var ownerControls by mutableStateOf(false)
  /** The menu's **Keep the scene loaded between visitors** switch (`AppPrefs.keepLoadedBetweenVisitors`). */
  var keepLoaded by mutableStateOf(false)
  /** The pairing panel's code, while pairing from the menu's **Builder**; null hides it. */
  var pairing by mutableStateOf<AuthState.Pairing?>(null)
  /** The builder panel: finding spaces, the pick list, or "look at a ring"; null hides it. */
  var builderPrompt by mutableStateOf<BuilderPrompt?>(null)
  /** The align panel, while aligning a floor; null hides it. */
  var align by mutableStateOf<AlignUi?>(null)
  /** The ring panel, while building with a ring of the floor steady in view; null hides it. */
  var ringCheck by mutableStateOf<RingCheckUi?>(null)
  /** The builder HUD, while building; null hides it. */
  var hud by mutableStateOf<BuilderHudModel?>(null)
  var assets by mutableStateOf(AssetsState(null))
  /** The builder HUD's Stream tab (personal headsets only). */
  var streams by mutableStateOf(StreamsState())
  /** The Layout tab's **Scan this room** panel (personal headsets only). */
  var roomScan by mutableStateOf(RoomScanUi())

  // ── developer panel (debug builds) ──
  var developerOpen by mutableStateOf(false)
  var serverUrl by mutableStateOf(DEFAULT_BASE_URL)
  var visitorState by mutableStateOf("")
  var feed by mutableStateOf<FeedStatus?>(null)
  var itemCount by mutableStateOf(0)
  var modelTurn by mutableStateOf(true)
  var markerStatus by mutableStateOf("Waiting for permissions")
  /** Null until the camera is first started. */
  var cameraStatus by mutableStateOf<CameraStatus?>(null)
  var markerLines by mutableStateOf(RING_TEST_MARKERS.map { "${it.name}: not seen yet" })
  /** One line per test marker, after its [markerLines] entry: its world position and wall heading. */
  var poseLines by mutableStateOf(RING_TEST_MARKERS.map { "  not in view" })
  var wallStatus by mutableStateOf("Room scan not loaded yet")
  var lastRing by mutableStateOf("No ring marker read yet")
  var occlusionStatus by mutableStateOf("Hidden behind anything real the headset's depth sees")
  /** Tints the room scan's walls and ceiling, to check they line up with the real ones. */
  var showWalls by mutableStateOf(false)
}

/** What hides the virtual scene where something real is in front of it. */
enum class Occlusion(val label: String) {
  OFF("Off"),
  /** The room scan's walls and ceiling, as surfaces that show passthrough. */
  WALLS("Walls"),
  /** The headset's live depth: anything real, people and furniture included. */
  DEPTH("Live depth"),
}

/** What the developer panel's buttons do. */
interface DeveloperActions {
  fun setModelTurn(on: Boolean)
  fun resetReadings()
  fun setOcclusion(o: Occlusion)
  fun setShowWalls(on: Boolean)
}
