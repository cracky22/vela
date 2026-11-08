package de.cracky.vela.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import de.cracky.vela.data.Repo
import kotlinx.coroutines.delay

/** Aktionen, die im Nachrichtenmenü angeboten werden (null = nicht verfügbar). */
class MenuActions(
    val onReact: (String) -> Unit,
    val onReply: () -> Unit,
    val onCopy: (() -> Unit)?,
    val onEdit: (() -> Unit)?,
    val onSave: (() -> Unit)?,
    val onShare: (() -> Unit)?,
    val onDelete: (() -> Unit)?,
)

/**
 * Nachrichtenmenü wie bei WhatsApp/Signal: abgedunkelter Hintergrund, darüber eine Reaktionsleiste (Daumen, Herz, … und „+“
 * für beliebige Emojis), die Nachricht selbst und darunter die Aktionen.
 */
@Composable
fun MessageActionOverlay(
    repo: Repo, mine: Boolean, myReaction: String?, actions: MenuActions, onDismiss: () -> Unit,
    bubble: @Composable () -> Unit,
) {
    val haptics = rememberHaptics()
    val appear = remember { Animatable(0f) }
    var picker by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { appear.animateTo(1f, spring(dampingRatio = 0.75f, stiffness = 420f)) }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(
            Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.6f * appear.value))
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { onDismiss() },
        ) {
            Column(
                Modifier.align(Alignment.Center).fillMaxWidth().padding(horizontal = 14.dp)
                    .graphicsLayer { val s = 0.94f + 0.06f * appear.value; scaleX = s; scaleY = s; alpha = appear.value.coerceIn(0f, 1f) },
                horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
            ) {
                ReactionBar(myReaction, onPick = { e -> haptics.confirm(); actions.onReact(e); onDismiss() }, onMore = { haptics.light(); picker = true })
                Box(Modifier.padding(vertical = 10.dp).clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { }) { bubble() }
                Surface(
                    Modifier.widthIn(min = 230.dp, max = 280.dp), shape = RoundedCornerShape(24.dp),
                    color = MaterialTheme.colorScheme.surfaceContainerHigh, contentColor = MaterialTheme.colorScheme.onSurface,
                    shadowElevation = 8.dp,
                ) {
                    Column(Modifier.padding(vertical = 6.dp)) {
                        ActionRow(Icons.AutoMirrored.Filled.Reply, "Antworten") { haptics.light(); onDismiss(); actions.onReply() }
                        actions.onCopy?.let { f -> ActionRow(Icons.Filled.ContentCopy, "Text kopieren") { haptics.light(); onDismiss(); f() } }
                        actions.onEdit?.let { f -> ActionRow(Icons.Filled.Edit, "Bearbeiten") { haptics.light(); onDismiss(); f() } }
                        actions.onShare?.let { f -> ActionRow(Icons.Filled.Share, "Teilen") { haptics.light(); onDismiss(); f() } }
                        actions.onSave?.let { f -> ActionRow(Icons.Filled.Download, "Speichern …") { haptics.light(); onDismiss(); f() } }
                        actions.onDelete?.let { f -> ActionRow(Icons.Filled.Delete, "Für alle löschen", danger = true) { haptics.reject(); onDismiss(); f() } }
                    }
                }
            }
        }
    }
    if (picker) EmojiPickerDialog(repo, onPick = { e -> picker = false; haptics.confirm(); actions.onReact(e); onDismiss() }, onDismiss = { picker = false })
}

