package io.virvi.ar.api

import org.junit.Assert.assertFalse
import org.junit.Test

/** Tokens and response bodies must not reach a log or a crash report through `toString`. */
class SecretsInTextTest {
  @Test
  fun `new tokens print without the tokens`() {
    val text = RefreshResult.Tokens("access-secret-1", "refresh-secret-2").toString()
    assertFalse(text, text.contains("access-secret-1"))
    assertFalse(text, text.contains("refresh-secret-2"))
  }

  @Test
  fun `an app response prints without its body`() {
    val text = AppResponse.Response(200, """{"accessToken":"body-secret-3"}""").toString()
    assertFalse(text, text.contains("body-secret-3"))
  }
}
