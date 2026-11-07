package de.cracky.vela.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import de.cracky.vela.data.Conv
import de.cracky.vela.data.Dec
import de.cracky.vela.data.Repo
import de.cracky.vela.data.previewText
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

private val avatarCache = LruCache<String, Bitmap>(64)
private val missing = HashSet<String>()

fun hueColor(name: String): Color {
    var x = 0
    for (ch in name) x = x * 31 + ch.code
    return Color.hsv(((x.toLong() and 0xffffffffL) % 360).toFloat(), 0.45f, 0.62f)
}

@Composable
fun Avatar(repo: Repo, id: String, isGroup: Boolean, version: Int, name: String, size: Dp = 48.dp) {
    val key = "$id:$version"
    val bmp by produceState<Bitmap?>(avatarCache.get(key), key) {
        if (value == null && key !in missing) {
            val bytes = repo.avatar(id, isGroup)
            val b = bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
            if (b != null) { avatarCache.put(key, b); value = b } else missing.add(key)
        }
    }
    Box(Modifier.size(size).clip(CircleShape).background(hueColor(name)), contentAlignment = Alignment.Center) {
        val b = bmp
        if (b != null) Image(b.asImageBitmap(), null, Modifier.size(size), contentScale = ContentScale.Crop)
        else Text(name.take(2).uppercase(), color = Color.White, fontSize = (size.value * 0.38f).sp)
    }
}

fun fmtTime(ts: Long): String = SimpleDateFormat("HH:mm", Locale.GERMANY).format(Date(ts))

fun fmtListTime(ts: Long): String {
    val now = Calendar.getInstance(); val d = Calendar.getInstance().apply { timeInMillis = ts }
    return when {
        now.get(Calendar.YEAR) == d.get(Calendar.YEAR) && now.get(Calendar.DAY_OF_YEAR) == d.get(Calendar.DAY_OF_YEAR) -> fmtTime(ts)
        System.currentTimeMillis() - ts < 6 * 86_400_000L -> SimpleDateFormat("EEE", Locale.GERMANY).format(Date(ts))
        else -> SimpleDateFormat("dd.MM.yy", Locale.GERMANY).format(Date(ts))
    }
}

fun fmtDay(ts: Long): String {
    val now = Calendar.getInstance(); val d = Calendar.getInstance().apply { timeInMillis = ts }
    val diff = now.get(Calendar.DAY_OF_YEAR) - d.get(Calendar.DAY_OF_YEAR)
    val sameYear = now.get(Calendar.YEAR) == d.get(Calendar.YEAR)
    return when {
        sameYear && diff == 0 -> "Heute"
        sameYear && diff == 1 -> "Gestern"
        else -> SimpleDateFormat(if (sameYear) "EEE, dd.MM." else "dd.MM.yyyy", Locale.GERMANY).format(Date(ts))
    }
}

fun fmtBytes(n: Long): String {
    if (n < 1024) return "$n B"
    var v = n / 1024.0; val u = listOf("KB", "MB", "GB"); var i = 0
    while (v >= 1024 && i < u.size - 1) { v /= 1024; i++ }
    return String.format(Locale.GERMANY, if (v < 10) "%.1f %s" else "%.0f %s", v, u[i])
}

fun fmtDuration(s: Double): String { val t = s.toInt().coerceAtLeast(0); return "${t / 60}:${(t % 60).toString().padStart(2, '0')}" }

/** Text für die Chatliste: Vorschau der letzten Nachricht. */
fun listPreview(c: Conv, dec: Map<String, Dec>, repo: Repo): String {
    val m = c.last ?: return if (c.status == "accepted") "Noch keine Nachrichten" else ""
    if (m.deletedAt != null) return "🚫 Nachricht gelöscht"
    if (m.system != null) return systemText(repo, m.system)
    if (m.viewOnce) return if (m.viewedAt != null) "🔒 Einmalansicht geöffnet" else "🔒 Einmalansicht"
    val d = dec[m.id] ?: return "🔒 …"
    val body = d.payload?.let { previewText(it) } ?: return "🔒 Nicht lesbar"
    val prefix = if (m.from == repo.myId) "Du: " else if (c.isGroup) repo.nameOf(m.from) + ": " else ""
    return prefix + body
}

fun systemText(repo: Repo, s: org.json.JSONObject): String {
    fun user(o: org.json.JSONObject?) = o?.optString("username").orEmpty().ifEmpty { "?" }
    val by = s.optString("by").takeIf { it.isNotEmpty() && it != "null" }?.let { repo.nameOf(it) } ?: "Admin"
    return when (s.optString("t")) {
        "created" -> "$by hat die Gruppe „${s.optString("name")}“ erstellt"
        "added" -> "$by hat " + (s.optJSONArray("users")?.let { a -> (0 until a.length()).joinToString(", ") { user(a.optJSONObject(it)) } } ?: "") + " hinzugefügt"
        "removed" -> "$by hat ${user(s.optJSONObject("user"))} entfernt"
        "left" -> "${user(s.optJSONObject("user"))} hat die Gruppe verlassen"
        "renamed" -> "$by hat den Gruppennamen zu „${s.optString("name")}“ geändert"
        "description" -> "$by hat die Gruppenbeschreibung geändert"
        "avatar" -> "$by hat das Gruppenbild geändert"
        "admin" -> "${user(s.optJSONObject("user"))} ist ${if (s.optBoolean("admin")) "jetzt Admin" else "kein Admin mehr"}"
        "only_admins" -> if (s.optBoolean("value")) "Nur Admins dürfen die Gruppeninfo ändern" else "Alle dürfen die Gruppeninfo ändern"
        "timer" -> if (s.optInt("ttl") > 0) "Verschwindende Nachrichten: ${de.cracky.vela.data.ttlLabel(s.optInt("ttl"))}" else "Verschwindende Nachrichten deaktiviert"
        else -> "Systemnachricht"
    }
}
