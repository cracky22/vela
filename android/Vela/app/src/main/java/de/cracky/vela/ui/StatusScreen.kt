@file:OptIn(ExperimentalMaterial3Api::class)

package de.cracky.vela.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import de.cracky.vela.data.FileMeta
import de.cracky.vela.data.ReplyRef
import de.cracky.vela.data.Repo
import de.cracky.vela.data.StatusItem
import de.cracky.vela.data.decodeDataUrl
import de.cracky.vela.data.decodeSampled
import kotlinx.coroutines.launch

private val STATUS_BG = listOf(
    0xFF00897BL to 0xFF004D40L, 0xFF5C6BC0L to 0xFF283593L, 0xFFE65100L to 0xFFBF360CL, 0xFF8E24AAL to 0xFF4A148CL,
    0xFF2E7D32L to 0xFF1B5E20L, 0xFFC2185BL to 0xFF880E4FL, 0xFF37474FL to 0xFF102027L,
)

private fun bgBrush(i: Int): Brush {
    val (a, b) = STATUS_BG[((i % STATUS_BG.size) + STATUS_BG.size) % STATUS_BG.size]
    return Brush.linearGradient(listOf(Color(a), Color(b)))
}

private fun ago(ts: Long): String {
    val m = ((System.currentTimeMillis() - ts) / 60000).toInt()
    return when {
        m < 1 -> "gerade eben"
        m < 60 -> "vor $m Min."
        m < 24 * 60 -> "vor ${m / 60} Std."
        else -> fmtListTime(ts)
    }
}

@Composable
private fun StatusRing(seen: List<Boolean>, size: Dp, content: @Composable () -> Unit) {
    val primary = MaterialTheme.colorScheme.primary
    val dim = MaterialTheme.colorScheme.outlineVariant
    Box(Modifier.size(size + 12.dp), contentAlignment = Alignment.Center) {
        if (seen.isNotEmpty()) Canvas(Modifier.matchParentSize()) {
            val n = seen.size
            val stroke = 3.dp.toPx()
            val gap = if (n > 1) 8f else 0f
            val sweep = 360f / n
            seen.forEachIndexed { i, s ->
                drawArc(
                    color = if (s) dim else primary, startAngle = -90f + i * sweep + gap / 2, sweepAngle = sweep - gap, useCenter = false,
                    topLeft = Offset(stroke / 2, stroke / 2), size = Size(this.size.width - stroke, this.size.height - stroke),
                    style = Stroke(stroke, cap = StrokeCap.Round),
                )
            }
        }
        content()
    }
}

