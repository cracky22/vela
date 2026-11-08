@file:OptIn(ExperimentalFoundationApi::class)

package de.cracky.vela.ui

import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.isSpecified
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import de.cracky.vela.data.Dec
import de.cracky.vela.data.FileMeta
import de.cracky.vela.data.Msg
import de.cracky.vela.data.Repo
import de.cracky.vela.data.decodeDataUrl
import de.cracky.vela.data.decodeSampled
import de.cracky.vela.data.videoFrame
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.abs

/** Ein Bild oder Video aus dem Chat für die Galerie. */
class MediaEntry(
    val msgId: String, val meta: FileMeta, val video: Boolean, val from: String?, val ts: Long,
    val thumbData: String?, val w: Int, val h: Int, val duration: Double,
)

private val VIDEO_EXTS = setOf("mp4", "m4v", "mov", "3gp", "mkv", "webm", "avi")

/** Ist die Nachricht ein Video? Prüft MIME-Typ und Dateiendung (Web-Client schickt manchmal „application/octet-stream“). */
fun isVideoPayload(p: org.json.JSONObject): Boolean {
    if (p.optString("t") != "file") return false
    val f = p.optJSONObject("file") ?: return false
    return f.optString("mime").startsWith("video/") || f.optString("name").substringAfterLast('.', "").lowercase() in VIDEO_EXTS
}

/** Alle Bilder und Videos eines Chats in zeitlicher Reihenfolge. */
fun collectMedia(msgs: List<Msg>, dec: Map<String, Dec>): List<MediaEntry> = msgs.mapNotNull { m ->
    if (m.viewOnce || m.deletedAt != null) return@mapNotNull null
    val p = dec[m.id]?.payload ?: return@mapNotNull null
    val video = isVideoPayload(p)
    if (p.optString("t") != "image" && !video) return@mapNotNull null
    val f = p.optJSONObject("file") ?: return@mapNotNull null
    MediaEntry(m.id, FileMeta.from(f), video, m.from, m.ts, p.optString("thumb").takeIf { it.isNotEmpty() && it != "null" }, p.optInt("w"), p.optInt("h"), p.optDouble("duration", 0.0))
}

/** Vollbild-Galerie: wischen zum Blättern, Doppeltippen/Zwicken zum Zoomen, nach unten/oben ziehen zum Schließen. */
@Composable
fun MediaViewer(
    repo: Repo, items: List<MediaEntry>, startIndex: Int,
    onSave: (FileMeta) -> Unit, onShare: (FileMeta) -> Unit, onClose: () -> Unit,
) {
    if (items.isEmpty()) { LaunchedEffect(Unit) { onClose() }; return }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val pager = rememberPagerState(initialPage = startIndex.coerceIn(0, items.lastIndex)) { items.size }
        var zoomed by remember { mutableStateOf(false) }
        var chrome by remember { mutableStateOf(true) }
        var dragFraction by remember { mutableFloatStateOf(0f) }
        val cur = items.getOrNull(pager.currentPage)
        LaunchedEffect(pager.currentPage) { zoomed = false; dragFraction = 0f }
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 1f - dragFraction * 0.85f))) {
            HorizontalPager(pager, Modifier.fillMaxSize(), userScrollEnabled = !zoomed, key = { items[it].msgId }) { page ->
                val e = items[page]
                if (e.video) VideoPage(repo, e, active = pager.currentPage == page)
                else ImagePage(repo, e, onTap = { chrome = !chrome }, onZoom = { zoomed = it }, onDrag = { dragFraction = it }, onDismiss = onClose)
            }
            AnimatedVisibility(
                visible = (chrome || cur?.video == true) && dragFraction < 0.04f,
                modifier = Modifier.align(Alignment.TopCenter), enter = fadeIn(), exit = fadeOut(),
            ) {
                Row(
                    Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color(0xAA000000), Color.Transparent)))
                        .windowInsetsPadding(WindowInsets.statusBars).padding(horizontal = 4.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Schließen", tint = Color.White) }
                    Column(Modifier.weight(1f)) {
                        Text(cur?.let { if (it.from == repo.myId) "Du" else repo.nameOf(it.from) }.orEmpty(), color = Color.White, style = androidx.compose.material3.MaterialTheme.typography.titleMedium)
                        Text(
                            cur?.let { fmtDay(it.ts) + ", " + fmtTime(it.ts) + (if (items.size > 1) "  ·  ${pager.currentPage + 1}/${items.size}" else "") }.orEmpty(),
                            color = Color(0xCCFFFFFF), style = androidx.compose.material3.MaterialTheme.typography.labelMedium,
                        )
                    }
                    IconButton({ cur?.let { onShare(it.meta) } }) { Icon(Icons.Filled.Share, "Teilen", tint = Color.White) }
                    IconButton({ cur?.let { onSave(it.meta) } }) { Icon(Icons.Filled.Download, "Speichern", tint = Color.White) }
                }
            }
        }
    }
}

