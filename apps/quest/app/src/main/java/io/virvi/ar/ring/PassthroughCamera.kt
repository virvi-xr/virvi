package io.virvi.ar.ring

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.OutputConfiguration
import android.hardware.camera2.params.SessionConfiguration
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import java.util.concurrent.Executor

/** Why marker detection is or isn't running. */
enum class CameraStatus { NO_PERMISSION, NO_CAMERA, STARTING, RUNNING, ERROR }

/** The panel line for [s]: says why detection is off when it is. */
fun cameraStatusText(s: CameraStatus): String =
    when (s) {
      CameraStatus.NO_PERMISSION -> "Camera permission denied: ARC detection is off"
      CameraStatus.NO_CAMERA -> "No passthrough camera found (needs Quest 3/3S, Horizon OS v74+)"
      CameraStatus.STARTING -> "Starting the passthrough camera…"
      CameraStatus.RUNNING -> "Camera running: look at a printed ARC"
      CameraStatus.ERROR -> "Camera error: ARC detection is off (see logcat VirviAR)"
    }

/**
 * The camera's calibration: [fx], [fy], [cx], [cy] in pixels from `LENS_INTRINSIC_CALIBRATION` (in
 * [PassthroughCamera.intrinsics], scaled to the [PassthroughCamera.WIDTH] × [PassthroughCamera.HEIGHT] stream by
 * [scaleIntrinsics]), and the lens pose from `LENS_POSE_TRANSLATION` (metres) and
 * `LENS_POSE_ROTATION` (quaternion x, y, z, w).
 */
data class CameraIntrinsics(
    val fx: Double,
    val fy: Double,
    val cx: Double,
    val cy: Double,
    val lensTranslation: FloatArray,
    val lensRotation: FloatArray,
) {
  override fun equals(other: Any?): Boolean =
      other is CameraIntrinsics && fx == other.fx && fy == other.fy && cx == other.cx && cy == other.cy &&
          lensTranslation.contentEquals(other.lensTranslation) && lensRotation.contentEquals(other.lensRotation)

  override fun hashCode(): Int =
      listOf(fx, fy, cx, cy).hashCode() * 31 * 31 + lensTranslation.contentHashCode() * 31 + lensRotation.contentHashCode()

  override fun toString(): String =
      "fx=%.2f fy=%.2f cx=%.2f cy=%.2f t=%s q=%s".format(
          java.util.Locale.US, fx, fy, cx, cy, lensTranslation.contentToString(), lensRotation.contentToString())
}

/**
 * The Quest 3/3S left passthrough camera at [WIDTH] × [HEIGHT], handing out the Y (grey) plane of each frame.
 *
 * [onFrame] and [onRunStart] run on one frame thread that lives as long as this object, so they never overlap,
 * across every [start] and [stop]: state they share (a RingDetector, a RingTracker) needs no locking. Frames that
 * arrive while [onFrame] is busy are dropped. Its `gray` array is reused for the next frame, so it is only valid during
 * the call (row j starts at j * `stride`). An exception from [onFrame] is logged (the first one per run) and that
 * frame skipped; after [FAILURES_TO_ERROR] such frames in a row the status is [CameraStatus.ERROR] until a frame
 * succeeds, which reports [CameraStatus.RUNNING] again. RUNNING is reported after the first frame [onFrame] handles.
 * [onStatus] runs on a background thread. Every failure (no permission, no camera, open errors, disconnects) ends in a
 * [CameraStatus], never an exception. Call [close] when done to end the threads.
 */
