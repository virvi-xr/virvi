package io.virvi.ar.builder

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.virvi.ar.Vec3
import kotlin.math.atan2

/** The HUD panel's size in metres (its `ComposeViewPanelRegistration`, Task 10). */
const val HUD_WIDTH_M = 0.55f
const val HUD_HEIGHT_M = 0.8f
/** The HUD floats this far to the builder's left. */
const val HUD_LEFT_M = 0.6
private const val HUD_AHEAD_M = 0.3
private const val HUD_DROP_M = 0.15

/**
 * Where the HUD floats when builder mode opens (it is grabbable after that): [HUD_LEFT_M] to the left of the head at
 * [head] facing [headYawDeg] (degrees from +Z toward +X), a little ahead and below eye level, turned to face the head.
 * Returns the position and the panel's yaw.
 */
fun builderHudPlacement(head: Vec3, headYawDeg: Double): Pair<Vec3, Double> {
  val yaw = Math.toRadians(headYawDeg)
  val fwd = Vec3(Math.sin(yaw), 0.0, Math.cos(yaw))
  // Left-handed, Y up: right of forward (x, z) is (z, -x).
  val left = Vec3(-fwd.z, 0.0, fwd.x)
  val p = Vec3(head.x + left.x * HUD_LEFT_M + fwd.x * HUD_AHEAD_M, head.y - HUD_DROP_M, head.z + left.z * HUD_LEFT_M + fwd.z * HUD_AHEAD_M)
  return p to Math.toDegrees(atan2(p.x - head.x, p.z - head.z))
}

/** What the HUD's controls do (an editor in the app: [hudActions]). */
interface BuilderHudActions {
  fun selectTab(tab: HudTab)

  fun pick(sk: String)

  fun resetToShared(sk: String)

  fun setMode(mode: TransformMode)

  fun setScope(scope: Scope)

  fun setExact(mode: TransformMode, axis: Axis, value: Double)

  fun save()

  fun revert()

  fun done()

  fun confirmDone(save: Boolean)

  fun cancelDone()
}

/** The HUD's actions on this editor; [onTab] keeps the tab (it isn't the editor's). */
fun BuilderEditor.hudActions(onTab: (HudTab) -> Unit): BuilderHudActions {
  val e = this
  return object : BuilderHudActions {
    override fun selectTab(tab: HudTab) = onTab(tab)

    override fun pick(sk: String) = e.pick(sk)

    override fun resetToShared(sk: String) = e.resetToShared(sk)

    override fun setMode(mode: TransformMode) = e.setMode(mode)

    override fun setScope(scope: Scope) = e.setScope(scope)

    override fun setExact(mode: TransformMode, axis: Axis, value: Double) {
      e.setExact(mode, axis, value)
    }

    override fun save() = e.save()

    override fun revert() = e.revert()

    override fun done() {
      e.done()
    }

    override fun confirmDone(save: Boolean) = e.confirmDone(save)

    override fun cancelDone() = e.cancelDone()
  }
}

private val TEXT = Color.White
private val SUBTLE = Color(0xFFB0B8C8)
private val WARN = Color(0xFFFFB74D)
private val DOT = Color(0xFF4FC3F7)

/**
 * The builder HUD: the banner always on top, the warnings, then the **Layout** tab (the scene's items: name, kind,
 * a dot and **Reset to shared** for items with their own adjustment here; tap to pick) or **Assets** ([assets], the
 * library, Task 9). While an item is picked: **Move / Rotate / Resize**, **Exact** fields, and the **Everywhere /
 * Just this place** switch. **Save / Revert / Done** are always at the bottom; Done with unsaved changes asks first.
 * On a personal headset the Layout tab also has [roomScan] (**Scan this room**, `RoomScanSection`).
 * Not wired into the menu yet (Task 10).
 */
