package io.virvi.ar.builder

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
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

/** The lines the panel shows for [state], top to bottom: the instruction, then [extra] notes (size and floor warnings). */
fun alignLines(state: AlignState, extra: List<String>): List<String> =
    when (state) {
      AlignState.LookAtRing -> listOf("Look at the ARC")
      is AlignState.Placed -> listOf("Left stick moves the scene, right stick turns it. Hold the grip for fine steps.") + extra
      AlignState.Saving -> listOf("Saving…")
      is AlignState.Saved -> listOf("Alignment saved") + extra
      is AlignState.Refused -> listOf(state.reason) + extra
    }

/**
 * The lines for the ring in view ([RingCheckFlow.view]), top to bottom: the check or refusal line, why it can't be
 * re-recorded, the second-ring suggestion, then the save [status] (each said once). The first is the warning when
 * [RingCheckView.warn].
 */
fun ringCheckLines(view: RingCheckView, status: String?): List<String> =
    listOfNotNull(view.line, view.refusal, view.suggestion, status).distinct()

/**
 * The align panel: a view of [AlignFlow]'s [state]. [notes] are the printed-size message and, once saved, the floor
 * warnings. **Save alignment** shows once the scene is placed. When a ring of the floor is in view, [ring] (with the
 * flow's [ringStatus]) adds its check lines and **Record this ring** / **Re-record this ring**, which call
 * [onRecordRing]. Not wired into the menu yet (Task 10).
 */
@Composable
fun AlignPanel(
    state: AlignState,
    notes: List<String>,
    onSave: () -> Unit,
    onClose: () -> Unit,
    ring: RingCheckView? = null,
    ringStatus: String? = null,
    onRecordRing: () -> Unit = {},
) {
  val lines = alignLines(state, notes)
  MaterialTheme(colorScheme = darkColorScheme()) {
    Column(
        Modifier.fillMaxSize().background(Color(0xF0101420), RoundedCornerShape(16.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Text(lines.first(), color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
      lines.drop(1).forEach { Text(it, color = Color(0xFFE0E0E0), fontSize = 15.sp) }
      if (state is AlignState.Placed || state is AlignState.Refused) Button(onClick = onSave) { Text("Save alignment") }
      if (ring != null) {
        val warnColor = if (ring.warn) Color(0xFFFFB74D) else Color(0xFFE0E0E0)
        val lines = ringCheckLines(ring, ringStatus)
        lines.forEach { Text(it, color = if (it == ring.line) warnColor else Color(0xFFE0E0E0), fontSize = 15.sp) }
        when (ring.button) {
          RingButton.Record -> Button(onClick = onRecordRing) { Text("Record this ARC") }
          RingButton.ReRecord -> Button(onClick = onRecordRing) { Text("Re-record this ARC") }
          RingButton.None -> Unit
        }
      }
      OutlinedButton(onClick = onClose) { Text(if (state is AlignState.Saved) "Done" else "Cancel") }
    }
  }
}
