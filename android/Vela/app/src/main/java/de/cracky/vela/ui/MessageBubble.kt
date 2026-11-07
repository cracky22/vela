@file:OptIn(ExperimentalFoundationApi::class)

package de.cracky.vela.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaPlayer
import android.util.Base64
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import de.cracky.vela.data.Conv
import de.cracky.vela.data.Dec
import de.cracky.vela.data.FileMeta
import de.cracky.vela.data.Msg
import de.cracky.vela.data.Repo
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

val REACTIONS = listOf("👍", "❤️", "😂", "😮", "😢", "🙏")
private val URL_RE = Regex("""https?://[^\s<>"]+""")

class BubbleActions(
    val onReply: () -> Unit, val onEdit: (() -> Unit)?, val onDelete: (() -> Unit)?, val onCopy: (() -> Unit)?,
    val onReact: (String) -> Unit, val onSave: ((FileMeta) -> Unit), val onRetry: () -> Unit, val onOpenImage: (Bitmap) -> Unit,
    val onJump: (String) -> Unit,
)

@Composable
fun SystemRow(repo: Repo, m: Msg) {
    Box(Modifier.fillMaxWidth().padding(vertical = 6.dp), Alignment.Center) {
        Text(
            m.system?.let { systemText(repo, it) } ?: "", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)).padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

fun readTick(m: Msg, c: Conv, me: String): String {
    if (m.failed) return "⚠"
    if (m.pending) return "🕓"
    if (!c.isGroup) return if (m.readAt != null) "✓✓" else "✓"
    val others = c.members.filter { it.id != me && it.joinedAt <= m.ts }
    if (others.isEmpty() || others.any { it.lastRead == null }) return "✓"
    return if (others.all { (it.lastRead ?: 0) >= m.ts }) "✓✓" else "✓"
}

@Composable
fun MessageBubble(
    repo: Repo, m: Msg, d: Dec?, conv: Conv, reactions: Map<String, String>, edited: String?,
    showSender: Boolean, a: BubbleActions,
) {
    val mine = m.from == repo.myId
    var menu by remember { mutableStateOf(false) }
    val payload = if (edited != null && d?.payload != null) JSONObject(d.payload.toString()).put("body", edited) else d?.payload
    val bg = if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        Box {
            Column(
                Modifier.widthIn(max = 300.dp).clip(RoundedCornerShape(16.dp)).background(bg)
                    .combinedClickable(onClick = { if (m.failed) a.onRetry() }, onLongClick = { if (m.deletedAt == null) menu = true })
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            ) {
                if (showSender && !mine) Text(repo.nameOf(m.from), style = MaterialTheme.typography.labelMedium, color = hueColor(repo.nameOf(m.from)))
                when {
                    m.deletedAt != null -> Text("🚫 Diese Nachricht wurde gelöscht.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    m.viewOnce && !mine -> ViewOnce(repo, m, a)
                    m.viewOnce && mine -> Text("🔒 Einmalansicht" + if (m.viewedAt != null) " (geöffnet)" else "", style = MaterialTheme.typography.bodyMedium)
                    d == null -> Text("🔒 wird entschlüsselt …", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    d.error != null -> Text("⚠ ${d.error}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                    payload != null -> PayloadContent(repo, payload, a)
                }
                Row(Modifier.align(Alignment.End), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (edited != null) Text("bearbeitet", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(fmtTime(m.ts), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (mine) Text(
                        readTick(m, conv, repo.myId), style = MaterialTheme.typography.labelSmall,
                        color = if (readTick(m, conv, repo.myId) == "✓✓") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (m.failed) Text("Nicht gesendet – tippen zum erneuten Senden", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                if (reactions.isNotEmpty()) {
                    val grouped = reactions.values.filter { it.isNotEmpty() }.groupingBy { it }.eachCount()
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 2.dp)) {
                        for ((e, n) in grouped) Text(
                            if (n > 1) "$e $n" else e, style = MaterialTheme.typography.labelMedium,
                            modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.background.copy(alpha = 0.6f)).padding(horizontal = 6.dp, vertical = 1.dp),
                        )
                    }
                }
            }
            DropdownMenu(menu, { menu = false }) {
                Row(Modifier.padding(horizontal = 8.dp)) { for (e in REACTIONS) TextButton({ menu = false; a.onReact(e) }) { Text(e) } }
                DropdownMenuItem({ Text("Antworten") }, { menu = false; a.onReply() })
                a.onCopy?.let { DropdownMenuItem({ Text("Text kopieren") }, { menu = false; it() }) }
                a.onEdit?.let { DropdownMenuItem({ Text("Bearbeiten") }, { menu = false; it() }) }
                payload?.optJSONObject("file")?.let { f ->
                    DropdownMenuItem({ Text("Speichern …") }, { menu = false; a.onSave(FileMeta.from(f)) })
                }
                a.onDelete?.let { DropdownMenuItem({ Text("Für alle löschen") }, { menu = false; it() }) }
            }
        }
    }
}

@Composable
private fun PayloadContent(repo: Repo, p: JSONObject, a: BubbleActions) {
    p.optJSONObject("reply")?.let { r ->
        Column(
            Modifier.padding(bottom = 4.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.background.copy(alpha = 0.5f))
                .clickable { a.onJump(r.optString("id")) }.padding(6.dp),
        ) {
            Text(repo.nameOf(r.optString("from").takeIf { it.isNotEmpty() && it != "null" }), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
            Text(r.optString("snippet"), style = MaterialTheme.typography.bodySmall, maxLines = 2)
        }
    }
    if (p.optBoolean("fwd")) Text("↪ Weitergeleitet", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    when (p.optString("t")) {
        "text" -> LinkText(p.optString("body"))
        "image" -> ImageContent(repo, p, a)
        "file" -> FileContent(repo, FileMeta.from(p.getJSONObject("file")), a)
        "voice" -> VoiceContent(repo, p)
        else -> Text("Nicht unterstützte Nachricht", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun LinkText(body: String) {
    val linkColor = MaterialTheme.colorScheme.primary
    val text: AnnotatedString = remember(body, linkColor) {
        buildAnnotatedString {
            var last = 0
            for (mt in URL_RE.findAll(body)) {
                append(body.substring(last, mt.range.first))
                val url = mt.value.trimEnd('.', ',', ')', '!', '?')
                withLink(LinkAnnotation.Url(url)) { withStyle(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline)) { append(url) } }
                last = mt.range.first + url.length
            }
            append(body.substring(last))
        }
    }
    Text(text, style = MaterialTheme.typography.bodyLarge)
}

private fun thumbOf(p: JSONObject): Bitmap? = try {
    val s = p.optString("thumb"); val i = s.indexOf("base64,")
    if (i < 0) null else Base64.decode(s.substring(i + 7), Base64.DEFAULT).let { BitmapFactory.decodeByteArray(it, 0, it.size) }
} catch (e: Exception) { null }

fun decodeSampled(path: String, max: Int): Bitmap? {
    val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, o)
    var s = 1
    while (maxOf(o.outWidth, o.outHeight) / s > max) s *= 2
    return BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = s })
}

@Composable
private fun ImageContent(repo: Repo, p: JSONObject, a: BubbleActions) {
    val meta = remember(p) { FileMeta.from(p.getJSONObject("file")) }
    val w = p.optInt("w", 4); val h = p.optInt("h", 3)
    val ratio = (w.toFloat() / h.coerceAtLeast(1)).coerceIn(0.5f, 2f)
    val thumb = remember(p) { thumbOf(p) }
    val bmp by produceState<Bitmap?>(null, meta.id) {
        value = try { val f = repo.getFile(meta); decodeSampled(f.absolutePath, 1600) } catch (e: Exception) { null }
    }
    Box(Modifier.width(240.dp).height((240 / ratio).dp).clip(RoundedCornerShape(10.dp)).clickable(enabled = bmp != null) { bmp?.let(a.onOpenImage) }) {
        val shown = bmp ?: thumb
        if (shown != null) Image(shown.asImageBitmap(), "Foto", Modifier.matchParentSize(), contentScale = ContentScale.Crop)
        if (bmp == null) LinearProgressIndicator(Modifier.align(Alignment.BottomCenter).fillMaxWidth())
    }
}

@Composable
private fun FileContent(repo: Repo, f: FileMeta, a: BubbleActions) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("📎", style = MaterialTheme.typography.headlineSmall)
        Column(Modifier.weight(1f, fill = false)) {
            Text(f.name, style = MaterialTheme.typography.bodyLarge, maxLines = 2)
            Text(fmtBytes(f.size), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        TextButton({ a.onSave(f) }) { Text("Speichern") }
    }
}

@Composable
private fun ViewOnce(repo: Repo, m: Msg, a: BubbleActions) {
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf(if (m.viewedAt != null) "done" else "ready") }
    var err by remember { mutableStateOf<String?>(null) }
    if (state == "done") { Text("🔒 Einmalansicht – bereits geöffnet", style = MaterialTheme.typography.bodyMedium); return }
    Column {
        Text("🔒 Einmalansicht", style = MaterialTheme.typography.bodyLarge)
        err?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall) }
        TextButton({
            scope.launch {
                val d = repo.openViewOnce(m)
                val p = d.payload
                if (p == null) { err = d.error ?: "Nicht lesbar"; return@launch }
                state = "done"
                if (p.optString("t") == "image") {
                    val meta = FileMeta.from(p.getJSONObject("file"))
                    try {
                        val f = repo.getFile(meta)
                        decodeSampled(f.absolutePath, 2000)?.let(a.onOpenImage)
                        f.delete()
                    } catch (e: Exception) { err = e.message }
                } else err = previewTextSafe(p)
            }
        }) { Text("Öffnen (nur einmal sichtbar)") }
    }
}

private fun previewTextSafe(p: JSONObject) = de.cracky.vela.data.previewText(p)

@Composable
private fun VoiceContent(repo: Repo, p: JSONObject) {
    val meta = remember(p) { FileMeta.from(p.getJSONObject("file")) }
    val duration = p.optDouble("duration", 0.0)
    val waveArr = p.optJSONArray("wave")
    val wave = remember(p) { (0 until (waveArr?.length() ?: 0).coerceAtMost(64)).map { waveArr!!.optDouble(it, 0.3).toFloat() }.ifEmpty { List(40) { 0.3f } } }
    var playing by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var pos by remember { mutableStateOf(0f) }
    var player by remember { mutableStateOf<MediaPlayer?>(null) }
    val scope = rememberCoroutineScope()
    DisposableEffect(Unit) { onDispose { player?.release() } }
    LaunchedEffect(playing) {
        while (playing) {
            player?.let { if (it.duration > 0) pos = it.currentPosition.toFloat() / it.duration }
            delay(100)
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton({
            scope.launch {
                val pl = player
                if (pl != null) {
                    if (pl.isPlaying) { pl.pause(); playing = false } else { pl.start(); playing = true }
                    return@launch
                }
                loading = true
                try {
                    val f = repo.getFile(meta)
                    val np = MediaPlayer()
                    np.setDataSource(f.absolutePath)
                    np.prepare()
                    np.setOnCompletionListener { playing = false; pos = 0f; it.seekTo(0) }
                    player = np; np.start(); playing = true
                } catch (e: Exception) { repo.say("Wiedergabe nicht möglich: ${e.message}") }
                loading = false
            }
        }) { Text(if (loading) "…" else if (playing) "⏸" else "▶", style = MaterialTheme.typography.titleLarge) }
        Row(Modifier.height(32.dp).widthIn(max = 160.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            wave.forEachIndexed { i, v ->
                Box(
                    Modifier.width(2.dp).height((6 + v.coerceIn(0f, 1f) * 24).dp)
                        .background(if (i < pos * wave.size) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline),
                )
            }
        }
        Text(fmtDuration(duration), style = MaterialTheme.typography.labelSmall)
    }
}