@Composable
fun StatusScreen(repo: Repo) {
    val statuses by repo.statuses.collectAsState()
    val convs by repo.convs.collectAsState()
    val me by repo.me.collectAsState()
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    var refreshing by remember { mutableStateOf(false) }
    var viewer by remember { mutableStateOf<Pair<List<String>, Int>?>(null) }
    var createMenu by remember { mutableStateOf(false) }
    var composeText by remember { mutableStateOf(false) }
    var photoUri by remember { mutableStateOf<Uri?>(null) }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri -> if (uri != null) photoUri = uri }

    val myId = me?.id ?: ""
    val contactIds = convs.filter { !it.isGroup && it.status == "accepted" }.map { it.id }.toSet()
    val groups = statuses.filter { it.userId == myId || it.userId in contactIds }.groupBy { it.userId }
    val mine = groups[myId].orEmpty()
    val others = groups.filterKeys { it != myId }.entries.toList()
    fun latest(l: List<StatusItem>) = l.maxOf { it.ts }
    val unseen = others.filter { e -> e.value.any { !it.seen } }.sortedByDescending { latest(it.value) }
    val seen = others.filter { e -> e.value.all { it.seen } }.sortedByDescending { latest(it.value) }
    fun nameOf(id: String) = convs.firstOrNull { it.id == id }?.title ?: repo.nameOf(id)

    Box(Modifier.fillMaxSize()) {
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { refreshing = true; scope.launch { repo.loadStatuses(); refreshing = false } },
            modifier = Modifier.fillMaxSize(),
        ) {
            LazyColumn(Modifier.fillMaxSize()) {
                item { Text("Status", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.padding(20.dp, 16.dp, 20.dp, 8.dp)) }
                item {
                    StatusRow(
                        repo, myId, mine, "Mein Status",
                        if (mine.isNotEmpty()) "${mine.size} ${if (mine.size == 1) "Update" else "Updates"} · ${ago(latest(mine))}" else "Tippe, um ein Update zu teilen",
                        isMine = true,
                    ) { haptics.light(); if (mine.isNotEmpty()) viewer = listOf(myId) to 0 else createMenu = true }
                }
                if (unseen.isNotEmpty()) {
                    item { Text("Neue Updates", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(20.dp, 12.dp, 20.dp, 4.dp)) }
                    items(unseen, key = { "u" + it.key }) { e ->
                        StatusRow(repo, e.key, e.value, nameOf(e.key), ago(latest(e.value))) { haptics.light(); viewer = unseen.map { it.key } to unseen.indexOfFirst { x -> x.key == e.key } }
                    }
                }
                if (seen.isNotEmpty()) {
                    item { Text("Angesehen", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(20.dp, 12.dp, 20.dp, 4.dp)) }
                    items(seen, key = { "s" + it.key }) { e ->
                        StatusRow(repo, e.key, e.value, nameOf(e.key), ago(latest(e.value))) { haptics.light(); viewer = seen.map { it.key } to seen.indexOfFirst { x -> x.key == e.key } }
                    }
                }
                if (others.isEmpty()) item {
                    Text(
                        "Noch keine Status-Updates von deinen Kontakten. Teile, was gerade los ist – nur deine Kontakte sehen es, nach 24 Stunden ist es weg.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(24.dp),
                    )
                }
                item {
                    Row(Modifier.padding(20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(Icons.Filled.Lock, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text("Status-Updates sind Ende-zu-Ende-verschlüsselt und verschwinden nach 24 Stunden.", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        Column(Modifier.align(Alignment.BottomEnd).padding(16.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SmallFloatingActionButton({ haptics.light(); composeText = true }) { Icon(Icons.Filled.Edit, "Text-Status") }
            FloatingActionButton({ haptics.light(); pick.launch("image/*") }, shape = RoundedCornerShape(20.dp)) { Icon(Icons.Filled.PhotoCamera, "Foto-Status") }
        }
    }

    if (createMenu) AlertDialog(
        onDismissRequest = { createMenu = false }, title = { Text("Status teilen") },
        text = { Text("Nur deine angenommenen Kontakte sehen deinen Status. Nach 24 Stunden wird er automatisch gelöscht.") },
        confirmButton = { TextButton({ createMenu = false; pick.launch("image/*") }) { Text("Foto") } },
        dismissButton = { Row { TextButton({ createMenu = false }) { Text("Abbrechen") }; TextButton({ createMenu = false; composeText = true }) { Text("Text") } } },
    )
    if (composeText) TextStatusComposer(repo) { composeText = false }
    photoUri?.let { PhotoStatusComposer(repo, it) { photoUri = null } }
    viewer?.let { (ids, start) -> StoryViewer(repo, ids, start.coerceAtLeast(0)) { viewer = null } }
}

@Composable
private fun StatusRow(repo: Repo, userId: String, list: List<StatusItem>, title: String, subtitle: String, isMine: Boolean = false, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        StatusRing(list.map { it.seen || isMine }, 52.dp) {
            Box {
                Avatar(repo, userId, false, if (isMine) repo.me.value?.avatarVersion ?: 0 else 0, title, 52.dp)
                if (isMine && list.isEmpty()) Icon(
                    Icons.Filled.Add, null,
                    Modifier.align(Alignment.BottomEnd).size(20.dp).background(MaterialTheme.colorScheme.primary, CircleShape).padding(3.dp),
                    tint = MaterialTheme.colorScheme.onPrimary,
                )
            }
        }
        Column {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

// ====================================================================== Beitrag erstellen
@Composable
private fun TextStatusComposer(repo: Repo, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    var text by remember { mutableStateOf("") }
    var bg by remember { mutableIntStateOf((0 until STATUS_BG.size).random()) }
    var busy by remember { mutableStateOf(false) }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(bgBrush(bg))) {
            Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClose) { Icon(Icons.Filled.Close, "Schließen", tint = Color.White) }
                Box(Modifier.weight(1f))
                IconButton({ haptics.tick(); bg++ }) { Icon(Icons.Filled.Palette, "Hintergrund wechseln", tint = Color.White) }
            }
            TextField(
                text, { if (it.length <= 500) text = it }, modifier = Modifier.align(Alignment.Center).fillMaxWidth().padding(24.dp),
                placeholder = { Text("Was gibt’s Neues?", color = Color.White.copy(alpha = 0.6f), fontSize = 28.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) },
                textStyle = LocalTextStyle.current.copy(fontSize = 28.sp, textAlign = TextAlign.Center, color = Color.White, fontWeight = FontWeight.SemiBold),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, cursorColor = Color.White,
                    focusedTextColor = Color.White, unfocusedTextColor = Color.White,
                ),
            )
            Row(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Lock, null, Modifier.size(14.dp), tint = Color.White.copy(alpha = 0.8f))
                Text(" Ende-zu-Ende-verschlüsselt · 24 h", color = Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                Text("${text.length}/500", color = Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(end = 12.dp))
                FilledIconButton({
                    busy = true
                    scope.launch {
                        try { repo.postStatusText(text, bg); haptics.confirm(); onClose() }
                        catch (e: kotlinx.coroutines.CancellationException) { throw e }
                        catch (e: Exception) { haptics.reject(); repo.say(e.message ?: "Fehler"); busy = false }
                    }
                }, enabled = text.isNotBlank() && !busy) { if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) else Icon(Icons.AutoMirrored.Filled.Send, "Veröffentlichen") }
            }
        }
    }
}

@Composable
private fun PhotoStatusComposer(repo: Repo, uri: Uri, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    val uploads by repo.uploads.collectAsState()
    var caption by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val preview by produceState<Bitmap?>(null, uri) {
        value = try { ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = 4 }) } } catch (e: Exception) { null }
    }
    val up = uploads.firstOrNull { it.convId == "status" }
    Dialog(onDismissRequest = { if (!busy) onClose() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            preview?.let { Image(it.asImageBitmap(), "Vorschau", Modifier.fillMaxSize(), contentScale = ContentScale.Fit) }
            IconButton({ if (up != null) repo.cancelUpload(up.id); onClose() }, Modifier.align(Alignment.TopStart).padding(8.dp)) { Icon(Icons.Filled.Close, "Abbrechen", tint = Color.White) }
            Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (up != null) LinearProgressIndicator(progress = { up.progress }, modifier = Modifier.fillMaxWidth())
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        caption, { if (it.length <= 200) caption = it }, Modifier.weight(1f), placeholder = { Text("Bildunterschrift hinzufügen …") },
                        singleLine = true, shape = RoundedCornerShape(28.dp),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedTextColor = Color.White, unfocusedTextColor = Color.White, cursorColor = Color.White,
                            focusedBorderColor = Color.White, unfocusedBorderColor = Color.White.copy(alpha = 0.5f),
                            focusedPlaceholderColor = Color.White.copy(alpha = 0.7f), unfocusedPlaceholderColor = Color.White.copy(alpha = 0.7f),
                        ),
                    )
                    FilledIconButton({
                        busy = true
                        scope.launch {
                            try { repo.postStatusPhoto(uri, caption); haptics.confirm(); onClose() }
                            catch (e: kotlinx.coroutines.CancellationException) { busy = false; throw e }
                            catch (e: Exception) { haptics.reject(); repo.say(e.message ?: "Fehler"); busy = false }
                        }
                    }, Modifier.size(52.dp), enabled = !busy) { Icon(Icons.AutoMirrored.Filled.Send, "Veröffentlichen") }
                }
            }
        }
    }
}

