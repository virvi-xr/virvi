package io.virvi.ar

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class ScenePlanTest {
  @Test
  fun imagesVideosModelsAndSkips() {
    val scene =
        Json.parseToJsonElement(
                """
        {"images":[{"sk":"img","textureSrc":"https://x/a.PNG?x=1","instances":[
            {"sk":"i1","position":{"x":1,"y":2,"z":3},"scale":{"x":4,"y":2,"z":1}},
            {"sk":"i2","enabled":false}]},
          {"sk":"gif","textureSrc":"https://x/a.gif","instances":[{"sk":"g"}]}],
         "videos":[{"sk":"vid","offType":1,"offImageSrc":"https://x/off.jpg","instances":[{"sk":"v1"}]},
                   {"sk":"pl","offType":2,"playlist":["https://x/p.mp4"],"volume":0.5,"instances":[{"sk":"p1"}]}],
         "models":[{"sk":"m","modelSrc":"https://x/m.glb","enabled":true,"instances":[{"sk":7}]},
                   {"sk":"off","modelSrc":"https://x/o.glb","enabled":false,"instances":[{"sk":"o1"}]}],
         "sounds":[]}
        """
            )
            .jsonObject
    val items = planScene(scene)
    assertEquals(listOf("vid:v1", "pl:p1", "img:i1", "m:7"), items.map { it.key })
    assertEquals(RenderItem.Kind.IMAGE, items[0].kind)
    assertEquals(0.0, items[0].volume, 0.0)
    assertEquals(RenderItem.Kind.VIDEO, items[1].kind)
    assertEquals(0.5, items[1].volume, 0.0)
    assertEquals(4.0, items[2].width, 0.0)
    assertEquals(2.0, items[2].height, 0.0)
    assertEquals(Vec3(1.0, 2.0, 3.0), items[2].transform.position)
    assertEquals("m.glb", items[3].name)
  }

  @Test
  fun playlistModeCarriesThePlaylist() {
    fun video(playlist: String) =
        planScene(
                Json.parseToJsonElement(
                        """{"videos":[{"sk":"pl","offType":2,"playlist":$playlist,"instances":[{"sk":"p1"}]}]}"""
                    )
                    .jsonObject
            )
            .firstOrNull()
    val three = video("""["https://x/1.mp4","https://x/2.webm","https://x/3.m3u8","https://x/4.mp4"]""")!!
    assertEquals("https://x/1.mp4", three.src)
    assertEquals(listOf("https://x/1.mp4", "https://x/3.m3u8", "https://x/4.mp4"), three.playlist)
    assertEquals(false, three.loop)
    val one = video("""["https://x/a.webm","https://x/1.mp4"]""")!!
    assertEquals(listOf("https://x/1.mp4"), one.playlist)
    assertEquals(true, one.loop)
    assertEquals(null, video("[]"))
    val live =
        planScene(
                Json.parseToJsonElement(
                        """{"videos":[{"sk":"l","isLive":true,"enableLiveStream":true,"liveSrc":"https://x/s.m3u8","instances":[{"sk":"1"}]}]}"""
                    )
                    .jsonObject
            )
            .single()
    assertEquals(emptyList<String>(), live.playlist)
  }

  @Test
  fun diff() {
    fun plan(json: String) = planScene(Json.parseToJsonElement(json).jsonObject)
    val a = plan("""{"images":[{"sk":"e","textureSrc":"https://x/a.png","instances":[{"sk":"1"},{"sk":"2"}]}]}""")
    val b =
        plan(
            """{"images":[{"sk":"e","textureSrc":"https://x/a.png","instances":[{"sk":"2","scale":{"x":2}},{"sk":"3"}]}]}"""
        )
    val d = diffPlans(a, b)
    assertEquals(listOf("e:1"), d.remove)
    assertEquals(listOf("e:2"), d.update.map { it.key })
    assertEquals(listOf("e:3"), d.add.map { it.key })
  }
}