@Composable
fun BuilderHud(
    model: BuilderHudModel,
    actions: BuilderHudActions,
    assets: @Composable () -> Unit = {},
    roomScan: @Composable () -> Unit = {},
    stream: @Composable () -> Unit = {},
    clear: ClearActions? = null,
) {
  MaterialTheme(colorScheme = darkColorScheme()) {
    Column(
        Modifier.fillMaxSize().background(Color(0xF0101420), RoundedCornerShape(16.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      Text(model.banner, color = TEXT, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
      model.warnings.forEach { Text(it, color = WARN, fontSize = 13.sp) }
      model.message?.let { Text(it, color = WARN, fontSize = 14.sp, fontWeight = FontWeight.Medium) }
      TabRow(selectedTabIndex = model.tab.ordinal) {
        Tab(model.tab == HudTab.LAYOUT, onClick = { actions.selectTab(HudTab.LAYOUT) }, text = { Text("Layout") })
        Tab(model.tab == HudTab.ASSETS, onClick = { actions.selectTab(HudTab.ASSETS) }, text = { Text("Assets") })
        // Personal headsets only ([BuilderHudModel.canStream])
        if (model.canStream) Tab(model.tab == HudTab.STREAM, onClick = { actions.selectTab(HudTab.STREAM) }, text = { Text("Stream") })
      }
      Box(Modifier.weight(1f).fillMaxWidth()) {
        when (model.tab) {
          HudTab.LAYOUT ->
              Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                // Only on a personal headset ([BuilderHudModel.canScanRoom]).
                if (model.canScanRoom) roomScan()
                Box(Modifier.weight(1f).fillMaxWidth()) { LayoutList(model.rows, actions) }
              }
          HudTab.ASSETS -> assets()
          HudTab.STREAM -> stream()
        }
      }
      model.bar?.let { PickedBar(it, actions) }
      // Clear every copy of the picked item's object (LIV-12), asking first
      val offer = model.clear
      if (model.bar != null && offer != null && clear != null) {
        if (offer.confirming) {
          Text(clearCopiesPrompt(offer), color = WARN, fontSize = 13.sp)
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { clear.confirm() }) { Text("Remove") }
            OutlinedButton(onClick = { clear.cancel() }) { Text("Cancel") }
          }
        } else {
          OutlinedButton(onClick = { clear.ask() }) { Text(if (offer.copies == 1) "Clear the only copy" else "Clear all ${offer.copies} copies") }
        }
      }
      if (model.confirmingDone) {
        Text(DONE_CONFIRM, color = TEXT, fontSize = 15.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          Button(onClick = { actions.confirmDone(true) }) { Text("Save") }
          OutlinedButton(onClick = { actions.confirmDone(false) }) { Text("Don't save") }
          TextButton(onClick = actions::cancelDone) { Text("Cancel") }
        }
      } else {
        if (model.saving) Text(SAVING, color = SUBTLE, fontSize = 13.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          Button(onClick = actions::save, enabled = model.canSave) { Text("Save") }
          OutlinedButton(onClick = actions::revert, enabled = model.canSave) { Text("Revert") }
          OutlinedButton(onClick = actions::done, enabled = !model.saving) { Text("Done") }
        }
      }
    }
  }
}

@Composable
private fun LayoutList(rows: List<HudRow>, actions: BuilderHudActions) {
  LazyColumn(verticalArrangement = Arrangement.spacedBy(2.dp)) {
    items(rows, key = { it.sk }) { row ->
      Row(
          Modifier.fillMaxWidth()
              .background(if (row.picked) Color(0x332196F3) else Color.Transparent, RoundedCornerShape(8.dp))
              .clickable { actions.pick(row.sk) }
              .padding(horizontal = 8.dp, vertical = 4.dp),
          verticalAlignment = Alignment.CenterVertically,
      ) {
        Column(Modifier.weight(1f)) {
          Text(row.name + if (row.edited) " •" else "", color = TEXT, fontSize = 14.sp)
          Text(row.kind, color = SUBTLE, fontSize = 12.sp)
        }
        if (row.adjusted) {
          Box(Modifier.size(8.dp).background(DOT, CircleShape))
          Spacer(Modifier.width(6.dp))
          TextButton(onClick = { actions.resetToShared(row.sk) }) { Text(RESET_TO_SHARED, fontSize = 12.sp) }
        }
      }
    }
  }
}

@Composable
private fun PickedBar(bar: PickBar, actions: BuilderHudActions) {
  Text(bar.name, color = TEXT, fontSize = 15.sp, fontWeight = FontWeight.Medium)
  Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
    listOf(TransformMode.MOVE to "Move", TransformMode.ROTATE to "Rotate", TransformMode.RESIZE to "Resize").forEach { (m, label) ->
      FilterChip(selected = bar.mode == m, onClick = { actions.setMode(m) }, label = { Text(label) })
    }
  }
  Text("Exact", color = SUBTLE, fontSize = 12.sp)
  bar.exact.forEach { row ->
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
      Text(row.label, color = SUBTLE, fontSize = 12.sp, modifier = Modifier.width(56.dp))
      Axis.entries.forEachIndexed { i, axis ->
        ExactField(row.values[i], Modifier.weight(1f)) { v -> actions.setExact(row.mode, axis, v) }
      }
    }
  }
  Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
    FilterChip(
        selected = bar.scope == Scope.EVERYWHERE,
        onClick = { actions.setScope(Scope.EVERYWHERE) },
        label = { Text(SCOPE_EVERYWHERE) },
        enabled = !bar.scopeLocked,
    )
    FilterChip(
        selected = bar.scope == Scope.JUST_HERE,
        onClick = { actions.setScope(Scope.JUST_HERE) },
        label = { Text(SCOPE_JUST_HERE) },
        enabled = !bar.scopeLocked,
    )
  }
}

/** A number field (a text keyboard, which has the minus sign the number one lacks): the value is set when the keyboard's Done is pressed or the field loses focus; a bad entry is undone. */
@Composable
private fun ExactField(value: String, modifier: Modifier, onValue: (Double) -> Unit) {
  var text by remember(value) { mutableStateOf(value) }
  fun commit() {
    if (text == value) return
    val v = parseExact(text)
    if (v == null) text = value else onValue(v)
  }
  OutlinedTextField(
      value = text,
      onValueChange = { text = it },
      singleLine = true,
      textStyle = MaterialTheme.typography.bodySmall,
      keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text, imeAction = ImeAction.Done),
      keyboardActions = KeyboardActions(onDone = { commit() }),
      modifier = modifier.onFocusChanged { if (!it.isFocused) commit() },
  )
}
