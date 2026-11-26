package io.virvi.ar.visitor

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.virvi.ar.AppState
import io.virvi.ar.Occlusion

/** What the visitor menu's buttons do. */
interface MenuActions {
  fun toggleMenu()
  fun lookAgain()
  fun toggleSpaces()
  /** Opens the space page for [code] and starts looking it up. */
  fun openSpace(code: String)
  fun setOcclusion(o: Occlusion)
  fun openBuilder()
  /** Owner only: taking the headset off hides the scene but keeps it loaded (`AppPrefs.keepLoadedBetweenVisitors`). */
  fun setKeepLoaded(on: Boolean)
  /** Owner only: leaves builder mode and forgets the headset's pairing. */
  fun signOut()
  /** The visitor's own sign-in: shows a code to approve at virvi.io/pair or in the Virvi app. */
  fun signIn()
  /** Signs the visitor out of their Virvi account on this headset. */
  fun signOutVisitor()
  /** Swaps the menu for the report's reason picker. */
  fun startReport()
  fun cancelReport()
  /** Sends a report of the space now up, for [reason] (`offensive`, `unsafe`, `spam` or `other`), and leaves the picker. */
  fun reportSpace(reason: String)
  /** Debug builds only. */
  fun toggleDeveloper()
}

/** The menu's occlusion buttons, in order. */
private val OCCLUSION_CHOICES =
    listOf(
        Occlusion.WALLS to VisitorCopy.HIDE_BEHIND_WALLS,
        Occlusion.DEPTH to VisitorCopy.LIVE_DEPTH,
        Occlusion.OFF to VisitorCopy.OCCLUSION_OFF,
    )

/** The report picker's buttons, in order: the reason sent, and its label. */
private val REPORT_CHOICES =
    listOf(
        "offensive" to VisitorCopy.REPORT_OFFENSIVE,
        "unsafe" to VisitorCopy.REPORT_UNSAFE,
        "spam" to VisitorCopy.REPORT_SPAM,
        "other" to VisitorCopy.REPORT_OTHER,
    )

/** The small menu (0.5 × 0.6 m): the only settings a visitor sees, plus the owner's while building or paired. */
@Composable
fun VisitorMenu(s: AppState, act: MenuActions, developer: Boolean) {
  MaterialTheme(colorScheme = darkColorScheme()) {
    Column(
        Modifier.fillMaxSize().background(Color(0xF0101420), RoundedCornerShape(16.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      if (s.reportPicking && s.reportSpaceId != null) {
        REPORT_CHOICES.forEach { (reason, label) -> Wide(label, { act.reportSpace(reason) }) }
        Wide(VisitorCopy.REPORT_CANCEL, act::cancelReport, outlined = true)
        return@Column
      }
      if (s.lookAgainShown) Wide(VisitorCopy.LOOK_AGAIN, act::lookAgain)
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        OCCLUSION_CHOICES.forEach { (o, label) ->
          val m = Modifier.weight(1f)
          val pad = PaddingValues(horizontal = 4.dp, vertical = 6.dp)
          val text = @Composable { Text(label, fontSize = 11.sp, textAlign = TextAlign.Center, lineHeight = 13.sp) }
          if (o == s.occlusion) Button({ act.setOcclusion(o) }, m, contentPadding = pad) { text() }
          else OutlinedButton({ act.setOcclusion(o) }, m, contentPadding = pad) { text() }
        }
      }
      Wide(VisitorCopy.SPACES, act::toggleSpaces)
      if (s.spacesOpen) {
        Column(
            Modifier.fillMaxWidth().weight(1f, fill = false).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
          if (s.recentSpaces.isEmpty()) Text(VisitorCopy.NO_SPACES, color = Color(0xFFE0E0E0), fontSize = 13.sp)
          s.recentSpaces.forEach { r -> Wide(r.spaceName, { act.openSpace(r.code) }, outlined = true) }
        }
      }
      when (val si = s.signIn) {
        is SignInState.SignedIn -> {
          Text(si.userName ?: "Signed in", color = Color(0xFFE0E0E0), fontSize = 13.sp)
          Wide(VisitorCopy.MENU_SIGN_OUT, act::signOutVisitor, outlined = true)
        }
        else -> Wide(VisitorCopy.MENU_SIGN_IN, act::signIn, outlined = true)
      }
      Wide(VisitorCopy.BUILDER, act::openBuilder, enabled = !s.builderActive)
      if (s.reportSpaceId != null && !s.builderActive) Wide(VisitorCopy.REPORT_SPACE, act::startReport, outlined = true)
      if (s.ownerControls) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
          Text(VisitorCopy.KEEP_LOADED, color = Color(0xFFE0E0E0), fontSize = 13.sp, modifier = Modifier.weight(1f))
          Switch(checked = s.keepLoaded, onCheckedChange = act::setKeepLoaded)
        }
        Wide(VisitorCopy.SIGN_OUT, act::signOut, outlined = true)
      }
      if (developer) Wide("Developer", act::toggleDeveloper, outlined = true)
      s.menuNote?.let { Text(it, color = Color(0xFFE0E0E0), fontSize = 13.sp) }
    }
  }
}

@Composable
private fun Wide(label: String, onClick: () -> Unit, enabled: Boolean = true, outlined: Boolean = false) {
  val m = Modifier.fillMaxWidth()
  if (outlined) OutlinedButton(onClick, m, enabled) { Text(label, fontSize = 14.sp) }
  else Button(onClick, m, enabled) { Text(label, fontSize = 14.sp) }
}

/**
 * Whether the "⋯" button shows in [state]: always while a space is up or on its way ([spaceChosen]: locking, not set
 * up, or failed after its lookup), so the visitor always has a visible way out; never on the plain hint card.
 */
fun menuButtonShown(state: VisitorState, spaceChosen: Boolean): Boolean =
    when (state) {
      is VisitorState.Shown -> true
      is VisitorState.Locking, is VisitorState.NotSetUp, is VisitorState.Failed -> spaceChosen
      VisitorState.Hint, VisitorState.StepCloser, is VisitorState.Loading -> false
    }

/** The small "⋯" button that opens and closes the menu. */
@Composable
fun MenuButton(act: MenuActions) {
  MaterialTheme(colorScheme = darkColorScheme()) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
      Button(act::toggleMenu, Modifier.fillMaxSize(), shape = CircleShape, contentPadding = PaddingValues(0.dp)) {
        Text("⋯", fontSize = 18.sp)
      }
    }
  }
}
