package de.cracky.vela.service

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import de.cracky.vela.MainActivity
import de.cracky.vela.R

class Notifier(private val ctx: Context) {
    companion object {
        const val CH_MESSAGES = "messages"
        const val CH_SERVICE = "service_quiet"
        const val EXTRA_CONV = "conv"
        const val KEY_REPLY = "reply_text"
        const val ACTION_REPLY = "de.cracky.vela.REPLY"
        const val ACTION_READ = "de.cracky.vela.MARK_READ"
        const val ACTION_DISMISS = "de.cracky.vela.DISMISSED"

        fun createChannels(ctx: Context) {
            if (Build.VERSION.SDK_INT < 26) return
            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CH_MESSAGES, "Nachrichten", NotificationManager.IMPORTANCE_HIGH))
            nm.deleteNotificationChannel("service")
            nm.createNotificationChannel(
                NotificationChannel(CH_SERVICE, "Verbindung im Hintergrund", NotificationManager.IMPORTANCE_MIN).apply {
                    setShowBadge(false)
                    setSound(null, null)
                    enableVibration(false)
                    lockscreenVisibility = android.app.Notification.VISIBILITY_SECRET
                },
            )
        }
    }

    private class Line(val text: String, val ts: Long, val sender: String?)
    private class Meta(val title: String, val isGroup: Boolean)

    private val history = HashMap<String, MutableList<Line>>()
    private val meta = HashMap<String, Meta>()

    private fun allowed() = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun openIntent(convId: String?): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (convId != null) i.putExtra(EXTRA_CONV, convId)
        return PendingIntent.getActivity(ctx, (convId ?: "").hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun actionIntent(action: String, convId: String, mutable: Boolean, code: Int): PendingIntent {
        val i = Intent(ctx, NotificationActionReceiver::class.java).setAction(action)
            .setData(Uri.parse("vela://conv/$convId/$action")).putExtra(EXTRA_CONV, convId)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            if (mutable) (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0) else PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(ctx, convId.hashCode() * 31 + code, i, flags)
    }

    /** Neue eingehende Nachricht: sammelt den Verlauf je Chat und zeigt eine Konversations-Benachrichtigung mit Antwortfeld. */
    fun message(convId: String, title: String, isGroup: Boolean, sender: String, text: String, ts: Long) {
        history.getOrPut(convId) { ArrayList() }.let { it.add(Line(text, ts, sender)); while (it.size > 8) it.removeAt(0) }
        meta[convId] = Meta(title, isGroup)
        post(convId, quiet = false, sending = false)
    }

    /** Antwort wurde gesendet: in den Verlauf aufnehmen und die Benachrichtigung ohne Ladebalken aktualisieren. */
    fun replied(convId: String, text: String) {
        val h = history[convId]
        if (h == null || meta[convId] == null) { cancel(convId); return }
        h.add(Line(text, System.currentTimeMillis(), null))
        post(convId, quiet = true, sending = false)
    }

    fun replyFailed(convId: String) {
        if (meta[convId] == null) return
        post(convId, quiet = true, sending = false, failed = true)
    }

    private fun post(convId: String, quiet: Boolean, sending: Boolean, failed: Boolean = false) {
        if (!allowed()) return
        val m = meta[convId] ?: return
        val lines = history[convId] ?: return
        val me = Person.Builder().setName("Du").build()
        val style = NotificationCompat.MessagingStyle(me).setConversationTitle(if (m.isGroup) m.title else null).setGroupConversation(m.isGroup)
        for (l in lines) {
            val p = if (l.sender == null) me else Person.Builder().setName(l.sender).build()
            style.addMessage(l.text, l.ts, p)
        }
        val remote = RemoteInput.Builder(KEY_REPLY).setLabel("Antworten …").build()
        val reply = NotificationCompat.Action.Builder(R.drawable.ic_notify, "Antworten", actionIntent(ACTION_REPLY, convId, true, 1))
            .addRemoteInput(remote).setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false).setAllowGeneratedReplies(true).build()
        val read = NotificationCompat.Action.Builder(R.drawable.ic_notify, "Als gelesen markieren", actionIntent(ACTION_READ, convId, false, 2))
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ).setShowsUserInterface(false).build()
        val b = NotificationCompat.Builder(ctx, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(m.title)
            .setStyle(style)
            .setAutoCancel(true).setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(openIntent(convId))
            .setDeleteIntent(actionIntent(ACTION_DISMISS, convId, false, 3))
            .addAction(reply).addAction(read)
            .setOnlyAlertOnce(quiet)
        if (failed) b.setContentText("Antwort konnte nicht gesendet werden")
        NotificationManagerCompat.from(ctx).notify(convId.hashCode(), b.build())
    }

    fun clear(convId: String) { history.remove(convId); meta.remove(convId) }

    fun cancel(convId: String) {
        clear(convId)
        NotificationManagerCompat.from(ctx).cancel(convId.hashCode())
    }

    fun cancelAll() {
        history.clear(); meta.clear()
        NotificationManagerCompat.from(ctx).cancelAll()
    }

    fun serviceNotification() = NotificationCompat.Builder(ctx, CH_SERVICE)
        .setSmallIcon(R.drawable.ic_notify)
        .setContentTitle("Vela")
        .setPriority(NotificationCompat.PRIORITY_MIN).setVisibility(NotificationCompat.VISIBILITY_SECRET)
        .setSilent(true).setShowWhen(false).setOngoing(true).setContentIntent(openIntent(null)).build()
}
