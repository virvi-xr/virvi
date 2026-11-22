package io.virvi.ar

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.virvi.ar.ring.CameraStatus
import io.virvi.ar.ring.cameraStatusText

/** The developer panel (debug builds only, opened from the menu): the scene, occlusion and the marker readings. */
@Composable
fun ControlPanel(s: AppState, act: DeveloperActions) {
  MaterialTheme(colorScheme = darkColorScheme()) {
    Column(
        Modifier.fillMaxSize()
            .background(Color(0xF0101420), RoundedCornerShape(24.dp))
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Text("Developer", color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold)

      Section("Scene")
      Line(s.serverUrl, mono = true)
      Line("${s.visitorState} · feed ${s.feed?.name ?: "IDLE"} · ${s.itemCount} items")
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Switch(s.modelTurn, act::setModelTurn)
        Line("Turn models half a turn (check against Decentraland)")
      }

      Section("Hide behind real things")
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Occlusion.entries.forEach { o ->
          if (o == s.occlusion) Button(onClick = { act.setOcclusion(o) }) { Text(o.label) }
          else OutlinedButton(onClick = { act.setOcclusion(o) }) { Text(o.label) }
        }
      }
      Line(s.occlusionStatus)
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Switch(s.showWalls, act::setShowWalls)
        Line("Show scanned walls (check they match the real ones)")
      }

      Section("ARC test")
      Line(s.markerStatus)
      val cam = s.cameraStatus
      if (cam != null) Line(cameraStatusText(cam), if (cam == CameraStatus.STARTING || cam == CameraStatus.RUNNING) Color(0xFFE0E0E0) else Color(0xFFFF8A80))
      Line(s.wallStatus)
      s.markerLines.forEachIndexed { i, line ->
        Line(line, mono = true)
        s.poseLines.getOrNull(i)?.let { Line(it, Color(0xFFB0BEC5), mono = true) }
      }
      Line(s.lastRing, mono = true)
      OutlinedButton(onClick = act::resetReadings) { Text("Reset readings") }
    }
  }
}

@Composable
private fun Section(text: String) {
  Text(text, color = Color(0xFFB4A8FF), fontSize = 18.sp, fontWeight = FontWeight.SemiBold,
      modifier = Modifier.padding(top = 8.dp))
}

@Composable
private fun Line(text: String, color: Color = Color(0xFFE0E0E0), mono: Boolean = false) {
  Text(text, color = color, fontSize = 15.sp, fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default)
}
