@file:OptIn(ExperimentalMaterial3Api::class)

package de.cracky.vela.ui

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.media.MediaRecorder
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.material3.FilledIconButton
import androidx.compose.ui.graphics.graphicsLayer
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LooksOne
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import de.cracky.vela.core.randomId
import de.cracky.vela.data.Dec
import de.cracky.vela.data.FileMeta
import de.cracky.vela.data.Msg
import de.cracky.vela.data.ReplyRef
import de.cracky.vela.data.Repo
import de.cracky.vela.data.previewText
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

private class ChatView(val visible: List<Msg>, val reactions: Map<String, Map<String, String>>, val edits: Map<String, String>)

/** Wie silentMaps() im Web-Client: Reaktionen und Bearbeitungen sind stille Nachrichten. */
private fun buildView(list: List<Msg>, dec: Map<String, Dec>): ChatView {
    val reactions = HashMap<String, MutableMap<String, String>>()
    val edits = HashMap<String, String>()
    val byId = list.associateBy { it.id }
    for (m in list) {
        if (!m.silent) continue
        val p = dec[m.id]?.payload ?: continue
        when (p.optString("t")) {
            "reaction" -> reactions.getOrPut(p.optString("target")) { HashMap() }[m.from ?: ""] = p.optString("emoji")
            "edit" -> if (byId[p.optString("target")]?.from == m.from) edits[p.optString("target")] = p.optString("body")
        }
    }
    val now = System.currentTimeMillis()
    return ChatView(list.filter { !it.silent && (it.expiresAt ?: Long.MAX_VALUE) > now }, reactions, edits)
}

private class Recorder(private val ctx: Context) {
    private var rec: MediaRecorder? = null
    private var file: File? = null
    val amps = ArrayList<Float>()
    var startedAt = 0L

    fun start() {
        val f = File(ctx.cacheDir, "voice_${randomId()}.m4a")
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(ctx) else @Suppress("DEPRECATION") MediaRecorder()
        r.setAudioSource(MediaRecorder.AudioSource.MIC)
        r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        r.setAudioEncodingBitRate(64_000)
        r.setAudioSamplingRate(44_100)
        r.setOutputFile(f.absolutePath)
        r.prepare(); r.start()
        rec = r; file = f; startedAt = System.currentTimeMillis(); amps.clear()
    }

    fun sample() { rec?.let { amps.add((it.maxAmplitude / 32767f).coerceIn(0f, 1f)) } }

    /** Beendet die Aufnahme. Ergebnis: Datei, Dauer (s), Wellenform. */
    fun stop(): Triple<File, Double, List<Double>>? {
        val r = rec ?: return null
        val f = file ?: return null
        val dur = (System.currentTimeMillis() - startedAt) / 1000.0
        try { r.stop() } catch (e: Exception) { f.delete(); r.release(); rec = null; return null }
        r.release(); rec = null
        val n = 40
        val wave = (0 until n).map { i ->
            if (amps.isEmpty()) 0.3 else {
                val a = (i * amps.size / n).coerceAtMost(amps.size - 1); val b = ((i + 1) * amps.size / n).coerceIn(a + 1, amps.size)
                Math.sqrt(amps.subList(a, b).max().toDouble()).let { Math.round(it * 100) / 100.0 }
            }
        }
        return Triple(f, dur, wave)
    }

    fun cancel() { try { rec?.stop() } catch (e: Exception) { }; rec?.release(); rec = null; file?.delete() }
}

