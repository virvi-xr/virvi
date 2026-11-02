package io.virvi.ar

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import com.meta.spatial.core.Color4
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.Vector3
import com.meta.spatial.core.Vector4
import com.meta.spatial.runtime.AlphaMode
import com.meta.spatial.runtime.MaterialSidedness
import com.meta.spatial.runtime.SceneMaterial
import com.meta.spatial.runtime.PanelSceneObject
import com.meta.spatial.runtime.SceneMesh
import com.meta.spatial.runtime.SceneObject
import com.meta.spatial.runtime.SceneTexture
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.Box
import com.meta.spatial.toolkit.Material
import com.meta.spatial.toolkit.MediaPanelSettings
import com.meta.spatial.toolkit.Mesh
import com.meta.spatial.toolkit.MeshCollision
import com.meta.spatial.toolkit.Panel
import com.meta.spatial.toolkit.PanelCreationSystem
import com.meta.spatial.toolkit.PixelDisplayOptions
import com.meta.spatial.toolkit.QuadShapeOptions
import com.meta.spatial.toolkit.Scale
import com.meta.spatial.toolkit.SceneObjectSystem
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.TransformParent
import com.meta.spatial.toolkit.VideoSurfacePanelRegistration
import com.meta.spatial.toolkit.Visible
import java.net.HttpURLConnection
import io.virvi.ar.builder.BuilderScene
import io.virvi.ar.builder.ItemTransform
import io.virvi.ar.space.RootPose
import io.virvi.ar.space.SceneView
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

fun Quat.sdk() = Quaternion(w.toFloat(), x.toFloat(), y.toFloat(), z.toFloat())

fun Vec3.sdk() = Vector3(x.toFloat(), y.toFloat(), z.toFloat())

/**
 * Builds and updates Spatial SDK entities for a Virvi scene plan. `root` is the Virvi scene frame: its origin is the
 * parcel's south-west corner at ground level, and since Spatial SDK shares Decentraland's axes, items take their Virvi
 * transforms unchanged. Like the other ports, each item gets a group entity carrying the position and rotation;
 * images and videos are sized planes inside it, models take the Virvi scale (and, when `modelTurn` is on, a half turn
 * about Y) on a child entity.
 *
 * Images load through the `mesh://virvi-image` creator, which downloads the picture and returns a textured quad. Models
 * load straight from their https URL (NetworkedAssetLoader), so only .glb works. Sounds aren't played yet.
 *
 * The scene starts hidden. [setVisible] fades images and videos over [FADE_MS] by setting their materials' alpha
 * each [tick] (and a video layer's colour scale); models and sounds show and hide at the end of the fade. Videos play
 * only while they are drawn and the app isn't [paused].
 *
 * In [builderMode], item meshes take ray hits (`MeshCollision.LineTest`) so the builder can pick them ([keyAt]), and
 * [setOverrides] shows edited items where the builder has put them; visitors' meshes keep `NoCollision`.
 */
class SceneRenderer(private val activity: AppSystemActivity) : SceneView, BuilderScene {
  val root: Entity = Entity.create(listOf(Transform(Pose())))

  /**
   * Whether models get a half turn about Y. Decentraland shows a glTF x-mirrored; if Spatial SDK's glTF import mirrors
   * z instead, the two differ by exactly this turn. Which one it does is checked on the headset (see README).
   */
  var modelTurn = true
    set(value) {
      if (field != value) {
        field = value
        rebuild()
      }
    }

  /** Builder mode: item meshes can be hit by the pointer. Changing it rebuilds the items. */
  override var builderMode = false
    set(value) {
      if (field != value) {
        field = value
        rebuild()
      }
    }

  var onApplied: ((PlanDiff) -> Unit)? = null

  /** The app is in the background: videos are paused whatever the fade says. */
  var paused = false
    set(value) {
      if (field != value) {
        field = value
        syncPlayers()
      }
    }

  private var plan: List<RenderItem> = emptyList()
  private val shown = mutableMapOf<String, Shown>()

  /**
   * [faded] are the entities whose alpha the fade sets (an image's quad, a video's panel); models have none. The first
   * of [entities] is the item's group (position and rotation); [sized] is the child its scale goes on, if any.
   */
  private class Shown(
      val item: RenderItem,
      val entities: List<Entity>,
      val player: ExoPlayer? = null,
      val panelId: Int? = null,
      val faded: List<Entity> = emptyList(),
      val sized: Entity? = null,
  )

