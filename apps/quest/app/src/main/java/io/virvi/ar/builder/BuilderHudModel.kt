package io.virvi.ar.builder

import io.virvi.ar.Vec3
import java.util.Locale
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

// ── Copy (word for word from the plan's Global Constraints) ──

const val BUILDER_BANNER = "Builder: visitors don't see your changes until you save"
const val BOOKING_WARNING = "A booking's layout is live: changes save to that booking only"
const val SCOPE_EVERYWHERE = "Everywhere"
const val SCOPE_JUST_HERE = "Just this place"
const val RESET_TO_SHARED = "Reset to shared"

// Not in the plan's copy list (owner may reword).
const val DONE_CONFIRM = "Save your changes before leaving?"
const val SAVING = "Saving…"

fun saveFailedMessage(count: Int) = if (count == 1) "Couldn't save 1 change: try again" else "Couldn't save $count changes: try again"

/** Someone else holds the item. */
fun heldMessage(name: String) = "$name is moving this"

/** "A", "A and B", "A, B and C". */
fun joinNames(names: List<String>): String =
    when (names.size) {
      0 -> ""
      1 -> names[0]
      else -> names.dropLast(1).joinToString(", ") + " and " + names.last()
    }

/**
 * The HUD's warnings under the banner: the booking line while a booking's preset is live, and the several-places line
 * when the scene is also shown at [otherPlaces] (the names of the scene's other AR spaces). Empty when neither applies.
 */
fun hudWarnings(activePresetIsBooking: Boolean, otherPlaces: List<String>): List<String> =
    listOfNotNull(
        BOOKING_WARNING.takeIf { activePresetIsBooking },
        otherPlaces
            .takeIf { it.isNotEmpty() }
            ?.let { "This scene is also shown at ${joinNames(it)}: changes set to Everywhere move things there too." },
    )

// ── The scene's items, as the builder sees them ──

/** One instance in the feed's scene. */
data class BuilderItem(
    /** The instance's sk: the id the builder's routes take. */
    val sk: String,
    /** [io.virvi.ar.RenderItem.key]: "$elementSk:$instanceSk". */
    val renderKey: String,
    /** The element type: image, video, model or sound. */
    val element: String,
    val name: String,
    /** Where it is shown here: the shared transform plus this place's adjustment. */
    val now: ItemTransform,
    /** The shared transform: the feed's `arShared` for an adjusted instance, else [now]. */
    val shared: ItemTransform,
    /** The feed's `arAdjustment`; null when this place has none. */
    val adjustment: Adjustment?,
) {
  val adjusted: Boolean
    get() = adjustment != null
}

private val SECTIONS = listOf("videos" to "video", "images" to "image", "models" to "model", "sounds" to "sound")
private val SOURCE_KEYS = listOf("textureSrc", "modelSrc", "audioSrc", "liveSrc", "offImageSrc")

private fun JsonElement?.arr(): List<JsonElement> = (this as? JsonArray) ?: emptyList()

private fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonElement?.num(): Double? =
    (this as? JsonPrimitive)?.takeIf { !it.isString && it.booleanOrNull == null }?.doubleOrNull?.takeIf { it.isFinite() }

private fun JsonElement?.isFalse(): Boolean = (this as? JsonPrimitive)?.let { !it.isString && it.booleanOrNull == false } ?: false

private fun vec(e: JsonElement?, fallback: Double): Vec3 {
  val o = e as? JsonObject
  return Vec3(o?.get("x").num() ?: fallback, o?.get("y").num() ?: fallback, o?.get("z").num() ?: fallback)
}

private fun transformOf(o: JsonObject?) = ItemTransform(vec(o?.get("position"), 0.0), vec(o?.get("rotation"), 0.0), vec(o?.get("scale"), 1.0))

private fun adjustmentOf(e: JsonElement?): Adjustment? {
  val o = e as? JsonObject ?: return null
  return Adjustment(vec(o["dPosition"], 0.0), vec(o["dRotation"], 0.0), vec(o["scaleFactor"], 1.0))
}

private fun nameOf(el: JsonObject, element: String): String {
  el["name"].str()?.takeIf { it.isNotEmpty() }?.let { return it }
  val src = SOURCE_KEYS.firstNotNullOfOrNull { k -> el[k].str()?.takeIf { it.isNotEmpty() } }
  return src?.split('?', '#')?.first()?.trimEnd('/')?.substringAfterLast('/')?.ifEmpty { null } ?: element.replaceFirstChar { it.uppercase() }
}

/**
 * The enabled instances of the feed's [scene] (videos, images, models, sounds), in the order the renderer plans them.
 * Instances without a string sk can't be edited and are left out.
 */
