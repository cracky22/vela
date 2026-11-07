package de.cracky.vela.ui

import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import de.cracky.vela.VelaApp

/** Haptisches Feedback über die System-Konstanten (respektiert „Touch-Feedback“ des Systems und die App-Einstellung). */
class Haptics(private val view: View, private val enabled: () -> Boolean) {
    private fun go(c: Int) { if (enabled()) view.performHapticFeedback(c) }

    /** Feines Ticken – Auswahl, Wechsel, Wiedergabe. */
    fun tick() = go(HapticFeedbackConstants.CLOCK_TICK)

    /** Leichter Tipp – Knöpfe. */
    fun light() = go(HapticFeedbackConstants.KEYBOARD_TAP)

    /** Erfolg – gesendet, Aufnahme gestartet, geöffnet. */
    fun confirm() = go(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY)

    /** Fehler – Senden fehlgeschlagen, verworfen. */
    fun reject() = go(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS)

    fun longPress() = go(HapticFeedbackConstants.LONG_PRESS)

    fun toggle(on: Boolean) = go(
        if (Build.VERSION.SDK_INT >= 34) (if (on) HapticFeedbackConstants.TOGGLE_ON else HapticFeedbackConstants.TOGGLE_OFF)
        else HapticFeedbackConstants.CLOCK_TICK,
    )

    /** Schwelle einer Geste erreicht (z. B. Wischen zum Antworten). */
    fun gesture() = go(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.GESTURE_START else HapticFeedbackConstants.CLOCK_TICK)
}

@Composable
fun rememberHaptics(): Haptics {
    val view = LocalView.current
    val ctx = LocalContext.current
    return remember(view) { Haptics(view) { (ctx.applicationContext as VelaApp).repo.store.haptics } }
}