@Composable
private fun ImagePage(repo: Repo, e: MediaEntry, onTap: () -> Unit, onZoom: (Boolean) -> Unit, onDrag: (Float) -> Unit, onDismiss: () -> Unit) {
    val thumb = remember(e.msgId) { e.thumbData?.let { decodeDataUrl(it) } }
    val bmp by produceState<Bitmap?>(null, e.meta.id) {
        value = try {
            val f = repo.getFile(e.meta)
            withContext(Dispatchers.IO) { decodeSampled(f.absolutePath, 3000) }
        } catch (x: Exception) { null }
    }
    ZoomableBox(onTap, onZoom, onDrag, onDismiss) {
        val shown = bmp ?: thumb
        if (shown != null) Image(shown.asImageBitmap(), "Foto", Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
        if (bmp == null) CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color.White)
    }
}

@Composable
private fun ZoomableBox(
    onTap: () -> Unit, onZoom: (Boolean) -> Unit, onDrag: (Float) -> Unit, onDismiss: () -> Unit,
    content: @Composable BoxScope.() -> Unit,
) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offX by remember { mutableFloatStateOf(0f) }
    var offY by remember { mutableFloatStateOf(0f) }
    var dragY by remember { mutableFloatStateOf(0f) }
    var gesturing by remember { mutableStateOf(false) }
    val spec: AnimationSpec<Float> = if (gesturing) snap() else spring(dampingRatio = 0.8f, stiffness = 380f)
    val sc by animateFloatAsState(scale, spec, label = "zoomScale")
    val ox by animateFloatAsState(offX, spec, label = "zoomX")
    val oy by animateFloatAsState(offY + dragY, spec, label = "zoomY")
    Box(
        Modifier.fillMaxSize()
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = { onTap() },
                    onDoubleTap = { p ->
                        if (scale > 1.05f) { scale = 1f; offX = 0f; offY = 0f; onZoom(false) }
                        else {
                            val s = 2.5f
                            val maxX = size.width * (s - 1) / 2f; val maxY = size.height * (s - 1) / 2f
                            scale = s
                            offX = ((size.width / 2f - p.x) * (s - 1)).coerceIn(-maxX, maxX)
                            offY = ((size.height / 2f - p.y) * (s - 1)).coerceIn(-maxY, maxY)
                            onZoom(true)
                        }
                    },
                )
            }
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    gesturing = true
                    var mode = 0 // 0 offen, 1 senkrecht ziehen (Schließen), 2 waagerecht (gehört dem Pager)
                    var totX = 0f
                    var totY = 0f
                    do {
                        val ev = awaitPointerEvent()
                        if (ev.changes.none { it.isConsumed }) {
                            val pressed = ev.changes.count { it.pressed }
                            val zoom = ev.calculateZoom()
                            val pan = ev.calculatePan()
                            val c = ev.calculateCentroid(useCurrent = false)
                            if (pressed > 1 || scale > 1.02f) {
                                val ns = (scale * zoom).coerceIn(1f, 6f)
                                var nx = offX
                                var ny = offY
                                if (c.isSpecified) {
                                    val rx = c.x - size.width / 2f
                                    val ry = c.y - size.height / 2f
                                    nx = rx - (rx - offX) * ns / scale
                                    ny = ry - (ry - offY) * ns / scale
                                }
                                nx += pan.x; ny += pan.y
                                scale = ns
                                val maxX = size.width * (ns - 1) / 2f
                                val maxY = size.height * (ns - 1) / 2f
                                offX = nx.coerceIn(-maxX, maxX); offY = ny.coerceIn(-maxY, maxY)
                                onZoom(ns > 1.02f)
                                ev.changes.forEach { if (it.positionChanged()) it.consume() }
                            } else {
                                totX += pan.x; totY += pan.y
                                if (mode == 0 && (abs(totX) > 18f || abs(totY) > 18f)) mode = if (abs(totY) > abs(totX) * 1.2f) 1 else 2
                                if (mode == 1) {
                                    dragY += pan.y
                                    onDrag((abs(dragY) / size.height).coerceIn(0f, 1f))
                                    ev.changes.forEach { if (it.positionChanged()) it.consume() }
                                }
                            }
                        }
                    } while (ev.changes.any { it.pressed })
                    gesturing = false
                    if (scale <= 1.02f) {
                        scale = 1f; offX = 0f; offY = 0f; onZoom(false)
                        if (abs(dragY) > size.height * 0.16f) onDismiss() else { dragY = 0f; onDrag(0f) }
                    }
                }
            }
            .graphicsLayer { scaleX = sc; scaleY = sc; translationX = ox; translationY = oy },
        content = content,
    )
}

