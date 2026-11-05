package io.virvi.ar.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class ArModelsTest {
  private val fixture =
      """
      {"v":1,"version":"abc","space":{"id":"s1","name":"Loft","place":null,"lat":1.5,"lng":2.5,"published":true,
        "floors":[{"id":"f1","name":"Ground","heightM":0,"sortOrder":0,"markers":[
          {"id":"m1","ringId":775769179,"code":"ABCD","diameterMm":150,"whereText":"By the door",
           "pose":{"x":1,"y":1.5,"z":-2,"headingDeg":90}},
          {"id":"m2","ringId":5,"code":"EFGH","diameterMm":150,"whereText":null,"pose":null}]}]},
       "scene":{"images":[],"videos":[],"models":[],"sounds":[]}}
      """

  @Test
  fun `parses a feed with a space, floors, markers and a scene`() {
    val snap = parseFeed(fixture)!!
    assertEquals("abc", snap.version)
    assertNotNull(snap.scene)
    val (floor, marker) = snap.space.markerByRing(0x2E3D4C5B)!!
    assertEquals("f1", floor.id)
    assertEquals("m1", marker.id)
    assertEquals(MarkerPose(1.0, 1.5, -2.0, 90.0), marker.pose)
    assertNull(snap.space.markerByRing(5)!!.second.pose)
    assertNull(snap.space.markerByRing(5)!!.second.whereText)
    assertNull(snap.space.markerByRing(99))
  }

  @Test
  fun `a feed may have no scene`() {
    assertNull(parseFeed(fixture.replace("""{"images":[],"videos":[],"models":[],"sounds":[]}""", "null"))!!.scene)
  }

  @Test
  fun `refuses an unknown feed version`() {
    assertNull(parseFeed(fixture.replace("\"v\":1", "\"v\":2")))
  }

  @Test
  fun `refuses malformed feeds`() {
    assertNull(parseFeed("not json"))
    assertNull(parseFeed("""{"v":1,"version":"a"}"""))
  }

  @Test
  fun `parses a marker lookup`() {
    val l = parseLookup("""{"spaceId":"s","floorId":"f","markerId":"m","spaceName":"Loft","whereText":null}""")!!
    assertEquals(MarkerLookup("s", "f", "m", "Loft", null), l)
  }

  @Test
  fun `parses the showings of scheduled screens and the server clock`() {
    val body = fixture.trimEnd().removeSuffix("}") +
        ""","showings":[{"elementId":"tv","showings":[{"showingId":"s1","startsAt":1800000000000,"items":[{"url":"https://x/f.mp4","duration":60}]}]}],"serverTime":1800000000500}"""
    val snap = parseFeed(body)!!
    assertEquals(1, snap.showings["tv"]!!.size)
    assertEquals(1_800_000_000_500L, snap.serverTime)
    val plain = parseFeed(fixture)!!
    assertEquals(emptyMap<String, Any>(), plain.showings)
    assertNull(plain.serverTime)
  }
}
