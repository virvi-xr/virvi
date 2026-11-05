package io.virvi.ar.builder

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The builder HUD's Stream tab (LIV-53, LIV-54), as the Decentraland HUD's Stream panel does it. */
class StreamPanelTest {
  private fun json(s: String) = Json.parseToJsonElement(s).jsonObject

  private val scene =
      json(
          """{"scene":{"activePresetId":"live","presets":[
            {"id":"old","elements":[{"id":"v0","type":"video","name":"Old","properties":{}}]},
            {"id":"live","elements":[
              {"id":"v1","type":"video","name":"Big screen","properties":{"liveSrc":" https://live/main.m3u8 ","enableLiveStream":true,"offImageSrc":"https://x/poster.png","offType":1}},
              {"id":"i1","type":"image","name":"Poster","properties":{}},
              {"id":"v2","type":"video","name":"","properties":null}]}]}}"""
      )

  private val streams = listOf(
      SceneStream("s1", "Main Stage", "https://live/main.m3u8", live = true, mine = false),
      SceneStream("s2", "Editor Cam", "https://live/cam.m3u8", live = false, mine = true),
  )

  @Test
  fun `lists the live preset's video screens with their stream, live switch and off image`() {
    assertEquals(
        listOf(
            StreamScreen("v1", "Big screen", "https://live/main.m3u8", liveOn = true, offImageSrc = "https://x/poster.png"),
            StreamScreen("v2", "Video screen", "", liveOn = false, offImageSrc = ""),
        ),
        streamScreens(scene),
    )
    assertEquals(emptyList<StreamScreen>(), streamScreens(json("{}")))
  }

  @Test
  fun `reads the scene's streams, never anything else`() {
    val body = json("""{"streams":[{"id":"s1","name":"Main Stage","hlsPlaylistUrl":"https://live/main.m3u8","live":true,"mine":false},{"id":"bad"}]}""")
    assertEquals(listOf(streams[0]), parseSceneStreams(body))
  }

  @Test
  fun `names a screen's stream as the dashboard does`() {
    assertEquals("Main Stage (live)", streamOptionLabel(streams[0]))
    assertEquals("Editor Cam (offline, yours)", streamOptionLabel(streams[1]))
    val screen = streamScreens(scene)[0]
    assertEquals("Main Stage (live)", screenSourceLabel(screen, streams))
    assertEquals("Custom link", screenSourceLabel(screen.copy(liveSrc = "https://elsewhere/x.m3u8"), streams))
    assertEquals("No stream", screenSourceLabel(screen.copy(liveSrc = ""), streams))
  }

  @Test
  fun `offers the library's ready images as off images, named as the library names them`() {
    val library =
        json(
            """{"items":[
              {"id":"a","kind":"media","name":"Poster","url":"https://x/poster.png","contentType":"image/png","status":"ready"},
              {"id":"b","kind":"media","name":"Loop","url":"https://x/v.mp4","contentType":"video/mp4","status":"ready"},
              {"id":"c","kind":"media","name":"Busy","url":"https://x/c.jpg","contentType":"image/jpeg","status":"processing"},
              {"id":"d","kind":"model","name":"Chair","url":"https://x/m.glb","status":"ready"},
              {"id":"e","kind":"media","name":"Anim","url":"https://x/e.gif","contentType":"image/gif","status":"ready"}]}"""
        )
    val images = offImageChoices(library)
    assertEquals(listOf(OffImage("a", "Poster", "https://x/poster.png"), OffImage("e", "Anim", "https://x/e.gif")), images)
    val screen = streamScreens(scene)[0]
    assertEquals("Off image: Poster", offImageLabel(screen, images))
    assertEquals("Off image: from a link", offImageLabel(screen.copy(offImageSrc = "https://elsewhere/q.png"), images))
    assertEquals("No off image", offImageLabel(screen.copy(offImageSrc = ""), images))
  }

  @Test
  fun `a change keeps the screen's other properties, and a cleared image is sent as empty`() {
    val props = elementProperties(scene, "v1")!!
    val next = withProperty(props, "offImageSrc", "")
    assertEquals(JsonPrimitive(""), next["offImageSrc"])
    assertEquals(JsonPrimitive(1), next["offType"])
    assertEquals(JsonPrimitive("https://live/main.m3u8".let { " $it " }), next["liveSrc"])
    assertEquals(JsonObject(mapOf("liveSrc" to JsonPrimitive("u"))), withProperty(elementProperties(scene, "v2"), "liveSrc", "u"))
    assertNull(elementProperties(scene, "gone"))
  }
}
