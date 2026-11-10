@file:OptIn(ExperimentalFoundationApi::class)

package de.cracky.vela.ui

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaPlayer
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Done
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LooksOne
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Subtitles
import androidx.compose.material.icons.filled.Timer
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy
import de.cracky.vela.data.Conv
import de.cracky.vela.data.Dec
import de.cracky.vela.data.FileMeta
import de.cracky.vela.data.Msg
import de.cracky.vela.data.Repo
import de.cracky.vela.data.decodeSampled
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

val REACTIONS = listOf("👍", "❤️", "😂", "😮", "😢", "🙏")
private val URL_RE = Regex("""https?://[^\s<>"]+""")

class BubbleActions(
    val onReply: () -> Unit, val onEdit: (() -> Unit)?, val onDelete: (() -> Unit)?, val onCopy: (() -> Unit)?,
    val onReact: (String) -> Unit, val onSave: ((FileMeta) -> Unit), val onRetry: () -> Unit, val onOpenMedia: (String) -> Unit,
    val onJump: (String) -> Unit, val onLongPress: () -> Unit, val onShowReactions: () -> Unit,
)

/** Kleine Zeile aus Symbol und Text. */
@Composable
fun IconText(icon: ImageVector, text: String, color: Color = LocalContentColor.current, style: TextStyle = MaterialTheme.typography.bodyMedium) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(icon, null, Modifier.size(16.dp), tint = color)
        Text(text, color = color, style = style)
    }
}

