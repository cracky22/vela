package de.cracky.vela.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import de.cracky.vela.VelaApp
import kotlinx.coroutines.launch

/** Aktionen direkt aus der Benachrichtigung: Antworten, als gelesen markieren, verwerfen. */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val convId = intent.getStringExtra(Notifier.EXTRA_CONV) ?: return
        val repo = (context.applicationContext as VelaApp).repo
        when (intent.action) {
            Notifier.ACTION_REPLY -> {
                val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifier.KEY_REPLY)?.toString()?.trim()
                if (text.isNullOrEmpty()) return
                val pending = goAsync()
                repo.scope.launch {
                    try { repo.replyFromNotification(convId, text) } finally { pending.finish() }
                }
            }
            Notifier.ACTION_READ -> {
                val pending = goAsync()
                repo.scope.launch {
                    try { repo.readFromNotification(convId) } finally { pending.finish() }
                }
            }
            Notifier.ACTION_DISMISS -> repo.notifier.clear(convId)
        }
    }
}
