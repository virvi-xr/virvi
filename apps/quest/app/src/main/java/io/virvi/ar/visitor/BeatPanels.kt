package io.virvi.ar.visitor

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.virvi.ar.builder.formatPairingCode

private val CARD = Color(0xF0101420)
private val SECONDARY = Color(0xFFE0E0E0)

/** A wallet address as the choice shows it: `0x1234…abcd`. */
fun shortWallet(wallet: String): String = if (wallet.length > 12) "${wallet.take(6)}…${wallet.takeLast(4)}" else wallet

/**
 * The BEAT card for the space now shown (0.5 × 0.45 m): what to do for the BEAT, its button, the wallet choice, the
 * consent text before the first track, and what went wrong, in [BeatCard]'s words.
 */
@Composable
fun BeatPanel(view: BeatView, act: BeatActions) {
  MaterialTheme(colorScheme = darkColorScheme()) {
    Column(
        Modifier.fillMaxSize().background(CARD, RoundedCornerShape(16.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      if (view.consent != null) {
        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState())) {
          Text(view.consent, color = SECONDARY, fontSize = 13.sp, lineHeight = 17.sp)
        }
        Wide(VisitorCopy.BEAT_AGREE, act::acceptConsent)
        Wide(VisitorCopy.REPORT_CANCEL, act::declineConsent, outlined = true)
        return@Column
      }
      view.name?.let { Text(it, color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Medium) }
      view.text?.let { Text(it, color = SECONDARY, fontSize = 15.sp) }
      if (view.claiming) CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
      view.wallets.forEach { w -> Wide(shortWallet(w), { act.claimWith(w) }) }
      view.button?.let { b -> Wide(b, act::primary) }
      if (view.canRetry) Wide(VisitorCopy.BEAT_RETRY, act::retry, outlined = true)
      if (view.canStop) Wide(VisitorCopy.BEAT_STOP, act::stopTracking, outlined = true)
    }
  }
}

/**
 * The visitor's sign-in code (0.5 × 0.45 m): the instruction, the code in large letters, and Cancel. It shows while
 * [SignInState.ShowingCode]; the headset polls, and the panel closes when the visitor approves.
 */
@Composable
fun SignInPanel(code: String, onCancel: () -> Unit) {
  MaterialTheme(colorScheme = darkColorScheme()) {
    Column(
        Modifier.fillMaxSize().background(CARD, RoundedCornerShape(16.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Text(VisitorCopy.PAIR_INSTRUCTION, color = SECONDARY, fontSize = 16.sp, textAlign = TextAlign.Center)
      Text(
          formatPairingCode(code),
          color = Color.White,
          fontSize = 44.sp,
          fontWeight = FontWeight.Bold,
          fontFamily = FontFamily.Monospace,
      )
      Spacer(Modifier.weight(1f))
      OutlinedButton(onClick = onCancel, Modifier.fillMaxWidth()) { Text(VisitorCopy.REPORT_CANCEL, fontSize = 14.sp) }
    }
  }
}

@Composable
private fun Wide(label: String, onClick: () -> Unit, outlined: Boolean = false) {
  val m = Modifier.fillMaxWidth()
  if (outlined) OutlinedButton(onClick, m) { Text(label, fontSize = 14.sp) }
  else Button(onClick, m) { Text(label, fontSize = 14.sp) }
}
