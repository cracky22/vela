package de.cracky.vela.service

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import de.cracky.vela.MainActivity
import de.cracky.vela.R

class Notifier(private val ctx: Context) {
    companion object {
        const val CH_MESSAGES = "messages"
        const val CH_SERVICE = "service_quiet"
        const val EXTRA_CONV = "conv"

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

    private fun openIntent(convId: String?): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (convId != null) i.putExtra(EXTRA_CONV, convId)
        return PendingIntent.getActivity(ctx, (convId ?: "").hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun message(convId: String, title: String, text: String) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val n = NotificationCompat.Builder(ctx, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title).setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true).setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(openIntent(convId)).build()
        NotificationManagerCompat.from(ctx).notify(convId.hashCode(), n)
    }

    fun cancel(convId: String) = NotificationManagerCompat.from(ctx).cancel(convId.hashCode())
    fun cancelAll() = NotificationManagerCompat.from(ctx).cancelAll()

    fun serviceNotification() = NotificationCompat.Builder(ctx, CH_SERVICE)
        .setSmallIcon(R.drawable.ic_notify)
        .setContentTitle("Vela")
        .setPriority(NotificationCompat.PRIORITY_MIN).setVisibility(NotificationCompat.VISIBILITY_SECRET)
        .setSilent(true).setShowWhen(false).setOngoing(true).setContentIntent(openIntent(null)).build()
}