@Composable
private fun ActionRow(icon: ImageVector, label: String, danger: Boolean = false, onClick: () -> Unit) {
    val c = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 18.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Icon(icon, null, Modifier.size(22.dp), tint = c)
        Text(label, color = c, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun ReactionBar(current: String?, onPick: (String) -> Unit, onMore: () -> Unit) {
    // Die ersten fünf Schnellreaktionen; die aktuelle Reaktion wird immer angezeigt
    val quick = remember(current) {
        val base = REACTIONS.take(5).toMutableList()
        if (current != null && current.isNotEmpty() && current !in base) base[base.lastIndex] = current
        base + (REACTIONS.getOrNull(5)?.takeIf { it !in base && it != current } ?: "")
    }.filter { it.isNotEmpty() }
    Surface(shape = RoundedCornerShape(50), color = MaterialTheme.colorScheme.surfaceContainerHigh, shadowElevation = 10.dp) {
        Row(Modifier.padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            quick.forEachIndexed { i, e ->
                val pop = remember { Animatable(0f) }
                LaunchedEffect(Unit) { delay(60L + i * 40L); pop.animateTo(1f, spring(dampingRatio = 0.45f, stiffness = 520f)) }
                Box(
                    Modifier.size(46.dp).graphicsLayer { scaleX = pop.value; scaleY = pop.value }.clip(CircleShape)
                        .background(if (e == current) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
                        .clickable { onPick(e) },
                    contentAlignment = Alignment.Center,
                ) { Text(e, fontSize = 27.sp) }
            }
            Box(
                Modifier.size(40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant).clickable(onClick = onMore),
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Filled.Add, "Weitere Emojis", Modifier.size(22.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

// ---------------------------------------------------------------- Emoji-Auswahl
private val EMOJI_GROUPS: List<Pair<String, List<String>>> = listOf(
    "Smileys" to "😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 ☹️ 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖".split(" "),
    "Gesten" to "👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐 🖖 👋 🤝 🙏 ✍️ 💪 👏 🙌 👐 🤲 🤜 🤛 ✊ 👊 🫶 🫡 🫠 🤌 🤏".split(" "),
    "Herzen & Symbole" to "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 ✨ ⭐ 🌟 💫 🔥 💥 🎉 🎊 ✅ ❌ ❓ ❗ ‼️ ⚡ 💤 💢 💬 👀".split(" "),
    "Tiere & Natur" to "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🦄 🐝 🦋 🐢 🐙 🐬 🐳 🌸 🌹 🌻 🌲 🍀 🌈 ☀️ 🌙 ⛄ 🌊".split(" "),
    "Essen & Trinken" to "🍎 🍌 🍉 🍇 🍓 🍒 🍑 🍍 🥑 🍅 🌽 🥕 🍞 🧀 🍕 🍔 🍟 🌭 🌮 🍣 🍜 🍩 🍪 🎂 🍫 🍿 ☕ 🍺 🍻 🥂 🍷 🥃".split(" "),
    "Aktivitäten & Objekte" to "⚽ 🏀 🏈 🎾 🎮 🎲 🎯 🎵 🎶 🎤 🎧 📱 💻 📷 🎁 🏆 🚗 ✈️ 🚀 🏠 💡 🔑 🔒 📌 📎 ✏️ 💰 ⏰ 🔔".split(" "),
)

private fun firstGrapheme(s: String): String {
    val t = s.trim()
    if (t.isEmpty()) return ""
    val it = java.text.BreakIterator.getCharacterInstance()
    it.setText(t)
    val end = it.next()
    val g = if (end > 0) t.substring(0, end) else t
    val cp = g.codePointAt(0)
    return if (Character.isLetterOrDigit(cp) || cp < 0x80 && cp != '#'.code) "" else g
}

@Composable
fun EmojiPickerDialog(repo: Repo, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    var custom by remember { mutableStateOf("") }
    val recent = remember { repo.store.recentEmoji }
    fun pick(e: String) {
        repo.store.recentEmoji = (listOf(e) + repo.store.recentEmoji.filter { it != e }).take(24)
        onPick(e)
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { onDismiss() }, contentAlignment = Alignment.BottomCenter) {
            Surface(
                Modifier.fillMaxWidth().heightIn(max = 540.dp).clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { },
                shape = RoundedCornerShape(topStart = 32.dp, topEnd = 32.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh,
                contentColor = MaterialTheme.colorScheme.onSurface,
            ) {
                Column(Modifier.padding(top = 10.dp)) {
                    Box(Modifier.align(Alignment.CenterHorizontally).width(36.dp).size(width = 36.dp, height = 4.dp).clip(RoundedCornerShape(2.dp)).background(MaterialTheme.colorScheme.outlineVariant))
                    Row(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(
                            custom, { custom = it.take(24) }, Modifier.weight(1f), singleLine = true, shape = RoundedCornerShape(28.dp),
                            placeholder = { Text("Eigenes Emoji – mit der Tastatur eingeben") },
                        )
                        val g = firstGrapheme(custom)
                        Button({ pick(g) }, enabled = g.isNotEmpty()) { Text(if (g.isEmpty()) "OK" else g, fontSize = 20.sp) }
                    }
                    LazyVerticalGrid(GridCells.Fixed(8), Modifier.padding(horizontal = 8.dp), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 24.dp)) {
                        if (recent.isNotEmpty()) {
                            item(span = { GridItemSpan(maxLineSpan) }) { Text("Zuletzt verwendet", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(8.dp)) }
                            items(recent) { e -> EmojiCell(e) { pick(e) } }
                        }
                        for ((title, list) in EMOJI_GROUPS) {
                            item(span = { GridItemSpan(maxLineSpan) }) { Text(title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(8.dp)) }
                            items(list) { e -> EmojiCell(e) { pick(e) } }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EmojiCell(e: String, onClick: () -> Unit) {
    Box(Modifier.size(44.dp).clip(CircleShape).clickable(onClick = onClick), contentAlignment = Alignment.Center) { Text(e, fontSize = 24.sp) }
}

/** Wer hat womit reagiert – eigene Reaktion lässt sich hier entfernen. */
@Composable
fun ReactionsDialog(repo: Repo, reactions: Map<String, String>, onRemoveMine: () -> Unit, onDismiss: () -> Unit) {
    val rows = reactions.filterValues { it.isNotEmpty() }.entries.sortedByDescending { it.key == repo.myId }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Reaktionen") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                for ((uid, e) in rows) {
                    val me = uid == repo.myId
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable(enabled = me) { onRemoveMine(); onDismiss() }.padding(horizontal = 8.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        Text(e, fontSize = 26.sp)
                        Column(Modifier.weight(1f)) {
                            Text(if (me) "Du" else repo.nameOf(uid), style = MaterialTheme.typography.bodyLarge)
                            if (me) Text("Tippen zum Entfernen", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onDismiss) { Text("Schließen") } },
    )
}