// ====================================================================== Betrachter
@Composable
private fun StoryViewer(repo: Repo, userIds: List<String>, start: Int, onClose: () -> Unit) {
    val statuses by repo.statuses.collectAsState()
    val decMap by repo.statusDec.collectAsState()
    val convs by repo.convs.collectAsState()
    var uIdx by remember { mutableIntStateOf(start) }
    var sIdx by remember { mutableIntStateOf(-1) }
    val uid = userIds.getOrNull(uIdx)
    val list = if (uid == null) emptyList() else statuses.filter { it.userId == uid }
    val isMine = uid == repo.myId
    LaunchedEffect(uIdx, list.size) {
        if (sIdx < 0 && list.isNotEmpty()) sIdx = if (isMine) 0 else list.indexOfFirst { !it.seen }.takeIf { it >= 0 } ?: 0
    }
    if (uid == null || list.isEmpty()) { LaunchedEffect(Unit) { onClose() }; return }
    val idx = sIdx.coerceIn(0, list.size - 1)
    val s = list[idx]

    fun next() {
        if (idx < list.size - 1) sIdx = idx + 1
        else if (uIdx < userIds.size - 1) { uIdx++; sIdx = -1 }
        else onClose()
    }
    fun prev() {
        if (idx > 0) sIdx = idx - 1
        else if (uIdx > 0) { uIdx--; sIdx = 1000 }
    }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        key(s.id) {
            StoryPage(
                repo, s, decMap[s.id]?.payload, repo.nameOf(uid).let { n -> convs.firstOrNull { it.id == uid }?.title ?: n },
                list.size, idx, isMine, onNext = ::next, onPrev = ::prev, onClose = onClose,
            )
        }
    }
}