@Composable
fun SystemRow(repo: Repo, m: Msg) {
    Box(Modifier.fillMaxWidth().padding(vertical = 6.dp), Alignment.Center) {
        Text(
            m.system?.let { systemText(repo, it) } ?: "", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)).padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

enum class Tick { Pending, Sent, Read, Failed }

fun tickOf(m: Msg, c: Conv, me: String): Tick {
    if (m.failed) return Tick.Failed
    if (m.pending) return Tick.Pending
    if (!c.isGroup) return if (m.readAt != null) Tick.Read else Tick.Sent
    val others = c.members.filter { it.id != me && it.joinedAt <= m.ts }
    if (others.isEmpty() || others.any { it.lastRead == null }) return Tick.Sent
    return if (others.all { (it.lastRead ?: 0) >= m.ts }) Tick.Read else Tick.Sent
}

@Composable
private fun TickIcon(t: Tick) {
    val (icon, tint) = when (t) {
        Tick.Pending -> Icons.Filled.Schedule to MaterialTheme.colorScheme.onSurfaceVariant
        Tick.Sent -> Icons.Filled.Done to MaterialTheme.colorScheme.onSurfaceVariant
        Tick.Read -> Icons.Filled.DoneAll to MaterialTheme.colorScheme.primary
        Tick.Failed -> Icons.Filled.ErrorOutline to MaterialTheme.colorScheme.error
    }
    Icon(icon, null, Modifier.size(15.dp), tint = tint)
}

@Composable
fun MessageBubble(
    repo: Repo, m: Msg, d: Dec?, conv: Conv, reactions: Map<String, String>, edited: String?,
    showSender: Boolean, a: BubbleActions, animateIn: Boolean = false,
    hidden: Boolean = false, highlight: String = "", nowTick: Long = 0L,
) {
    var revealed by remember(hidden) { mutableStateOf(false) }
    val mine = m.from == repo.myId
    val haptics = rememberHaptics()
    val payload = if (edited != null && d?.payload != null) JSONObject(d.payload.toString()).put("body", edited) else d?.payload
    val bg = if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val shape = if (mine) RoundedCornerShape(22.dp, 22.dp, 6.dp, 22.dp) else RoundedCornerShape(22.dp, 22.dp, 22.dp, 6.dp)

    // Erscheinen: neue Nachrichten federn leicht ein
    val appear = remember { Animatable(if (animateIn) 0f else 1f) }
    LaunchedEffect(Unit) { if (animateIn) appear.animateTo(1f, spring(dampingRatio = 0.6f, stiffness = 380f)) }
    LaunchedEffect(m.failed) { if (m.failed) haptics.reject() }

    // Wischen nach rechts = Antworten
    val maxSwipe = with(LocalDensity.current) { 72.dp.toPx() }
    val threshold = maxSwipe * 0.8f
    var dragX by remember { mutableFloatStateOf(0f) }
    var dragging by remember { mutableStateOf(false) }
    var crossed by remember { mutableStateOf(false) }
    val shownX by animateFloatAsState(
        targetValue = if (dragging) dragX else 0f,
        animationSpec = if (dragging) snap() else spring(dampingRatio = 0.55f, stiffness = 420f), label = "swipe",
    )
    val canSwipe = m.deletedAt == null && !m.viewOnce && d?.payload != null

    Box(Modifier.fillMaxWidth()) {
        if (shownX > 6f) {
            val f = (shownX / maxSwipe).coerceIn(0f, 1f)
            Icon(
                Icons.AutoMirrored.Filled.Reply, null,
                Modifier.align(Alignment.CenterStart).padding(start = 16.dp).size(24.dp).graphicsLayer { alpha = f; scaleX = 0.6f + 0.4f * f; scaleY = 0.6f + 0.4f * f },
                tint = MaterialTheme.colorScheme.primary,
            )
        }
        Row(
            Modifier.fillMaxWidth()
                .graphicsLayer {
                    translationX = shownX
                    val sc = 0.9f + 0.1f * appear.value
                    scaleX = sc; scaleY = sc; alpha = appear.value.coerceIn(0f, 1f)
                    transformOrigin = androidx.compose.ui.graphics.TransformOrigin(if (mine) 1f else 0f, 1f)
                }
                .pointerInput(canSwipe) {
                    if (canSwipe) detectHorizontalDragGestures(
                        onDragStart = { dragging = true; crossed = false; dragX = 0f },
                        onDragEnd = { if (dragX >= threshold) a.onReply(); dragging = false },
                        onDragCancel = { dragging = false },
                        onHorizontalDrag = { change, dx ->
                            change.consume()
                            dragX = (dragX + dx * 0.55f).coerceIn(0f, maxSwipe)
                            if (!crossed && dragX >= threshold) { crossed = true; haptics.gesture() }
                            else if (crossed && dragX < threshold * 0.7f) crossed = false
                        },
                    )
                }
                .padding(horizontal = 8.dp, vertical = 2.dp),
            horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
        ) {
            Box {
                androidx.compose.runtime.CompositionLocalProvider(
                    LocalContentColor provides (if (mine) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant),
                ) {
                Column(
                    Modifier.widthIn(max = 300.dp).clip(shape).background(bg).animateContentSize(spring(stiffness = 500f))
                        .combinedClickable(
                            onClick = { if (m.failed) a.onRetry() },
                            onLongClick = { if (m.deletedAt == null && !m.viewOnce) { haptics.longPress(); a.onLongPress() } },
                        )
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                ) {
                    if (showSender && !mine) Text(repo.nameOf(m.from), style = MaterialTheme.typography.labelMedium, color = hueColor(repo.nameOf(m.from)))
                    when {
                        m.deletedAt != null -> IconText(Icons.Filled.Block, "Diese Nachricht wurde gelöscht.", muted)
                        m.viewOnce && !mine -> ViewOnce(repo, m)
                        m.viewOnce && mine -> IconText(Icons.Filled.LooksOne, "Einmalansicht" + if (m.viewedAt != null) " (geöffnet)" else "")
                        d == null -> IconText(Icons.Filled.Lock, "wird entschlüsselt …", muted)
                        d.error != null -> IconText(Icons.Filled.Warning, d.error, MaterialTheme.colorScheme.error)
                        payload != null && hidden && !revealed -> Row(
                            Modifier.clickable { haptics.tick(); revealed = true }, verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Icon(Icons.Filled.VisibilityOff, null, Modifier.size(18.dp))
                            Text("Inhalt ausgeblendet – antippen zum Anzeigen", style = MaterialTheme.typography.bodyMedium)
                        }
                        payload != null -> PayloadContent(repo, payload, a, m.id, highlight)
                    }
                    Row(Modifier.align(Alignment.End), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (edited != null) Text("bearbeitet", style = MaterialTheme.typography.labelSmall, color = muted)
                        m.expiresAt?.let { exp ->
                            Icon(Icons.Filled.Timer, "Verschwindet", Modifier.size(12.dp), tint = muted)
                            Text(fmtRemaining(exp - (if (nowTick > 0) nowTick else System.currentTimeMillis())), style = MaterialTheme.typography.labelSmall, color = muted)
                        }
                        Text(fmtTime(m.ts), style = MaterialTheme.typography.labelSmall, color = muted)
                        if (mine) AnimatedContent(
                            targetState = tickOf(m, conv, repo.myId),
                            transitionSpec = { (scaleIn(spring(dampingRatio = 0.5f)) + fadeIn()) togetherWith (scaleOut() + fadeOut()) },
                            label = "tick",
                        ) { TickIcon(it) }
                    }
                    if (m.failed) Text("Nicht gesendet – tippen zum erneuten Senden", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                    if (reactions.isNotEmpty()) {
                        val grouped = reactions.values.filter { it.isNotEmpty() }.groupingBy { it }.eachCount()
                        val mineReaction = reactions[repo.myId]
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 3.dp)) {
                            for ((e, n) in grouped) Text(
                                if (n > 1) "$e $n" else e, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurface,
                                modifier = Modifier.clip(RoundedCornerShape(12.dp))
                                    .background(if (e == mineReaction) MaterialTheme.colorScheme.tertiaryContainer else MaterialTheme.colorScheme.background.copy(alpha = 0.7f))
                                    .clickable { haptics.tick(); a.onShowReactions() }
                                    .padding(horizontal = 7.dp, vertical = 2.dp),
                            )
                        }
                    }
                }
                }
            }
        }
    }
}

