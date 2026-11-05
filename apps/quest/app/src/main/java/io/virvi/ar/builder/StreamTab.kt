package io.virvi.ar.builder

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val TEXT = Color.White
private val SUBTLE = Color(0xFFB0B8C8)
private val WARN = Color(0xFFFFB74D)
private val LIVE = Color(0xFF66BB6A)
private val CARD = Color(0xFF1A2030)

/**
 * The Stream tab (LIV-53, LIV-54), as the Decentraland HUD's Stream panel: each video screen of the live preset with
 * its stream (**Choose stream** lists the scene's), **Turn live on / off**, and its off image (**Change** lists the
 * library's images, up to 8, and **No off image**).
 */
@Composable
fun StreamTab(state: StreamsState, actions: StreamActions) {
  val screens = state.screens
  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    state.message?.let { Text(it, color = WARN, fontSize = 13.sp) }
    when {
      screens == null -> Text(if (state.failed) STREAMS_FAILED else STREAMS_LOADING, color = SUBTLE, fontSize = 14.sp)
      screens.isEmpty() -> Text(NO_SCREENS, color = SUBTLE, fontSize = 14.sp)
      else ->
          LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(screens, key = { it.id }) { s -> ScreenCard(s, state, actions) }
          }
    }
  }
}

@Composable
private fun ScreenCard(s: StreamScreen, state: StreamsState, actions: StreamActions) {
  val open = state.picking?.takeIf { it.elementId == s.id }?.list
  Column(
      Modifier.fillMaxWidth().background(CARD, RoundedCornerShape(8.dp)).padding(8.dp),
      verticalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Text(if (s.liveOn) "LIVE ON" else "LIVE OFF", color = if (s.liveOn) LIVE else SUBTLE, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
      Text(s.name, color = TEXT, fontSize = 14.sp, modifier = Modifier.padding(start = 8.dp))
    }
    Text(screenSourceLabel(s, state.streams), color = SUBTLE, fontSize = 12.sp)
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
      OutlinedButton(onClick = { actions.pick(s.id, StreamPick.List.STREAM) }) {
        Text(if (open == StreamPick.List.STREAM) "Close list" else "Choose stream")
      }
      Button(onClick = { actions.toggleLive(s.id) }, enabled = !state.busy) { Text(if (s.liveOn) "Turn live off" else "Turn live on") }
    }
    if (open == StreamPick.List.STREAM) {
      if (state.streams.isEmpty()) Text(NO_STREAMS, color = SUBTLE, fontSize = 12.sp)
      state.streams.forEach { st ->
        TextButton(onClick = { actions.chooseStream(s.id, st.id) }, enabled = !state.busy) {
          Text((if (st.hlsPlaylistUrl == s.liveSrc) "✓ " else "") + streamOptionLabel(st), color = TEXT, fontSize = 13.sp)
        }
      }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
      Text(offImageLabel(s, state.images), color = SUBTLE, fontSize = 12.sp, modifier = Modifier.weight(1f))
      OutlinedButton(onClick = { actions.pick(s.id, StreamPick.List.OFF_IMAGE) }) {
        Text(if (open == StreamPick.List.OFF_IMAGE) "Close list" else "Change")
      }
    }
    if (open == StreamPick.List.OFF_IMAGE) {
      Text(OFF_IMAGE_HINT, color = SUBTLE, fontSize = 11.sp)
      if (state.images.isEmpty()) Text(NO_IMAGES, color = SUBTLE, fontSize = 12.sp)
      state.images.take(OFF_IMAGE_LIST_MAX).forEach { img ->
        TextButton(onClick = { actions.chooseOffImage(s.id, img.url) }, enabled = !state.busy) {
          Text((if (img.url == s.offImageSrc) "✓ " else "") + img.name, color = TEXT, fontSize = 13.sp)
        }
      }
      if (state.images.size > OFF_IMAGE_LIST_MAX) {
        Text("+${state.images.size - OFF_IMAGE_LIST_MAX} more: choose them on the dashboard", color = SUBTLE, fontSize = 11.sp)
      }
      if (s.offImageSrc.isNotEmpty()) {
        TextButton(onClick = { actions.chooseOffImage(s.id, "") }, enabled = !state.busy) { Text("No off image", color = TEXT, fontSize = 13.sp) }
      }
    }
  }
}
