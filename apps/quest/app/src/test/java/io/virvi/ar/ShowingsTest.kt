package io.virvi.ar

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShowingsTest {
  private val t0 = 1_800_000_000_000L
  private val trailer = ProgrammeItem("https://x/trailer.mp4", 60.0, "ad")
  private val film = ProgrammeItem("https://x/film.mp4", 5400.0, "video")
  private fun show(start: Long = t0, id: String = "s1", items: List<ProgrammeItem> = listOf(trailer, film)) =
      ShowingInstance(id, start, items, "Film")

  @Test
  fun `between showings it counts down to the next`() {
    val s = screenStateAt(listOf(show()), t0 - 1000) as ScreenState.Between
    assertEquals("s1", s.next?.showingId)
    assertEquals(1.0, s.startsIn!!, 1e-9)
    assertNull((screenStateAt(emptyList(), t0) as ScreenState.Between).next)
  }

  @Test
  fun `mid-film it is the film and how far in`() {
    val s = screenStateAt(listOf(show()), t0 + ((60 + 754.5) * 1000).toLong()) as ScreenState.Playing
    assertEquals(1, s.index)
    assertEquals(754.5, s.offset, 1e-6)
    assertEquals(t0 + 60_000, s.itemStartsAt)
  }

  @Test
  fun `items with no length are skipped, and after the end it is between`() {
    val s = show(items = listOf(ProgrammeItem("https://x/none.mp4", 0.0, "ad"), film))
    assertEquals(1, (screenStateAt(listOf(s), t0 + 1000) as ScreenState.Playing).index)
    assertTrue(screenStateAt(listOf(s), t0 + 5_400_000) is ScreenState.Between)
  }

  @Test
  fun `the later start wins when showings overlap`() {
    val s = screenStateAt(listOf(show(id = "a"), show(start = t0 + 10_000, id = "b")), t0 + 20_000) as ScreenState.Playing
    assertEquals("b", s.showing.showingId)
  }

  @Test
  fun `parses the feed's showings by screen, dropping malformed ones`() {
    val json =
        Json.parseToJsonElement(
            """[{"elementId":"tv","showings":[{"showingId":"s1","startsAt":$t0,"title":"Film",
                 "items":[{"url":"https://x/film.mp4","duration":5400,"kind":"video"},{"url":7}]},{"startsAt":"x"}]},
                {"showings":[]}]"""
        )
    val m = parseShowings(json)
    assertEquals(setOf("tv"), m.keys)
    assertEquals(listOf(ShowingInstance("s1", t0, listOf(film), "Film")), m["tv"])
    assertTrue(parseShowings(null).isEmpty())
  }

  private fun scheduled(holding: String? = "https://x/poster.png"): List<RenderItem> {
    val off = holding?.let { ""","offImageSrc":"$it"""" } ?: ""
    val scene = Json.parseToJsonElement("""{"videos":[{"sk":"tv","offType":6$off,"volume":0.7,"instances":[{"sk":"i1"}]}]}""").jsonObject
    return planScene(scene)
  }

  @Test
  fun `schedule mode plans a scheduled screen with its holding image`() {
    val item = scheduled().single()
    assertTrue(item.scheduled)
    assertEquals("https://x/poster.png", item.holdingImage)
  }

  @Test
  fun `a scheduled screen shows the holding image between shows, then each video from where the show is`() {
    val base = scheduled()
    val shows = mapOf("tv" to listOf(show()))
    val before = resolveScheduled(base, shows, t0 - 1000).single()
    assertEquals(RenderItem.Kind.IMAGE, before.kind)
    assertEquals("https://x/poster.png", before.src)
    assertNull(before.play)

    val inTrailer = resolveScheduled(base, shows, t0 + 10_000).single()
    assertEquals(RenderItem.Kind.VIDEO, inTrailer.kind)
    assertEquals("https://x/trailer.mp4", inTrailer.src)
    assertFalse(inTrailer.loop)
    assertEquals(ScheduledPlay(t0, 60.0), inTrailer.play)
    // The plan stays the same while the same video plays, so the renderer leaves it alone
    assertEquals(inTrailer, resolveScheduled(base, shows, t0 + 20_000).single())

    val inFilm = resolveScheduled(base, shows, t0 + 61_000).single()
    assertEquals(ScheduledPlay(t0 + 60_000, 5400.0), inFilm.play)
    assertEquals("https://x/film.mp4", inFilm.src)
  }

  @Test
  fun `with no holding image the screen shows nothing between shows, and a video the headset can't play counts as between`() {
    assertTrue(resolveScheduled(scheduled(null), mapOf("tv" to listOf(show())), t0 - 1000).isEmpty())
    val mov = mapOf("tv" to listOf(show(items = listOf(ProgrammeItem("https://x/film.mov", 600.0, "video")))))
    assertEquals(RenderItem.Kind.IMAGE, resolveScheduled(scheduled(), mov, t0 + 1000).single().kind)
  }

  @Test
  fun `other items pass through untouched`() {
    val scene = Json.parseToJsonElement("""{"images":[{"sk":"img","textureSrc":"https://x/a.png","instances":[{"sk":"i"}]}]}""").jsonObject
    val plan = planScene(scene)
    assertEquals(plan, resolveScheduled(plan, emptyMap(), t0))
  }

  @Test
  fun `drift is corrected past 2 s, at most every 5 s, after 30 s to settle, 3 times, never in the last 10 s`() {
    val g = SeekGuard(startedAt = 0)
    assertFalse(g.shouldSeek(now = 10_000, expected = 10.0, actual = 0.0, duration = 600.0, playing = true)) // settling
    assertFalse(g.shouldSeek(31_000, 31.0, 30.0, 600.0, true)) // within 2 s
    assertFalse(g.shouldSeek(33_000, 33.0, 20.0, 600.0, true)) // checked under 5 s ago
    assertTrue(g.shouldSeek(37_000, 37.0, 20.0, 600.0, true))
    assertFalse(g.shouldSeek(70_000, 70.0, 20.0, 600.0, false)) // paused
    assertTrue(g.shouldSeek(70_000, 70.0, 20.0, 600.0, true))
    assertTrue(g.shouldSeek(110_000, 110.0, 20.0, 600.0, true))
    assertFalse(g.shouldSeek(150_000, 150.0, 20.0, 600.0, true)) // 3 re-seeks used
    assertFalse(SeekGuard(0).shouldSeek(595_000, 595.0, 500.0, 600.0, true)) // last 10 s
  }
}