class PassthroughCamera(
    context: Context,
    private val onFrame: (gray: ByteArray, width: Int, height: Int, stride: Int, timestampNs: Long) -> Unit,
    private val onStatus: (CameraStatus) -> Unit,
    /** Runs on the frame thread before a new run's first frame: reset per-run frame state here. */
    private val onRunStart: () -> Unit = {},
) {
  private val context = context.applicationContext
  private val manager = context.getSystemService(CameraManager::class.java)

  /** The chosen camera's calibration at the stream size, once [start] has found it. */
  @Volatile
  var intrinsics: CameraIntrinsics? = null
    private set

  private val lock = Any()
  /** The current run, or null when stopped. Callbacks from an older run see a different object and back out. */
  private var run: Run? = null
  private var closed = false
  private var loggedCamera = false

  /** Camera2 callbacks, for the life of this object. */
  private val camThread = HandlerThread("VirviARCamera").apply { start() }
  private val camHandler = Handler(camThread.looper)
  /** Frame copies, [onFrame] and [onRunStart], for the life of this object: one frame at a time, ever. */
  private val frameThread = HandlerThread("VirviARFrames").apply { start() }
  private val frameHandler = Handler(frameThread.looper)
  /** Only touched on [frameThread]. */
  private var gray = ByteArray(0)

  /** One open-to-close run of the camera: its reader and Camera2 objects. */
  private class Run(val reader: ImageReader) {
    var device: CameraDevice? = null
    var session: CameraCaptureSession? = null
    /** Only touched on the frame thread. */
    var reportedRunning = false
    var loggedFrameError = false
    val failures = FailureStreak(FAILURES_TO_ERROR)
  }

  /** Opens the camera and starts delivering frames. Does nothing if it is already running or starting. */
  fun start() {
    synchronized(lock) { if (run != null || closed) return }
    if (!hasPermission()) return onStatus(CameraStatus.NO_PERMISSION)
    val id =
        try {
          findCamera()
        } catch (e: Exception) {
          Log.w(TAG, "Camera lookup failed", e)
          return onStatus(CameraStatus.ERROR)
        } ?: return onStatus(CameraStatus.NO_CAMERA)

    val r =
        try {
          Run(ImageReader.newInstance(WIDTH, HEIGHT, ImageFormat.YUV_420_888, MAX_IMAGES))
        } catch (e: Exception) {
          Log.w(TAG, "Camera image reader failed", e)
          return onStatus(CameraStatus.ERROR)
        }
    synchronized(lock) {
      if (run != null || closed) {
        release(r)
        return
      }
      run = r
    }
    onStatus(CameraStatus.STARTING)
    try {
      // Queued ahead of any frame from this run, on the same thread as onFrame.
      frameHandler.post { if (current(r)) onRunStart() }
      r.reader.setOnImageAvailableListener({ deliver(r) }, frameHandler)
      manager.openCamera(id, Executor { camHandler.post(it) }, deviceCallback(r))
    } catch (e: SecurityException) {
      Log.w(TAG, "Camera permission refused on open", e)
      fail(r, CameraStatus.NO_PERMISSION)
    } catch (e: Exception) {
      Log.w(TAG, "Camera $id failed to open", e)
      fail(r, CameraStatus.ERROR)
    }
  }

  /**
   * Closes the camera, without waiting for a frame in progress (it finishes on the frame thread, and a following
   * [start]'s frames queue behind it). Safe to call at any time, and more than once.
   */
  fun stop() {
    val r = synchronized(lock) { run.also { run = null } } ?: return
    release(r)
  }

  /** Stops the camera for good and ends its threads. [start] does nothing afterwards. */
  fun close() {
    synchronized(lock) { closed = true }
    stop()
    frameThread.quitSafely()
    camThread.quitSafely()
  }

  private fun current(r: Run): Boolean = synchronized(lock) { run === r }

  private fun hasPermission(): Boolean =
      listOf(Manifest.permission.CAMERA, PERMISSION_HEADSET_CAMERA).all {
        context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
      }

  /** The left passthrough camera's ID, or null (after logging every camera's vendor keys) if there is none. */
  private fun findCamera(): String? {
    val seen = mutableListOf<String>()
    for (id in manager.cameraIdList) {
      val chars = manager.getCameraCharacteristics(id)
      val source = vendorKey(chars, KEY_SOURCE)
      val position = vendorKey(chars, KEY_POSITION)
      seen.add("$id (source=$source, position=$position)")
      if (source != SOURCE_PASSTHROUGH || position != POSITION_LEFT) continue

      val sizes = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)?.getOutputSizes(ImageFormat.YUV_420_888)
      if (sizes != null && sizes.none { it.width == WIDTH && it.height == HEIGHT }) {
        Log.w(TAG, "Camera $id has no ${WIDTH}x$HEIGHT YUV output; sizes: ${sizes.joinToString()}")
        continue
      }
      val k = chars.get(CameraCharacteristics.LENS_INTRINSIC_CALIBRATION)
      val t = chars.get(CameraCharacteristics.LENS_POSE_TRANSLATION)
      val q = chars.get(CameraCharacteristics.LENS_POSE_ROTATION)
      val raw =
          if (k != null && k.size >= 4)
              CameraIntrinsics(k[0].toDouble(), k[1].toDouble(), k[2].toDouble(), k[3].toDouble(),
                  t ?: FloatArray(0), q ?: FloatArray(0))
          else null
      // Android gives LENS_INTRINSIC_CALIBRATION against the pre-correction active array (the active array when
      // distortion correction is on); Meta's passthrough samples scale it from the pre-correction array to the stream.
      val preCorrection = chars.get(CameraCharacteristics.SENSOR_INFO_PRE_CORRECTION_ACTIVE_ARRAY_SIZE)
      val active = chars.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
      val ref = preCorrection ?: active
      intrinsics =
          if (raw != null && ref != null && ref.width() > 0 && ref.height() > 0)
              scaleIntrinsics(raw, ref.width(), ref.height(), WIDTH, HEIGHT)
          else raw
      if (!loggedCamera) {
        loggedCamera = true
        val reference = chars.get(CameraCharacteristics.LENS_POSE_REFERENCE)
        val refText =
            when {
              ref == null -> "none, so intrinsics are used unscaled"
              ref === preCorrection -> "pre-correction active array $ref"
              else -> "active array $ref (no pre-correction array)"
            }
        Log.i(TAG, "Passthrough camera $id at ${WIDTH}x$HEIGHT; pre-correction array $preCorrection, active array $active")
        Log.i(TAG, "Intrinsics reference: $refText")
        Log.i(TAG, "Raw intrinsics: ${raw ?: "none"}")
        Log.i(TAG, "Intrinsics at ${WIDTH}x$HEIGHT: ${intrinsics ?: "none"}")
        Log.i(TAG, "Lens pose reference: ${lensPoseReferenceName(reference)}")
      }
      return id
    }
    Log.i(TAG, "No left passthrough camera; cameras: ${seen.joinToString().ifEmpty { "none" }}")
    return null
  }

  private fun lensPoseReferenceName(r: Int?): String =
      when (r) {
        null -> "not reported"
        CameraCharacteristics.LENS_POSE_REFERENCE_PRIMARY_CAMERA -> "PRIMARY_CAMERA ($r)"
        CameraCharacteristics.LENS_POSE_REFERENCE_GYROSCOPE -> "GYROSCOPE ($r)"
        CameraCharacteristics.LENS_POSE_REFERENCE_UNDEFINED -> "UNDEFINED ($r)"
        CameraCharacteristics.LENS_POSE_REFERENCE_AUTOMOTIVE -> "AUTOMOTIVE ($r)"
        else -> "unknown ($r)"
      }

  /** A Meta vendor key's value, or null where the device doesn't know the key (any non-Meta device). */
  private fun vendorKey(chars: CameraCharacteristics, name: String): Int? =
      try {
        chars.get(CameraCharacteristics.Key(name, Int::class.javaObjectType))
      } catch (e: IllegalArgumentException) {
        null
      }

  private fun deviceCallback(r: Run) =
      object : CameraDevice.StateCallback() {
        override fun onOpened(camera: CameraDevice) {
          synchronized(lock) {
            if (run !== r) {
              camera.close()
              return
            }
            r.device = camera
          }
          try {
            val config =
                SessionConfiguration(
                    SessionConfiguration.SESSION_REGULAR,
                    listOf(OutputConfiguration(r.reader.surface)),
                    Executor { camHandler.post(it) },
                    sessionCallback(r, camera),
                )
            camera.createCaptureSession(config)
          } catch (e: Exception) {
            Log.w(TAG, "Camera session failed", e)
            fail(r, CameraStatus.ERROR)
          }
        }

        override fun onDisconnected(camera: CameraDevice) {
          Log.w(TAG, "Camera disconnected")
          camera.close()
          fail(r, CameraStatus.ERROR)
        }

        override fun onError(camera: CameraDevice, error: Int) {
          Log.w(TAG, "Camera error $error")
          camera.close()
          fail(r, if (error == ERROR_CAMERA_DISABLED) CameraStatus.NO_PERMISSION else CameraStatus.ERROR)
        }
      }

  private fun sessionCallback(r: Run, camera: CameraDevice) =
      object : CameraCaptureSession.StateCallback() {
        override fun onConfigured(s: CameraCaptureSession) {
          synchronized(lock) {
            if (run !== r) {
              s.close()
              return
            }
            r.session = s
          }
          try {
            val request = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply { addTarget(r.reader.surface) }
            s.setRepeatingRequest(request.build(), null, null)
          } catch (e: Exception) {
            Log.w(TAG, "Camera capture failed to start", e)
            fail(r, CameraStatus.ERROR)
          }
        }

        override fun onConfigureFailed(s: CameraCaptureSession) {
          Log.w(TAG, "Camera session configuration failed")
          fail(r, CameraStatus.ERROR)
        }
      }

  /**
   * Runs on the frame thread: takes the newest frame (older ones queued behind it are dropped), copies its Y plane,
   * closes it, then runs [onFrame]. Frames that arrive during [onFrame] wait in the reader and all but the newest
   * are dropped by the next call.
   */
  private fun deliver(r: Run) {
    val image =
        try {
          r.reader.acquireLatestImage()
        } catch (e: IllegalStateException) {
          null // the reader was closed under us
        } ?: return
    val width: Int
    val height: Int
    val stride: Int
    val timestamp: Long
    try {
      if (!current(r)) return
      width = image.width
      height = image.height
      timestamp = image.timestamp
      val plane = image.planes[0]
      val buf = plane.buffer
      if (plane.pixelStride == 1) {
        stride = plane.rowStride
        if (gray.size < stride * height) gray = ByteArray(stride * height)
        buf.rewind()
        buf.get(gray, 0, minOf(buf.remaining(), gray.size))
      } else {
        // Not expected for a Y plane; pack it so the detector still gets one byte per pixel.
        stride = width
        if (gray.size < width * height) gray = ByteArray(width * height)
        for (y in 0 until height) for (x in 0 until width) {
          gray[y * width + x] = buf.get(y * plane.rowStride + x * plane.pixelStride)
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "Bad camera frame", e)
      return
    } finally {
      image.close()
    }
    if (!current(r)) return
    val ok =
        try {
          onFrame(gray, width, height, stride, timestamp)
          true
        } catch (e: Exception) {
          if (!r.loggedFrameError) {
            r.loggedFrameError = true
            Log.w(TAG, "Frame processing failed; skipping such frames", e)
          }
          false
        }
    // Re-checked so a run that failed or stopped meanwhile never reports RUNNING after its ERROR.
    if (!current(r)) return
    if (ok) {
      r.failures.succeed()
      if (!r.reportedRunning) {
        r.reportedRunning = true
        onStatus(CameraStatus.RUNNING)
      }
    } else if (r.failures.fail()) {
      Log.w(TAG, "$FAILURES_TO_ERROR frames in a row failed: reporting a camera error until one succeeds")
      r.reportedRunning = false
      onStatus(CameraStatus.ERROR)
    }
  }

  /** Shuts run [r] down and reports [status], unless a [stop] or a newer [start] has already replaced it. */
  private fun fail(r: Run, status: CameraStatus) {
    synchronized(lock) {
      if (run !== r) return
      run = null
    }
    release(r)
    onStatus(status)
  }

  private fun release(r: Run) {
    val (session, device) = synchronized(lock) { (r.session to r.device).also { r.session = null; r.device = null } }
    try {
      session?.close()
    } catch (e: Exception) {
      Log.w(TAG, "Closing the camera session", e)
    }
    try {
      device?.close()
    } catch (e: Exception) {
      Log.w(TAG, "Closing the camera", e)
    }
    // Close the reader on the frame thread, after any frame in progress there.
    if (!frameHandler.post { r.reader.close() }) r.reader.close()
  }

  companion object {
    const val WIDTH = 1280
    const val HEIGHT = 960
    private const val TAG = "VirviAR"
    private const val MAX_IMAGES = 2
    /** Consecutive failed frames (an exception from onFrame) before the status turns to ERROR. */
    const val FAILURES_TO_ERROR = 30
    const val PERMISSION_HEADSET_CAMERA = "horizonos.permission.HEADSET_CAMERA"
    private const val KEY_SOURCE = "com.meta.extra_metadata.camera_source"
    private const val KEY_POSITION = "com.meta.extra_metadata.position"
    private const val SOURCE_PASSTHROUGH = 0
    private const val POSITION_LEFT = 0
  }
}

/** Counts failures in a row: [fail] is true once, on the failure that reaches [limit]; [succeed] restarts the count. */
class FailureStreak(private val limit: Int) {
  private var count = 0

  fun fail(): Boolean = ++count == limit

  fun succeed() {
    count = 0
  }
}