@Composable
fun ChatScreen(repo: Repo, convId: String, onBack: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val convs by repo.convs.collectAsState()
    val allMsgs by repo.messages.collectAsState()
    val dec by repo.dec.collectAsState()
    val typing by repo.typing.collectAsState()
    val live by repo.live.collectAsState()
    val uploads by repo.uploads.collectAsState()
    val more by repo.hasMore.collectAsState()
    val conv = convs.firstOrNull { it.id == convId }
    if (conv == null) { LaunchedEffect(Unit) { onBack() }; return }
    val list = allMsgs[convId].orEmpty()
    val view = remember(list, dec) { buildView(list, dec) }
    val listState = rememberLazyListState()

    var text by remember(convId) { mutableStateOf("") }
    var reply by remember(convId) { mutableStateOf<ReplyRef?>(null) }
    var editing by remember(convId) { mutableStateOf<Msg?>(null) }
    val haptics = rememberHaptics()
    val openedAt = remember(convId) { System.currentTimeMillis() }
    var attachMenu by remember { mutableStateOf(false) }
    var viewOnce by remember(convId) { mutableStateOf(false) }
    var headerMenu by remember { mutableStateOf(false) }
    var info by remember { mutableStateOf(false) }
    var ttlDialog by remember { mutableStateOf(false) }
    var overlayId by remember(convId) { mutableStateOf<String?>(null) }
    var reactionsFor by remember(convId) { mutableStateOf<String?>(null) }
    var mediaId by remember(convId) { mutableStateOf<String?>(null) }
    var recording by remember { mutableStateOf(false) }
    var recSecs by remember { mutableStateOf(0) }
    val recorder = remember { Recorder(ctx) }
    var pendingSave by remember { mutableStateOf<FileMeta?>(null) }
    var lastTypingSent by remember { mutableStateOf(0L) }

    fun fail(e: Throwable) = repo.say(e.message ?: "Fehler")

    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) { val vo = viewOnce; viewOnce = false; repo.bg { repo.sendImage(convId, uri, vo) } }
    }
    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) repo.bg { repo.sendFile(convId, uri) }
    }
    val pickVideo = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) repo.bg { repo.sendFile(convId, uri) }
    }
    fun shareMeta(meta: FileMeta) {
        repo.bg {
            val uri = repo.shareUri(meta)
            val send = android.content.Intent(android.content.Intent.ACTION_SEND).setType(meta.mime).putExtra(android.content.Intent.EXTRA_STREAM, uri)
                .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
            ctx.startActivity(android.content.Intent.createChooser(send, "Teilen").addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }
    val saveAs = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        val meta = pendingSave
        if (uri != null && meta != null) scope.launch {
            try {
                val f = repo.getFile(meta)
                ctx.contentResolver.openOutputStream(uri)!!.use { o -> f.inputStream().use { it.copyTo(o) } }
                repo.say("Gespeichert")
            } catch (e: Exception) { fail(e) }
        }
        pendingSave = null
    }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) { try { recorder.start(); recording = true } catch (e: Exception) { repo.say("Aufnahme nicht möglich") } }
    }

    LaunchedEffect(recording) {
        recSecs = 0
        while (recording) { delay(100); recorder.sample(); recSecs = ((System.currentTimeMillis() - recorder.startedAt) / 1000).toInt() }
    }
    var firstLast by remember(convId) { mutableStateOf(true) }
    LaunchedEffect(view.visible.lastOrNull()?.id) {
        val last = view.visible.lastOrNull()
        if (!firstLast && last != null && last.from != repo.myId && last.system == null) haptics.light()
        if (last != null) firstLast = false
        if (listState.firstVisibleItemIndex <= 2) listState.animateScrollToItem(0)
        repo.markRead(convId)
    }
    // Tipp-Ereignis: höchstens alle 350 ms (mit Live-Vorschau, falls aktiviert), nach 5 s Pause "stop"
    LaunchedEffect(text) {
        if (conv.status != "accepted") return@LaunchedEffect
        if (text.isBlank() || editing != null) {
            if (lastTypingSent != 0L) { lastTypingSent = 0; repo.sendTyping(convId, false) }
            return@LaunchedEffect
        }
        delay((lastTypingSent + 350 - System.currentTimeMillis()).coerceAtLeast(0))
        lastTypingSent = System.currentTimeMillis()
        repo.sendTyping(convId, true, text)
        delay(5000)
        lastTypingSent = 0
        repo.sendTyping(convId, false)
    }

    val others = typing[convId].orEmpty().filterValues { it > System.currentTimeMillis() }.keys.map { repo.nameOf(it) }
    val subtitle = when {
        others.isNotEmpty() -> if (conv.isGroup) others.joinToString(", ") + " schreibt …" else "schreibt …"
        conv.isGroup -> conv.members.joinToString(", ") { if (it.id == repo.myId) "Du" else it.username }
        conv.online -> "online"
        else -> ""
    }
    val changedUsers = if (conv.isGroup) conv.members.filter { repo.isChanged(it.id) } else if (conv.keyChanged) listOf(null) else emptyList()

    fun send() {
        val t = text.trim()
        if (t.isEmpty()) return
        val ed = editing; val rp = reply; val vo = viewOnce && ed == null
        text = ""; reply = null; editing = null; viewOnce = false
        repo.bg {
            if (ed != null) {
                val old = dec[ed.id]?.payload?.let { previewText(it) }
                if (old != null && t != old) repo.edit(convId, ed.id, t)
            } else repo.sendText(convId, t, rp, vo)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Zurück") } },
                title = {
                    Row(Modifier.clickable { info = true }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Avatar(repo, conv.id, conv.isGroup, conv.avatarVersion, conv.title, 36.dp)
                        Column {
                            Text(conv.title + if (conv.verified) " ✔" else "", maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
                            if (subtitle.isNotEmpty()) Text(subtitle, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall,
                                color = if (others.isNotEmpty()) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
                actions = {
                    IconButton({ headerMenu = true }) { Icon(Icons.Default.MoreVert, "Menü") }
                    DropdownMenu(headerMenu, { headerMenu = false }) {
                        DropdownMenuItem({ Text(if (conv.isGroup) "Gruppeninfo" else "Kontaktinfo") }, { headerMenu = false; info = true })
                        DropdownMenuItem({ Text("Verschwindende Nachrichten") }, { headerMenu = false; ttlDialog = true })
                        DropdownMenuItem({ Text(if (conv.muted) "Stumm aufheben" else "Stummschalten") }, { headerMenu = false; scope.launch { runCatching { repo.patchConvFlags(conv, muted = !conv.muted) } } })
                        DropdownMenuItem({ Text(if (conv.archived) "Aus Archiv holen" else "Archivieren") }, { headerMenu = false; scope.launch { runCatching { repo.patchConvFlags(conv, archived = !conv.archived) } } })
                    }
                },
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (changedUsers.isNotEmpty()) {
                Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.errorContainer).padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "Der Sicherheitsschlüssel von " + (if (conv.isGroup) changedUsers.joinToString { it!!.username } else conv.title) + " hat sich geändert. Bis zur Bestätigung wird nicht an diesen Schlüssel verschlüsselt.",
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onErrorContainer, modifier = Modifier.weight(1f),
                    )
                    TextButton({ scope.launch { if (conv.isGroup) changedUsers.forEach { repo.acceptNewKey(it!!.id) } else repo.acceptNewKey(conv.id) } }) { Text("Akzeptieren") }
                }
            }
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = listState, reverseLayout = true) {
                val shown = view.visible.reversed()
                val livePreview = live[convId]
                if (others.isNotEmpty() && (conv.isGroup || livePreview.isNullOrEmpty())) item(key = "typing") { TypingBubble(Modifier.animateItem()) }
                if (!conv.isGroup && !livePreview.isNullOrEmpty()) item(key = "live") {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp)) {
                        Column(
                            Modifier.widthIn(max = 300.dp).clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)).padding(horizontal = 10.dp, vertical = 6.dp),
                        ) {
                            Text("Live", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                            Text(livePreview, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                items(uploads.filter { it.convId == convId }, key = { "u" + it.id }) { u ->
                    Column(Modifier.fillMaxWidth().padding(8.dp)) {
                        IconText(Icons.Filled.Lock, "${u.label} wird verschlüsselt und gesendet …", style = MaterialTheme.typography.labelMedium)
                        LinearProgressIndicator(progress = { u.progress }, modifier = Modifier.fillMaxWidth())
                    }
                }
                items(shown, key = { it.id }) { m ->
                    if (m.system != null) Box(Modifier.animateItem()) { SystemRow(repo, m) } else {
                        val idx = shown.indexOf(m)
                        val older = shown.getOrNull(idx + 1)
                        val showSender = conv.isGroup && (older == null || older.from != m.from || older.system != null)
                        Box(Modifier.animateItem()) { MessageBubble(
                            repo, m, dec[m.id], conv, view.reactions[m.id].orEmpty(), view.edits[m.id], showSender,
                            animateIn = m.pending || m.ts >= openedAt,
                            a = BubbleActions(
                                onReply = {
                                    val p = dec[m.id]?.payload
                                    if (p != null) { editing = null; reply = ReplyRef(m.id, m.from, previewText(p).take(100)) }
                                },
                                onEdit = if (m.from == repo.myId && dec[m.id]?.payload?.optString("t") == "text" && !m.pending) ({
                                    reply = null; editing = m; text = view.edits[m.id] ?: dec[m.id]?.payload?.optString("body").orEmpty()
                                }) else null,
                                onDelete = if (m.from == repo.myId || (conv.isGroup && conv.role == "admin")) ({
                                    repo.bg { repo.deleteMessage(m) }
                                }) else null,
                                onCopy = dec[m.id]?.payload?.takeIf { it.optString("t") == "text" }?.let { p ->
                                    {
                                        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                                        cm.setPrimaryClip(ClipData.newPlainText("Vela", view.edits[m.id] ?: p.optString("body")))
                                    }
                                },
                                onReact = { e ->
                                    val cur = view.reactions[m.id]?.get(repo.myId)
                                    repo.bg { repo.react(convId, m.id, if (cur == e) "" else e) }
                                },
                                onSave = { meta -> pendingSave = meta; saveAs.launch(meta.name) },
                                onRetry = { repo.bg { repo.retry(m) } },
                                onOpenMedia = { mediaId = it },
                                onLongPress = { overlayId = m.id },
                                onShowReactions = { reactionsFor = m.id },
                                onJump = { id -> val i = shown.indexOfFirst { it.id == id }; if (i >= 0) scope.launch { listState.animateScrollToItem(i) } },
                            ),
                        ) }
                    }
                }
                if (more[convId] == true) item(key = "more") {
                    TextButton({ scope.launch { repo.loadMessages(convId, older = true) } }, Modifier.fillMaxWidth()) { Text("Ältere Nachrichten laden") }
                }
                if (allMsgs[convId] == null) item(key = "loading") {
                    LinearProgressIndicator(Modifier.fillMaxWidth().padding(16.dp))
                }
                item(key = "e2e") {
                    Text(
                        "Ende-zu-Ende-verschlüsselt. Nachrichten werden nach ${if (conv.ttl > 0) de.cracky.vela.data.ttlLabel(conv.ttl) else "30 Tagen"} vom Server gelöscht.",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.fillMaxWidth().padding(16.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    )
                }
            }

            // ---------------------------------------------------------------- Eingabe
            val barLabel = reply?.let { "Antwort an ${repo.nameOf(it.from)}: ${it.snippet}" } ?: editing?.let { "Nachricht bearbeiten" }
            AnimatedVisibility(barLabel != null, enter = expandVertically(spring(stiffness = 500f)) + fadeIn(), exit = shrinkVertically() + fadeOut()) {
                Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant).padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(barLabel.orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
                    IconButton({ haptics.light(); reply = null; if (editing != null) { editing = null; text = "" } }) { Icon(Icons.Default.Close, "Abbrechen") }
                }
            }
            if (conv.status != "accepted") {
                Text("Erst nach angenommener Kontaktanfrage möglich.", Modifier.padding(16.dp))
            } else if (recording) {
                Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    IconButton({ haptics.reject(); recorder.cancel(); recording = false }) { Icon(Icons.Filled.Delete, "Verwerfen") }
                    val pulse = rememberInfiniteTransition(label = "rec").animateFloat(
                        initialValue = 0.3f, targetValue = 1f,
                        animationSpec = infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "recPulse",
                    )
                    Icon(Icons.Filled.FiberManualRecord, null, Modifier.size(14.dp).graphicsLayer { alpha = pulse.value }, tint = MaterialTheme.colorScheme.error)
                    Text(fmtDuration(recSecs.toDouble()), color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
                    FilledIconButton({
                        haptics.confirm()
                        recording = false
                        val r = recorder.stop()
                        if (r != null && r.second >= 0.6) repo.bg { repo.sendVoice(convId, r.first, r.second, r.third) }
                        else r?.first?.delete()
                    }) { Icon(Icons.AutoMirrored.Filled.Send, "Senden") }
                }
            } else {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.Bottom) {
                    Box {
                        IconButton({ attachMenu = true }) { Icon(Icons.Filled.AttachFile, "Anhang") }
                        DropdownMenu(attachMenu, { attachMenu = false }) {
                            DropdownMenuItem({ Text(if (viewOnce) "Einmalansicht-Foto" else "Foto") }, { attachMenu = false; pickImage.launch("image/*") },
                                leadingIcon = { Icon(Icons.Filled.Image, null) })
                            DropdownMenuItem({ Text("Video") }, { attachMenu = false; pickVideo.launch("video/*") },
                                leadingIcon = { Icon(Icons.Filled.Videocam, null) })
                            DropdownMenuItem({ Text("Datei") }, { attachMenu = false; pickFile.launch("*/*") },
                                leadingIcon = { Icon(Icons.Filled.InsertDriveFile, null) })
                        }
                    }
                    if (!conv.isGroup) IconButton({ viewOnce = !viewOnce; haptics.toggle(viewOnce) }) {
                        Icon(
                            Icons.Filled.LooksOne, "Einmalansicht",
                            tint = if (viewOnce) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    OutlinedTextField(
                        text, { if (it.length <= 20000) text = it }, Modifier.weight(1f),
                        placeholder = { Text(if (editing != null) "Nachricht bearbeiten" else if (viewOnce) "Einmalansicht-Nachricht" else "Nachricht") }, maxLines = 6,
                        shape = RoundedCornerShape(28.dp),
                    )
                    AnimatedContent(
                        targetState = text.isBlank(),
                        transitionSpec = { (scaleIn(spring(dampingRatio = 0.55f, stiffness = 500f)) + fadeIn()) togetherWith (scaleOut() + fadeOut()) },
                        label = "sendMic",
                    ) { blank ->
                        if (blank) IconButton({
                            haptics.light()
                            if (androidx.core.content.ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                                try { recorder.start(); recording = true; haptics.confirm() } catch (e: Exception) { repo.say("Aufnahme nicht möglich") }
                            } else micPermission.launch(Manifest.permission.RECORD_AUDIO)
                        }) { Icon(Icons.Filled.Mic, "Sprachnachricht aufnehmen") }
                        else FilledIconButton({ haptics.confirm(); send() }, Modifier.size(48.dp)) { Icon(Icons.AutoMirrored.Filled.Send, "Senden") }
                    }
                }
            }
        }
    }

    // ---- Nachrichtenmenü (Tapback): langes Drücken -> Reaktionsleiste, Nachricht, Aktionen
    val overlayMsg = overlayId?.let { id -> view.visible.firstOrNull { it.id == id } }
    if (overlayMsg != null) {
        val om = overlayMsg
        val p = dec[om.id]?.payload
        val mineMsg = om.from == repo.myId
        val myReaction = view.reactions[om.id]?.get(repo.myId)
        val fm = p?.optJSONObject("file")?.let { FileMeta.from(it) }
        val actions = MenuActions(
            onReact = { e -> repo.bg { repo.react(convId, om.id, if (myReaction == e) "" else e) } },
            onReply = { if (p != null) { editing = null; reply = ReplyRef(om.id, om.from, previewText(p).take(100)) } },
            onCopy = p?.takeIf { it.optString("t") == "text" }?.let { tp ->
                {
                    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("Vela", view.edits[om.id] ?: tp.optString("body")))
                    repo.say("Text kopiert")
                }
            },
            onEdit = if (mineMsg && p?.optString("t") == "text" && !om.pending) ({
                reply = null; editing = om; text = view.edits[om.id] ?: p?.optString("body").orEmpty()
            }) else null,
            onSave = fm?.let { f -> { pendingSave = f; saveAs.launch(f.name) } },
            onShare = fm?.let { f -> { shareMeta(f) } },
            onDelete = if (mineMsg || (conv.isGroup && conv.role == "admin")) ({ repo.bg { repo.deleteMessage(om) } }) else null,
        )
        MessageActionOverlay(repo, mineMsg, myReaction, actions, onDismiss = { overlayId = null }) {
            MessageBubble(
                repo, om, dec[om.id], conv, view.reactions[om.id].orEmpty(), view.edits[om.id], conv.isGroup,
                BubbleActions({}, null, null, null, {}, {}, {}, {}, {}, {}, {}),
            )
        }
    }
    reactionsFor?.let { id ->
        val r = view.reactions[id].orEmpty()
        ReactionsDialog(repo, r, onRemoveMine = { repo.bg { repo.react(convId, id, "") } }, onDismiss = { reactionsFor = null })
    }
    // ---- Medien-Viewer (Fotos und Videos des Chats, wischen, zoomen)
    mediaId?.let { id ->
        val items = collectMedia(view.visible, dec)
        MediaViewer(
            repo, items, items.indexOfFirst { it.msgId == id }.coerceAtLeast(0),
            onSave = { meta -> pendingSave = meta; saveAs.launch(meta.name) },
            onShare = { meta -> shareMeta(meta) },
            onClose = { mediaId = null },
        )
    }
    if (ttlDialog) {
        AlertDialog(
            onDismissRequest = { ttlDialog = false }, title = { Text("Verschwindende Nachrichten") },
            text = {
                Column {
                    for ((sec, label) in de.cracky.vela.data.TTL_CHOICES) {
                        Row(Modifier.fillMaxWidth().clickable {
                            ttlDialog = false
                            scope.launch { try { repo.setTtl(conv, sec) } catch (e: Exception) { fail(e) } }
                        }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            androidx.compose.material3.RadioButton(conv.ttl == sec, null)
                            Text(label, Modifier.padding(start = 12.dp))
                        }
                    }
                }
            },
            confirmButton = { TextButton({ ttlDialog = false }) { Text("Schließen") } },
        )
    }
    if (info) { if (conv.isGroup) GroupInfoDialog(repo, conv) { info = false } else ContactInfoDialog(repo, conv) { info = false } }
}

/** Drei federnde Punkte: „jemand schreibt“. */
@Composable
private fun TypingBubble(modifier: Modifier = Modifier) {
    val t = rememberInfiniteTransition(label = "typing")
    Row(modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp)) {
        Row(
            Modifier.clip(RoundedCornerShape(22.dp, 22.dp, 22.dp, 6.dp)).background(MaterialTheme.colorScheme.surfaceVariant).padding(horizontal = 16.dp, vertical = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            for (i in 0 until 3) {
                val y = t.animateFloat(
                    initialValue = 0f, targetValue = -6f,
                    animationSpec = infiniteRepeatable(tween(420, delayMillis = i * 140), RepeatMode.Reverse), label = "dot$i",
                )
                Box(Modifier.size(8.dp).graphicsLayer { translationY = y.value }.background(MaterialTheme.colorScheme.onSurfaceVariant, androidx.compose.foundation.shape.CircleShape))
            }
        }
    }
}
