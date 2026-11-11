package io.virvi.ar.roomscan

import io.virvi.ar.api.BuilderCall
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** What the **Scan this room** panel shows. */
data class RoomScanUi(
    val open: Boolean = false,
    /** Each room's floor outline in (x, z), for the preview. */
    val outlines: List<List<Pair<Float, Float>>> = emptyList(),
    val name: String = "",
    /** A line under the preview: no rooms, uploading, uploaded or why it failed. */
    val status: String? = null,
    val uploading: Boolean = false,
    /** The headset has no rooms set up: the panel offers Space Setup in place of Upload. */
    val noRooms: Boolean = false,
    val uploaded: Boolean = false,
) {
  val canUpload: Boolean
    get() = open && !noRooms && !uploading && !uploaded && name.isNotBlank()
}

/**
 * The **Scan this room** panel: [open] reads the headset's rooms ([read]) and shows their outline with a default name;
 * [upload] sends them as a layout ([RoomScanMapper]) with the AR pass of the space being built ([spaceId]), or, with no
 * space being built, with the headset secret ([uploadWithDevice]). With no
 * rooms set up it offers [setUpSpace] (the system's Space Setup). Space Setup pauses the app, which closes the panel,
 * so the person taps **Scan this room** again afterwards; a `done` for a closed panel is dropped. Main thread only.
 */
class RoomScanFlow(
    private val scope: CoroutineScope,
    private val read: () -> RoomScanInput,
    private val upload: suspend (spaceId: String, name: String, layout: JsonObject) -> BuilderCall<RoomScanUpload>,
    private val uploadWithDevice: suspend (name: String, layout: JsonObject) -> BuilderCall<RoomScanUpload>,
    private val spaceId: () -> String?,
    private val setUpSpace: (done: () -> Unit) -> Unit,
    private val show: (RoomScanUi) -> Unit,
    private val map: (RoomScanInput) -> JsonObject = RoomScanMapper::toLayoutJson,
) {
  private var ui = RoomScanUi()
  private var scan: RoomScanInput? = null
  /** Bumped by every open and close, so an answer for an older panel is dropped. */
  private var generation = 0

  fun open() {
    generation++
    val input = read()
    scan = input
    set(
        if (input.rooms.isEmpty()) RoomScanUi(open = true, noRooms = true, status = RoomScanCopy.NO_ROOMS)
        else RoomScanUi(open = true, outlines = input.rooms.map { it.floorPolygon }, name = defaultScanName(input.rooms.size)),
    )
  }

  fun setName(name: String) {
    if (!ui.open || ui.uploading || ui.uploaded) return
    // A failure's line goes once the name is edited.
    set(ui.copy(name = name.take(MAX_NAME), status = null))
  }

  fun upload() {
    val input = scan ?: return
    val space = spaceId()
    if (!ui.canUpload) return
    val name = ui.name.trim()
    val g = generation
    // The mapper drops non-finite readings; anything else it can't map is shown, never thrown.
    val layout =
        try {
          map(input)
        } catch (e: RuntimeException) {
          set(ui.copy(status = RoomScanCopy.INVALID_SCAN))
          return
        }
    set(ui.copy(uploading = true, status = RoomScanCopy.UPLOADING))
    scope.launch {
      val r = if (space != null) upload(space, name, layout) else uploadWithDevice(name, layout)
      if (g != generation) return@launch
      set(
          when (r) {
            is BuilderCall.Ok ->
                when (val a = r.value) {
                  is RoomScanUpload.Uploaded -> ui.copy(uploading = false, uploaded = true, status = RoomScanCopy.uploaded(a.name.ifEmpty { name }))
                  is RoomScanUpload.Refused -> ui.copy(uploading = false, status = a.message)
                }
            BuilderCall.Offline -> ui.copy(uploading = false, status = RoomScanCopy.OFFLINE)
            BuilderCall.Revoked, BuilderCall.BadSecret -> ui.copy(uploading = false, status = RoomScanCopy.SIGNED_OUT)
            else -> ui.copy(uploading = false, status = RoomScanCopy.FAILED)
          },
      )
    }
  }

  /**
   * Starts the system's Space Setup. On the headset it pauses the app and the panel closes, so its `done` is dropped
   * and the person opens **Scan this room** again; only a panel still open when it's done reads the new rooms.
   */
  fun setUpSpace() {
    if (!ui.open) return
    val g = generation
    setUpSpace { if (g == generation) open() }
  }

  fun close() {
    generation++
    scan = null
    set(RoomScanUi())
  }

  private fun set(next: RoomScanUi) {
    ui = next
    show(next)
  }

  companion object {
    /** The server's limit on a scan's name. */
    const val MAX_NAME = 120
  }
}