@Composable
private fun PayloadContent(repo: Repo, p: JSONObject, a: BubbleActions, msgId: String, highlight: String = "") {
    p.optJSONObject("reply")?.let { r ->
        Column(
            Modifier.padding(bottom = 4.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.background.copy(alpha = 0.5f))
                .clickable { a.onJump(r.optString("id")) }.padding(6.dp),
        ) {
            Text(repo.nameOf(r.optString("from").takeIf { it.isNotEmpty() && it != "null" }), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
            Text(r.optString("snippet"), style = MaterialTheme.typography.bodySmall, maxLines = 2)
        }
    }
    if (p.optBoolean("fwd")) Text("Weitergeleitet", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    when (p.optString("t")) {
        "text" -> {
            LinkText(p.optString("body"), highlight)
            p.optJSONObject("link")?.let { LinkCard(it) }
        }
        "image" -> ImageContent(repo, p, a, msgId)
        "file" -> if (isVideoPayload(p)) VideoContent(repo, p, a, msgId) else FileContent(FileMeta.from(p.getJSONObject("file")), a)
        "voice" -> VoiceContent(repo, p)
        else -> Text("Nicht unterstützte Nachricht", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun LinkText(body: String, highlight: String = "") {
    val linkColor = MaterialTheme.colorScheme.primary
    val hl = MaterialTheme.colorScheme.tertiaryContainer
    val text: AnnotatedString = remember(body, linkColor, highlight, hl) {
        buildAnnotatedString {
            var last = 0
            for (mt in URL_RE.findAll(body)) {
                append(body.substring(last, mt.range.first))
                val url = mt.value.trimEnd('.', ',', ')', '!', '?')
                withLink(LinkAnnotation.Url(url)) { withStyle(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline)) { append(url) } }
                last = mt.range.first + url.length
            }
            append(body.substring(last))
            if (highlight.isNotEmpty()) {
                var from = 0
                while (true) {
                    val at = body.indexOf(highlight, from, ignoreCase = true)
                    if (at < 0) break
                    addStyle(SpanStyle(background = hl), at, at + highlight.length)
                    from = at + highlight.length
                }
            }
        }
    }
    Text(text, style = MaterialTheme.typography.bodyLarge)
}

/** Linkvorschau (vom Absender mitgeschickt – dein Gerät ruft die Seite nicht auf). */
@Composable
private fun LinkCard(link: JSONObject) {
    val uri = androidx.compose.ui.platform.LocalUriHandler.current
    val url = link.optString("url")
    val thumb = remember(link) { link.optString("thumb").takeIf { it.isNotEmpty() }?.let { de.cracky.vela.data.decodeDataUrl(it) } }
    val host = remember(url) { runCatching { java.net.URI(url).host.removePrefix("www.") }.getOrDefault(url) }
    Column(
        Modifier.padding(top = 6.dp).width(240.dp).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.background.copy(alpha = 0.55f))
            .clickable { runCatching { uri.openUri(url) } },
    ) {
        thumb?.let { Image(it.asImageBitmap(), null, Modifier.fillMaxWidth().height(120.dp), contentScale = ContentScale.Crop) }
        Column(Modifier.padding(10.dp)) {
            Text(host, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
            Text(link.optString("title"), style = MaterialTheme.typography.titleSmall, maxLines = 2)
            link.optString("description").takeIf { it.isNotEmpty() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 3, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

fun fmtRemaining(ms: Long): String {
    val m = ms / 60000
    return when {
        ms <= 0 -> "gleich weg"
        m >= 2 * 24 * 60 -> "${m / (24 * 60)} Tg."
        m >= 60 -> "${m / 60} Std."
        m >= 1 -> "$m Min."
        else -> "< 1 Min."
    }
}

private fun thumbOf(p: JSONObject): Bitmap? = try {
    val s = p.optString("thumb"); val i = s.indexOf("base64,")
    if (i < 0) null else Base64.decode(s.substring(i + 7), Base64.DEFAULT).let { BitmapFactory.decodeByteArray(it, 0, it.size) }
} catch (e: Exception) { null }

@Composable
private fun ImageContent(repo: Repo, p: JSONObject, a: BubbleActions, msgId: String) {
    val meta = remember(p) { FileMeta.from(p.getJSONObject("file")) }
    val w = p.optInt("w", 4); val h = p.optInt("h", 3)
    val ratio = (w.toFloat() / h.coerceAtLeast(1)).coerceIn(0.5f, 2f)
    val thumb = remember(p) { thumbOf(p) }
    val bmp by produceState<Bitmap?>(null, meta.id) {
        value = try { val f = repo.getFile(meta); decodeSampled(f.absolutePath, 1600) } catch (e: Exception) { null }
    }
    Box(Modifier.width(240.dp).height((240 / ratio).dp).clip(RoundedCornerShape(10.dp)).clickable { a.onOpenMedia(msgId) }) {
        val shown = bmp ?: thumb
        if (shown != null) Image(shown.asImageBitmap(), "Foto", Modifier.matchParentSize(), contentScale = ContentScale.Crop)
        if (bmp == null) LinearProgressIndicator(Modifier.align(Alignment.BottomCenter).fillMaxWidth())
    }
}

/** Video wie bei WhatsApp: Vorschaubild, Abspiel-Knopf, Dauer und Größe; Antippen öffnet den Player. */
@Composable
private fun VideoContent(repo: Repo, p: JSONObject, a: BubbleActions, msgId: String) {
    val meta = remember(p) { FileMeta.from(p.getJSONObject("file")) }
    val w = p.optInt("w", 16); val h = p.optInt("h", 9)
    val ratio = (if (w > 0 && h > 0) w.toFloat() / h else 16f / 9f).coerceIn(0.6f, 1.9f)
    val duration = p.optDouble("duration", 0.0)
    val thumbData = p.optString("thumb")
    val thumb by produceState<Bitmap?>(null, meta.id) {
        value = if (thumbData.isNotEmpty() && thumbData != "null") de.cracky.vela.data.decodeDataUrl(thumbData) else null
        if (value == null) repo.localFile(meta)?.let { value = localVideoFrame(it) }
    }
    Box(Modifier.width(240.dp).height((240 / ratio).dp).clip(RoundedCornerShape(12.dp)).background(Color(0xFF1B1B1B)).clickable { a.onOpenMedia(msgId) }) {
        thumb?.let { Image(it.asImageBitmap(), "Videovorschau", Modifier.matchParentSize(), contentScale = ContentScale.Crop) }
        Box(
            Modifier.align(Alignment.Center).size(54.dp).clip(androidx.compose.foundation.shape.CircleShape).background(Color(0x99000000)),
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Filled.PlayArrow, "Video abspielen", Modifier.size(36.dp), tint = Color.White) }
        Row(
            Modifier.align(Alignment.BottomStart).padding(8.dp).clip(RoundedCornerShape(10.dp)).background(Color(0x99000000)).padding(horizontal = 8.dp, vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Icon(Icons.Filled.Videocam, null, Modifier.size(14.dp), tint = Color.White)
            Text((if (duration > 0) fmtDuration(duration) + " · " else "") + fmtBytes(meta.size), color = Color.White, style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
private fun FileContent(f: FileMeta, a: BubbleActions) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(Icons.Filled.InsertDriveFile, null, Modifier.size(28.dp), tint = MaterialTheme.colorScheme.primary)
        Column(Modifier.weight(1f, fill = false)) {
            Text(f.name, style = MaterialTheme.typography.bodyLarge, maxLines = 2)
            Text(fmtBytes(f.size), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        TextButton({ a.onSave(f) }) { Text("Speichern") }
    }
}

// ---------------------------------------------------------------- Einmalansicht (Empfänger)
@Composable
private fun ViewOnce(repo: Repo, m: Msg) {
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    var confirm by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var opened by remember { mutableStateOf(false) }
    var content by remember { mutableStateOf<Repo.ViewOnceContent?>(null) }
    var err by remember { mutableStateOf<String?>(null) }

    if (m.viewedAt != null && content == null) {
        IconText(Icons.Filled.LooksOne, "Einmalansicht – bereits geöffnet", MaterialTheme.colorScheme.onSurfaceVariant)
    } else if (content == null) {
        Column {
            IconText(Icons.Filled.LooksOne, "Einmalansicht", style = MaterialTheme.typography.bodyLarge)
            err?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall) }
            if (loading) CircularProgressIndicator(Modifier.padding(8.dp).size(22.dp), strokeWidth = 2.dp)
            else TextButton({ confirm = true }, enabled = !opened) { Text("Öffnen") }
        }
    }
    if (confirm) AlertDialog(
        onDismissRequest = { confirm = false },
        title = { Text("Einmalansicht öffnen?") },
        text = { Text("Du kannst den Inhalt nur jetzt ansehen. Beim Öffnen wird er vom Server gelöscht und beim Schließen auch von diesem Gerät. Bitte respektiere die Privatsphäre des Absenders. Screenshots sind in dieser Ansicht gesperrt.") },
        confirmButton = {
            TextButton({
                confirm = false; loading = true; err = null
                scope.launch {
                    try { content = repo.openViewOnce(m); opened = true; haptics.confirm() } catch (e: Exception) { err = e.message ?: "Öffnen fehlgeschlagen"; haptics.reject() }
                    loading = false
                }
            }) { Text("Öffnen") }
        },
        dismissButton = { TextButton({ confirm = false }) { Text("Abbrechen") } },
    )
    content?.let { c ->
        ViewOnceViewer(repo, c) { content = null; c.image?.recycle() }
    }
}

@Composable
private fun ViewOnceViewer(repo: Repo, c: Repo.ViewOnceContent, onClose: () -> Unit) {
    Dialog(
        onDismissRequest = onClose,
        properties = DialogProperties(usePlatformDefaultWidth = false, securePolicy = SecureFlagPolicy.SecureOn),
    ) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            val img = c.image
            if (img != null) {
                Image(img.asImageBitmap(), "Einmalansicht", Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
            } else {
                Column(Modifier.fillMaxSize().padding(24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.Center) {
                    Text(c.text.orEmpty(), color = Color.White, style = MaterialTheme.typography.headlineSmall)
                }
            }
            Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Row(
                    Modifier.clip(RoundedCornerShape(16.dp)).background(Color(0x66000000)).padding(horizontal = 10.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(Icons.Filled.LooksOne, null, Modifier.size(16.dp), tint = Color.White)
                    Text("Einmalansicht – wird beim Schließen gelöscht", color = Color.White, style = MaterialTheme.typography.labelMedium)
                }
                Box(Modifier.weight(1f))
                IconButton(onClose) { Icon(Icons.Filled.Close, "Schließen", tint = Color.White) }
            }
            c.caption?.let { Text(it, color = Color.White, modifier = Modifier.align(Alignment.BottomCenter).padding(24.dp)) }
        }
    }
}

// ---------------------------------------------------------------- Sprachnachricht
@Composable
private fun VoiceContent(repo: Repo, p: JSONObject) {
    val ctx = LocalContext.current
    val haptics = rememberHaptics()
    val meta = remember(p) { FileMeta.from(p.getJSONObject("file")) }
    val duration = p.optDouble("duration", 0.0)
    val waveArr = p.optJSONArray("wave")
    val wave = remember(p) { (0 until (waveArr?.length() ?: 0).coerceAtMost(64)).map { waveArr!!.optDouble(it, 0.3).toFloat() }.ifEmpty { List(40) { 0.3f } } }
    var playing by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var pos by remember { mutableStateOf(0f) }
    var player by remember { mutableStateOf<MediaPlayer?>(null) }
    var running by remember { mutableStateOf(false) }
    var consent by remember { mutableStateOf(false) }
    var terr by remember { mutableStateOf<String?>(null) }
    val transcripts by repo.transcripts.collectAsState()
    val transcript = transcripts[meta.id]
    val scope = rememberCoroutineScope()

    fun runTranscription() {
        running = true; terr = null
        scope.launch {
            try { repo.transcribe(meta); haptics.confirm() } catch (e: Exception) { terr = e.message ?: "Transkription fehlgeschlagen"; haptics.reject() }
            running = false
        }
    }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { runTranscription() }
    fun startTranscription() {
        val needMic = repo.store.transcribeEngine != "server" && android.os.Build.VERSION.SDK_INT >= 33
        if (needMic && androidx.core.content.ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            micPermission.launch(Manifest.permission.RECORD_AUDIO)
        } else runTranscription()
    }

    DisposableEffect(Unit) { onDispose { player?.release() } }
    LaunchedEffect(playing) {
        while (playing) {
            player?.let { if (it.duration > 0) pos = it.currentPosition.toFloat() / it.duration }
            delay(100)
        }
    }
    Column {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilledTonalIconButton(
                onClick = {
                    haptics.tick()
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
                },
                modifier = Modifier.size(40.dp),
            ) {
                if (loading) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                else Icon(if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow, if (playing) "Pause" else "Abspielen")
            }
            Row(Modifier.height(32.dp).widthIn(max = 130.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                wave.forEachIndexed { i, v ->
                    Box(
                        Modifier.width(2.dp).height((6 + v.coerceIn(0f, 1f) * 24).dp)
                            .background(if (i < pos * wave.size) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline),
                    )
                }
            }
            Text(fmtDuration(duration), style = MaterialTheme.typography.labelSmall)
            if (running) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            else if (transcript == null) IconButton({
                if (repo.store.transcribeEnabled) startTranscription() else consent = true
            }, Modifier.size(36.dp)) { Icon(Icons.Filled.Subtitles, "Transkribieren") }
        }
        terr?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error) }
        transcript?.let {
            Text(
                if (repo.store.transcribeEngine == "server") "Transkript – vom eigenen Whisper-Server" else "Transkript – auf dem Gerät erstellt",
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp),
            )
            Text(it, style = MaterialTheme.typography.bodyMedium)
        }
    }
    if (consent) AlertDialog(
        onDismissRequest = { consent = false },
        title = { Text("Transkription aktivieren?") },
        text = {
            Text(
                if (repo.store.transcribeEngine == "server")
                    "Das entschlüsselte Audio wird zur Umwandlung an deinen eigenen Whisper-Server gesendet (${repo.store.whisperUrl.ifBlank { "noch nicht eingetragen – bitte unter Einstellungen ▸ Transkription angeben" }}). Es wird nicht an Vela zurückgespeichert."
                else
                    "Sprachnachrichten werden mit der Offline-Spracherkennung deines Geräts in Text umgewandelt. Das Audio verlässt das Gerät nicht. Android verlangt dafür die Mikrofon-Berechtigung.",
            )
        },
        confirmButton = { TextButton({ consent = false; repo.store.transcribeEnabled = true; startTranscription() }) { Text("Aktivieren") } },
        dismissButton = { TextButton({ consent = false }) { Text("Abbrechen") } },
    )
}