@Composable
private fun VideoPage(repo: Repo, e: MediaEntry, active: Boolean) {
    val ctx = LocalContext.current
    var progress by remember { mutableFloatStateOf(0f) }
    var error by remember { mutableStateOf<String?>(null) }
    val file by produceState<File?>(repo.localFile(e.meta), e.meta.id, active) {
        if (active && value == null) {
            try { value = repo.getFile(e.meta) { progress = it } } catch (x: Exception) { error = x.message ?: "Video konnte nicht geladen werden" }
        }
    }
    val f = file
    if (f == null) {
        val thumb = remember(e.msgId) { e.thumbData?.let { decodeDataUrl(it) } }
        Box(Modifier.fillMaxSize(), Alignment.Center) {
            thumb?.let { Image(it.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit) }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                if (error != null) Text(error.orEmpty(), color = Color.White)
                else {
                    CircularProgressIndicator(color = Color.White)
                    LinearProgressIndicator(progress = { progress }, modifier = Modifier.padding(top = 12.dp).fillMaxWidth(0.5f))
                    Text("Video wird geladen … ${fmtBytes(e.meta.size)}", color = Color.White, modifier = Modifier.padding(top = 8.dp))
                }
            }
        }
    } else {
        val player = remember(f) {
            ExoPlayer.Builder(ctx).build().apply {
                setMediaItem(MediaItem.Builder().setUri(Uri.fromFile(f)).setMimeType(if (e.meta.mime.startsWith("video/")) e.meta.mime else null).build())
                prepare()
            }
        }
        DisposableEffect(player) { onDispose { player.release() } }
        LaunchedEffect(active, player) { player.playWhenReady = active }
        AndroidView(
            factory = { c -> PlayerView(c).apply { this.player = player; useController = true } },
            update = { it.player = player },
            modifier = Modifier.fillMaxSize(),
        )
    }
}

/** Standbild für Videovorschau in Nachrichten (aus der lokalen Datei). */
suspend fun localVideoFrame(f: File): Bitmap? = withContext(Dispatchers.IO) { videoFrame(f.absolutePath) }