  /** Builder edits by item key, and what [setOverrides] last put on each item. */
  private var overrides: Map<String, ItemTransform> = emptyMap()

  private val fade = SceneFade(FADE_MS)
  /** What [sync] last put on the entities. */
  private var appliedAlpha = 1f
  private var appliedMedia = false
  private var appliedSolid = false
  private val sceneObjects = HashMap<Entity, SceneObject>()

  init {
    activity.registerAsyncMeshCreator(IMAGE_MESH) { _, uri -> imageMesh(uri) }
  }

  override fun apply(next: List<RenderItem>) {
    val d = diffPlans(plan, next)
    d.remove.forEach(::remove)
    for (item in d.update) {
      remove(item.key)
      add(item)
    }
    d.add.forEach(::add)
    plan = next
    onApplied?.invoke(d)
  }

  /** Puts the scene origin at `pose.position`, turned `pose.yawDeg` degrees about +Y (level: no pitch or roll). */
  override fun setRoot(pose: RootPose) {
    val q = Quat.axisAngle(0.0, 1.0, 0.0, Math.toRadians(pose.yawDeg))
    root.setComponent(
        Transform(Pose(Vector3(pose.position.x.toFloat(), pose.position.y.toFloat(), pose.position.z.toFloat()), q.sdk()))
    )
  }

  override fun count() = plan.size

  /** The key of the item [entity] belongs to (its group or a child), or null. */
  fun keyAt(entity: Entity): String? = shown.entries.firstOrNull { (_, s) -> entity in s.entities }?.key

  /**
   * Shows the items in [next] (by key) at their builder transforms instead of the feed's; items no longer in it go
   * back to the feed's. Call every frame while building; only changed items are touched.
   */
  override fun setOverrides(next: Map<String, ItemTransform>) {
    if (next == overrides) return
    val prev = overrides
    overrides = next
    for (key in prev.keys + next.keys) if (prev[key] != next[key]) shown[key]?.let(::place)
  }

  /** Puts [s]'s group and sized child where its override (or else the feed) has it. */
  private fun place(s: Shown) {
    val o = overrides[s.item.key]
    val g = s.entities.first()
    if (o == null) {
      g.setComponent(Transform(Pose(s.item.transform.position.sdk(), s.item.transform.rotation.sdk())))
      s.sized?.setComponent(Scale(sizeFactor(s.item, s.item.transform.scale)))
    } else {
      g.setComponent(Transform(Pose(o.position.sdk(), Quat.yxzDegrees(o.rotation).sdk())))
      s.sized?.setComponent(Scale(sizeFactor(s.item, o.scale)))
    }
  }

  /**
   * The Scale for an item's sized child at [scale]: a model takes it as it is; an image's quad and a video's panel were
   * built at the feed's width and height, so they take the ratio.
   */
  private fun sizeFactor(item: RenderItem, scale: Vec3): Vector3 =
      if (item.kind == RenderItem.Kind.MODEL) scale.sdk()
      else
          Vector3(
              (Math.abs(scale.x) / maxOf(Math.abs(item.width), 0.001)).toFloat(),
              (Math.abs(scale.y) / maxOf(Math.abs(item.height), 0.001)).toFloat(),
              1f,
          )

  /** Removes every item (the space was closed); whatever is added next starts hidden. */
  override fun clear() {
    apply(emptyList())
    fade.clear()
    sync()
  }

  /** Fades the scene in or out over [FADE_MS] from wherever the current fade has got to. */
  override fun setVisible(on: Boolean, nowMs: Long) {
    if (on) fade.show(nowMs) else fade.hide(nowMs)
    sync()
  }

  /** Hides the scene at once, without a fade. */
  override fun hideNow() {
    fade.hideNow()
    sync()
  }

  /** Advances the fade; call every frame. */
  override fun tick(nowMs: Long) {
    fade.tick(nowMs)
    sync()
  }