fun builderItems(scene: JsonObject?): List<BuilderItem> {
  if (scene == null) return emptyList()
  val out = ArrayList<BuilderItem>()
  for ((section, element) in SECTIONS) {
    for (e in scene[section].arr()) {
      val el = e as? JsonObject ?: continue
      if (el["enabled"].isFalse()) continue
      val elementSk = el["sk"].str() ?: continue
      for (i in el["instances"].arr()) {
        val inst = i as? JsonObject ?: continue
        if (inst["enabled"].isFalse()) continue
        val sk = inst["sk"].str() ?: continue
        val now = transformOf(inst)
        val adjusted = (inst["arAdjusted"] as? JsonPrimitive)?.booleanOrNull == true
        val shared = if (adjusted) (inst["arShared"] as? JsonObject)?.let(::transformOf) ?: now else now
        out += BuilderItem(sk, "$elementSk:$sk", element, nameOf(el, element), now, shared, if (adjusted) adjustmentOf(inst["arAdjustment"]) else null)
      }
    }
  }
  return out
}

// ── HUD state ──

enum class HudTab { LAYOUT, ASSETS, STREAM }

/** A Layout row: the item's name and kind, a dot when this place has its own adjustment (with **Reset to shared**). */
data class HudRow(val sk: String, val name: String, val kind: String, val adjusted: Boolean, val picked: Boolean, val edited: Boolean)

/** One Exact row: the label and the x, y, z texts. Editing a field sets that value in [mode]. */
data class ExactRow(val label: String, val mode: TransformMode, val values: List<String>)

/** The bar shown while an item is picked. */
data class PickBar(
    val name: String,
    val mode: TransformMode,
    val scope: Scope,
    val exact: List<ExactRow>,
    /** The scope switch is locked (a Reset to shared is waiting to be saved). */
    val scopeLocked: Boolean = false,
)

/** What the builder HUD shows; built by [hudModel], drawn by `BuilderHud`. */
data class BuilderHudModel(
    val tab: HudTab,
    /** Always [BUILDER_BANNER], on top whatever the tab. */
    val banner: String,
    val warnings: List<String>,
    val rows: List<HudRow>,
    val bar: PickBar?,
    /** A one-off note: "<name> is moving this", or a failed save. */
    val message: String?,
    val canSave: Boolean,
    val saving: Boolean,
    /** Done was pressed with unsaved changes: the HUD asks [DONE_CONFIRM]. */
    val confirmingDone: Boolean,
    /** The Layout tab offers **Scan this room**: only on a personal headset (a shared one uploads to someone else's account). */
    val canScanRoom: Boolean = false,
    /** The **Stream** tab (LIV-53, LIV-54): only on a personal headset, as the server's stream routes are. */
    val canStream: Boolean = false,
)

fun kindLabel(element: String): String =
    when (element) {
      "image" -> "Image"
      "video" -> "Video"
      "model" -> "Model"
      "sound" -> "Sound"
      "ad_space" -> "Ad space"
      else -> element
    }

/** Position and scale to the centimetre, rotation to a tenth of a degree. */
fun formatExact(mode: TransformMode, value: Double): String =
    String.format(Locale.US, if (mode == TransformMode.ROTATE) "%.1f" else "%.2f", if (value == 0.0) 0.0 else value)

/** A typed Exact value, or null when it isn't a finite number. A comma is read as the decimal point. */
fun parseExact(text: String): Double? = text.trim().replace(',', '.').toDoubleOrNull()?.takeIf { it.isFinite() }

fun exactRows(t: ItemTransform): List<ExactRow> =
    listOf(
        exactRow("Position", TransformMode.MOVE, t.position),
        exactRow("Rotation", TransformMode.ROTATE, t.rotation),
        exactRow("Scale", TransformMode.RESIZE, t.scale),
    )

private fun exactRow(label: String, mode: TransformMode, v: Vec3) =
    ExactRow(label, mode, listOf(v.x, v.y, v.z).map { formatExact(mode, it) })

/** The HUD for the editor's [view], on [tab], with [warnings] from [hudWarnings]. */
fun hudModel(view: EditorView, tab: HudTab, warnings: List<String>): BuilderHudModel {
  val picked = view.items.firstOrNull { it.sk == view.picked }
  return BuilderHudModel(
      tab = tab,
      banner = BUILDER_BANNER,
      warnings = warnings,
      rows = view.items.map { HudRow(it.sk, it.name, kindLabel(it.element), it.adjusted, it.sk == view.picked, it.sk in view.edited) },
      bar = picked?.let { PickBar(it.name, view.mode, view.scope, exactRows(view.pickedTransform ?: it.now), view.scopeLocked) },
      message = view.message,
      canSave = view.edited.isNotEmpty() && !view.saving,
      saving = view.saving,
      confirmingDone = view.confirmingDone,
  )
}
