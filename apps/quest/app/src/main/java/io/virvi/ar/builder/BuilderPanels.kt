package io.virvi.ar.builder

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.virvi.ar.api.DeviceSpace

/**
 * The builder panel: [prompt]'s line ("Finding your spaces…", a failure, or "Look at a ring of <space>"), the spaces
 * to choose from when it has some ([onPick]), **Scan this room** ([scanRoom], when [BuilderPrompt.scanRoom]: a
 * personal headset, with or without spaces; the list is hidden while the scan is open, [scanOpen]), and its button
 * ([onCancel]: **Cancel**, or **Close** for a notice).
 */
@Composable
fun BuilderPromptPanel(
    prompt: BuilderPrompt,
    onPick: (DeviceSpace) -> Unit,
    onCancel: () -> Unit,
    scanOpen: Boolean = false,
    scanRoom: @Composable () -> Unit = {},
) {
  MaterialTheme(colorScheme = darkColorScheme()) {
    Column(
        Modifier.fillMaxSize().background(Color(0xF0101420), RoundedCornerShape(16.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Text(prompt.text, color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
      if (prompt.spaces.isNotEmpty() && !(prompt.scanRoom && scanOpen)) {
        Column(
            Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
          prompt.spaces.forEach { s ->
            Button(onClick = { onPick(s) }, modifier = Modifier.fillMaxWidth()) {
              Text(if (s.sceneName.isBlank() || s.sceneName == s.spaceName) s.spaceName else "${s.spaceName} · ${s.sceneName}", fontSize = 14.sp)
            }
          }
        }
      }
      if (prompt.scanRoom) scanRoom()
      OutlinedButton(onClick = onCancel) { Text(prompt.button) }
    }
  }
}

/**
 * The ring panel while building: the check of the floor's ring in view ([ringCheckLines]) and **Record this ring** /
 * **Re-record this ring** ([onRecord]).
 */
@Composable
fun RingCheckPanel(ring: RingCheckUi, onRecord: () -> Unit) {
  MaterialTheme(colorScheme = darkColorScheme()) {
    Column(
        Modifier.fillMaxSize().background(Color(0xF0101420), RoundedCornerShape(16.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      val view = ring.view
      ringCheckLines(view, ring.status).forEach {
        Text(it, color = if (it == view.line && view.warn) Color(0xFFFFB74D) else Color(0xFFE0E0E0), fontSize = 15.sp)
      }
      when (view.button) {
        RingButton.Record -> Button(onClick = onRecord) { Text("Record this ring") }
        RingButton.ReRecord -> Button(onClick = onRecord) { Text("Re-record this ring") }
        RingButton.None -> Unit
      }
    }
  }
}