  /** Puts [fade]'s state on the entities: alpha on images and videos, and who is drawn. */
  private fun sync() {
    if (fade.alpha != appliedAlpha) {
      appliedAlpha = fade.alpha
      shown.values.forEach { s -> s.faded.forEach { e -> sceneObjects[e]?.let { setAlpha(it, appliedAlpha) } } }
    }
    if (fade.mediaOn != appliedMedia) {
      appliedMedia = fade.mediaOn
      shown.values.forEach { s -> if (s.faded.isNotEmpty()) s.entities.forEach { it.setComponent(Visible(appliedMedia)) } }
      syncPlayers()
    }
    if (fade.solidOn != appliedSolid) {
      appliedSolid = fade.solidOn
      shown.values.forEach { s -> if (s.faded.isEmpty()) s.entities.forEach { it.setComponent(Visible(appliedSolid)) } }
    }
  }

  /** Videos play while they are drawn and the app is in the foreground, and pause otherwise. */
  private fun syncPlayers() {
    val play = appliedMedia && !paused
    shown.values.forEach { s -> s.player?.playWhenReady = play }
  }

  /** Sets [so]'s alpha: its materials' albedo (images multiply their texture by it) and, for a panel, its layer. */
  private fun setAlpha(so: SceneObject, a: Float) {
    so.materials?.forEach { it.setAlbedoColor(android.graphics.Color.valueOf(1f, 1f, 1f, a)) }
    (so as? PanelSceneObject)?.layer?.setColorScaleBias(Vector4(a, a, a, a), Vector4(0f, 0f, 0f, 0f))
  }

  /** Remembers [e]'s scene object once it exists, and gives it the current alpha. */
  private fun watchAlpha(e: Entity) {
    val future = activity.systemManager.findSystem<SceneObjectSystem>().getSceneObject(e) ?: return
    future.thenAccept { so ->
      activity.runOnUiThread {
        if (shown.values.none { e in it.faded }) return@runOnUiThread
        sceneObjects[e] = so
        if (appliedAlpha < 1f) setAlpha(so, appliedAlpha)
      }
    }
  }

  private fun rebuild() {
    val current = plan
    current.forEach { remove(it.key) }
    plan = emptyList()
    apply(current)
  }

  private fun group(item: RenderItem): Entity =
      Entity.create(
          listOf(
              TransformParent(root),
              Transform(Pose(item.transform.position.sdk(), item.transform.rotation.sdk())),
          )
      )

  private fun add(item: RenderItem) {
    val g = group(item)
    val s =
        when (item.kind) {
          RenderItem.Kind.IMAGE -> child(g, imageMeshUri(item)).let { q -> Shown(item, listOf(g, q), faded = listOf(q), sized = q) }
          // A non-glb model's placeholder box keeps its own size.
          RenderItem.Kind.MODEL -> model(g, item).let { m -> Shown(item, listOf(g, m), sized = m.takeIf { extOf(item.src) == "glb" }) }
          RenderItem.Kind.VIDEO -> video(g, item)
          RenderItem.Kind.AUDIO -> Shown(item, listOf(g))
        }
    shown[item.key] = s
    if (item.key in overrides) place(s)
    val on = if (s.faded.isEmpty()) appliedSolid else appliedMedia
    s.entities.forEach { it.setComponent(Visible(on)) }
    s.faded.forEach(::watchAlpha)
  }

  private fun remove(key: String) {
    val s = shown.remove(key) ?: return
    s.faded.forEach { sceneObjects.remove(it) }
    s.player?.release()
    s.panelId?.let {
      activity.panelRegistrations.remove(it)
      activity.systemManager.findSystem<PanelCreationSystem>().panelCreator.remove(it)
    }
    s.entities.asReversed().forEach { it.destroy() }
  }

  /** Builders pick items with the pointer; visitors' items never take a hit. */
  private fun collision() = if (builderMode) MeshCollision.LineTest else MeshCollision.NoCollision

  private fun child(parent: Entity, mesh: Uri, vararg extra: com.meta.spatial.core.ComponentBase): Entity =
      Entity.create(
          listOf(Mesh(mesh, hittable = collision()), TransformParent(parent), Transform(Pose())) +
              extra.toList()
      )