@Composable
private fun StoryPage(
    repo: Repo, s: StatusItem, payload: org.json.JSONObject?, name: String, count: Int, index: Int, isMine: Boolean,
    onNext: () -> Unit, onPrev: () -> Unit, onClose: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    var holding by remember { mutableStateOf(false) }
    var replying by remember { mutableStateOf(false) }
    var reply by remember { mutableStateOf("") }
    var confirmDelete by remember { mutableStateOf(false) }
    var viewsDialog by remember { mutableStateOf<Repo.StatusViews?>(null) }
    val kind = payload?.optString("t")
    val body = payload?.optString("body").orEmpty()
    val duration = if (kind == "text") (3000 + body.length * 45).coerceIn(5500, 12000) else 6500
    val image by produceState<Bitmap?>(null, s.id, payload) {
        if (kind == "image" && payload != null) {
            value = try { repo.getFile(FileMeta.from(payload.getJSONObject("file"))).let { decodeSampled(it.absolutePath, 1800) } } catch (e: Exception) { null }
        }
    }
    val thumb = remember(payload) { payload?.optString("thumb")?.takeIf { it.isNotEmpty() }?.let { decodeDataUrl(it) } }
    val ready = payload != null && (kind != "image" || image != null)
    val paused = holding || replying || confirmDelete || viewsDialog != null
    val progress = remember { Animatable(0f) }

    LaunchedEffect(s.id) { if (!isMine && !s.seen) repo.markStatusSeen(s.id) }
    LaunchedEffect(ready, paused) {
        if (ready && !paused) {
            progress.animateTo(1f, tween(((1f - progress.value) * duration).toInt().coerceAtLeast(1), easing = LinearEasing))
            onNext()
        }
    }

    Box(
        Modifier.fillMaxSize().background(Color.Black)
            .pointerInput(Unit) {
                detectTapGestures(
                    onPress = { holding = true; tryAwaitRelease(); holding = false },
                    onTap = { o -> if (o.x < size.width / 3f) onPrev() else onNext() },
                )
            }
            .pointerInput(Unit) {
                var total = 0f
                detectVerticalDragGestures(onDragStart = { total = 0f }, onDragEnd = { if (total > 220f) onClose() }) { _, dy -> total += dy }
            },
    ) {
        when {
            payload == null -> CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color.White)
            kind == "text" -> Box(Modifier.fillMaxSize().background(bgBrush(payload.optInt("bg"))), contentAlignment = Alignment.Center) {
                val sz = when { body.length < 60 -> 34.sp; body.length < 160 -> 26.sp; body.length < 360 -> 21.sp; else -> 18.sp }
                Text(body, color = Color.White, fontSize = sz, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.padding(32.dp))
            }
            kind == "image" -> {
                val shown = image ?: thumb
                if (shown != null) Image(shown.asImageBitmap(), "Status-Foto", Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
                if (image == null) CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color.White)
                payload.optString("caption").takeIf { it.isNotEmpty() }?.let {
                    Text(
                        it, color = Color.White, textAlign = TextAlign.Center,
                        modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = if (isMine) 72.dp else 96.dp).background(Color(0x66000000)).padding(12.dp).fillMaxWidth(),
                    )
                }
            }
            else -> Text("Nicht unterstützter Status", color = Color.White, modifier = Modifier.align(Alignment.Center))
        }

        // Fortschrittsbalken + Kopfzeile
        Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                for (i in 0 until count) {
                    val f = when { i < index -> 1f; i == index -> progress.value; else -> 0f }
                    Box(Modifier.weight(1f).height(3.dp).clip(RoundedCornerShape(2.dp)).background(Color.White.copy(alpha = 0.35f))) {
                        Box(Modifier.fillMaxWidth(f).fillMaxSize().background(Color.White))
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Avatar(repo, s.userId, false, 0, name, 36.dp)
                Column(Modifier.weight(1f)) {
                    Text(if (isMine) "Mein Status" else name, color = Color.White, style = MaterialTheme.typography.titleMedium)
                    Text(ago(s.ts), color = Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.labelSmall)
                }
                if (isMine) IconButton({ confirmDelete = true }) { Icon(Icons.Filled.Delete, "Löschen", tint = Color.White) }
                IconButton(onClose) { Icon(Icons.Filled.Close, "Schließen", tint = Color.White) }
            }
        }

        // Fußzeile: Antworten bzw. Aufrufe
        if (isMine) {
            TextButton(
                {
                    scope.launch { try { viewsDialog = repo.statusViews(s.id) } catch (e: Exception) { repo.say(e.message ?: "Fehler") } }
                },
                Modifier.align(Alignment.BottomCenter).padding(12.dp),
            ) {
                Icon(Icons.Filled.Visibility, null, tint = Color.White, modifier = Modifier.size(18.dp))
                Text("  ${s.views ?: 0} Aufrufe", color = Color.White)
            }
        } else if (payload != null) {
            OutlinedTextField(
                reply, { reply = it }, Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(12.dp),
                placeholder = { Text("Antworten …") }, singleLine = true, shape = RoundedCornerShape(28.dp),
                trailingIcon = {
                    if (reply.isNotBlank()) IconButton({
                        val snippet = (if (kind == "image") "Status-Foto" else "Status: $body").take(100)
                        val text = reply
                        reply = ""; replying = false
                        repo.bg { repo.sendText(s.userId, text, ReplyRef(s.id, s.userId, snippet)); haptics.confirm(); repo.say("Antwort gesendet") }
                        onNext()
                    }) { Icon(Icons.AutoMirrored.Filled.Send, "Senden", tint = Color.White) }
                },
                colors = OutlinedTextFieldDefaults.colors(
                    focusedTextColor = Color.White, unfocusedTextColor = Color.White, cursorColor = Color.White,
                    focusedBorderColor = Color.White, unfocusedBorderColor = Color.White.copy(alpha = 0.5f),
                    focusedPlaceholderColor = Color.White.copy(alpha = 0.7f), unfocusedPlaceholderColor = Color.White.copy(alpha = 0.7f),
                ),
                interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }.also { src ->
                    LaunchedEffect(src) { src.interactions.collect { i -> if (i is androidx.compose.foundation.interaction.FocusInteraction.Focus) replying = true else if (i is androidx.compose.foundation.interaction.FocusInteraction.Unfocus) replying = false } }
                },
            )
        }
    }

    if (confirmDelete) AlertDialog(
        onDismissRequest = { confirmDelete = false }, title = { Text("Status löschen?") },
        text = { Text("Dieses Update wird für alle Kontakte entfernt.") },
        confirmButton = { TextButton({ confirmDelete = false; repo.bg { repo.deleteStatus(s.id) } }) { Text("Löschen", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton({ confirmDelete = false }) { Text("Abbrechen") } },
    )
    viewsDialog?.let { v ->
        AlertDialog(
            onDismissRequest = { viewsDialog = null }, title = { Text("${v.total} Aufrufe") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (v.viewers.isEmpty()) Text("Niemand mit aktivierten Lesebestätigungen hat diesen Status gesehen.")
                    for ((n, t) in v.viewers) Row { Text(n, Modifier.weight(1f)); Text(ago(t), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    if (v.total > v.viewers.size) Text("Weitere haben Lesebestätigungen deaktiviert.", style = MaterialTheme.typography.bodySmall)
                }
            },
            confirmButton = { TextButton({ viewsDialog = null }) { Text("Schließen") } },
        )
    }
}