  private fun model(parent: Entity, item: RenderItem): Entity {
    val turn = if (modelTurn) Quat.axisAngle(0.0, 1.0, 0.0, Math.PI) else Quat.IDENTITY
    if (extOf(item.src) != "glb") {
      Log.w(TAG, "only .glb models load; showing a placeholder for ${item.name}")
      return Entity.create(
          listOf(
              Mesh(Uri.parse("mesh://box"), hittable = collision()),
              Box(Vector3(-0.25f, 0f, -0.25f), Vector3(0.25f, 0.5f, 0.25f)),
              Material().apply { baseColor = Color4(1f, 0.2f, 0.6f, 1f) },
              TransformParent(parent),
              Transform(Pose()),
          )
      )
    }
    return Entity.create(
        listOf(
            Mesh(Uri.parse(item.src), hittable = collision()),
            TransformParent(parent),
            Transform(Pose(Vector3(0f), turn.sdk())),
            Scale(item.transform.scale.sdk()),
        )
    )
  }

  private fun video(parent: Entity, item: RenderItem): Shown {
    val w = maxOf(Math.abs(item.width), 0.001).toFloat()
    val h = maxOf(Math.abs(item.height), 0.001).toFloat()
    val player =
        ExoPlayer.Builder(activity).build().apply {
          // A playlist plays each video in turn and, repeating all, goes back to the first after the last.
          setMediaItems(item.playlist.ifEmpty { listOf(item.src) }.map { MediaItem.fromUri(it) })
          repeatMode =
              if (item.loop || item.playlist.size > 1) Player.REPEAT_MODE_ALL else Player.REPEAT_MODE_OFF
          volume = 0f // muted, like the other spikes until Sound is on
          prepare()
          playWhenReady = appliedMedia && !paused
        }
    val id = nextPanelId++
    activity.registerPanel(
        VideoSurfacePanelRegistration(
            id,
            surfaceConsumer = { _, surface -> player.setVideoSurface(surface) },
            settingsCreator = {
              MediaPanelSettings(
                  shape = QuadShapeOptions(width = w, height = h),
                  display = PixelDisplayOptions(width = 1280, height = 720),
              )
            },
        )
    )
    val panel = Entity.create(listOf(Panel(id), TransformParent(parent), Transform(Pose())))
    return Shown(item, listOf(parent, panel), player, id, faded = listOf(panel), sized = panel)
  }

  private suspend fun imageMesh(uri: Uri): SceneMesh {
    val src = uri.getQueryParameter("src") ?: ""
    val w = uri.getQueryParameter("w")?.toFloatOrNull() ?: 1f
    val h = uri.getQueryParameter("h")?.toFloatOrNull() ?: 1f
    // Download off the main thread; textures and meshes have to be made on it (the renderer asserts otherwise).
    val bitmap =
        try {
          withContext(Dispatchers.IO) {
            val c = URL(src).openConnection() as HttpURLConnection
            c.connectTimeout = IMAGE_CONNECT_TIMEOUT_MS
            c.readTimeout = IMAGE_READ_TIMEOUT_MS
            try {
              c.inputStream.use { BitmapFactory.decodeStream(it) }
            } finally {
              c.disconnect()
            }
          } ?: error("could not decode image")
        } catch (e: Exception) {
          Log.w(TAG, "image failed: $src ${e.message}")
          null
        }
    return withContext(Dispatchers.Main) {
      val texture = bitmap?.let { SceneTexture(it) } ?: SceneTexture(android.graphics.Color.valueOf(0.5f, 0.5f, 0.5f, 0.4f))
      val material = SceneMaterial(texture, AlphaMode.TRANSLUCENT, SceneMaterial.UNLIT_SHADER)
      material.setSidedness(MaterialSidedness.DOUBLE_SIDED)
      SceneMesh.quad(Vector3(-w / 2, -h / 2, 0f), Vector3(w / 2, h / 2, 0f), material)
    }
  }

  private fun imageMeshUri(item: RenderItem): Uri =
      Uri.parse(IMAGE_MESH)
          .buildUpon()
          .appendQueryParameter("src", item.src)
          .appendQueryParameter("w", maxOf(Math.abs(item.width), 0.001).toString())
          .appendQueryParameter("h", maxOf(Math.abs(item.height), 0.001).toString())
          .build()

  companion object {
    private const val TAG = "VirviAR"
    private const val IMAGE_MESH = "mesh://virvi-image"
    const val FADE_MS = 400L
    private const val IMAGE_CONNECT_TIMEOUT_MS = 15_000
    private const val IMAGE_READ_TIMEOUT_MS = 30_000
    private var nextPanelId = 1_600_000
  }
}
