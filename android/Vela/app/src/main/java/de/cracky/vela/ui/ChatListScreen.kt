@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)

package de.cracky.vela.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import de.cracky.vela.data.Conv
import de.cracky.vela.data.Repo
import kotlinx.coroutines.launch

@Composable
fun ChatListScreen(repo: Repo, onSettings: () -> Unit) {
    val convs by repo.convs.collectAsState()
    val dec by repo.dec.collectAsState()
    val scope = rememberCoroutineScope()
    var tab by remember { mutableStateOf(0) }
    var query by remember { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var addContact by remember { mutableStateOf(false) }
    var newGroup by remember { mutableStateOf(false) }

    val accepted = convs.filter { it.status == "accepted" }
    val requests = convs.filter { it.status != "accepted" }
    val tabs = listOf("Alle", "Gruppen", "Archiv", "Anfragen")
    val counts = listOf(
        accepted.count { !it.archived && it.unread > 0 }, accepted.count { it.isGroup && !it.archived && it.unread > 0 },
        0, requests.count { it.status == "pending_in" },
    )
    val shown: List<Conv> = when (tab) {
        0 -> accepted.filter { !it.archived }
        1 -> accepted.filter { it.isGroup && !it.archived }
        2 -> accepted.filter { it.archived }
        else -> requests
    }.filter { query.isBlank() || it.title.contains(query, ignoreCase = true) }
        .sortedWith(compareByDescending<Conv> { it.pinned }.thenByDescending { it.last?.ts ?: it.since })

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    if (searching) OutlinedTextField(query, { query = it }, singleLine = true, placeholder = { Text("Chats durchsuchen") }, modifier = Modifier.fillMaxWidth())
                    else Text("Vela")
                },
                actions = {
                    IconButton({ searching = !searching; if (!searching) query = "" }) { Icon(if (searching) Icons.Default.Close else Icons.Default.Search, "Suchen") }
                    IconButton({ menu = true }) { Icon(Icons.Default.MoreVert, "Menü") }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem({ Text("Neue Gruppe") }, { menu = false; newGroup = true })
                        DropdownMenuItem({ Text("Kontakt hinzufügen") }, { menu = false; addContact = true })
                        DropdownMenuItem({ Text("Einstellungen") }, { menu = false; onSettings() })
                    }
                },
            )
        },
        floatingActionButton = { FloatingActionButton({ addContact = true }) { Icon(Icons.Default.Add, "Kontakt hinzufügen") } },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            ScrollableTabRow(tab, edgePadding = 8.dp) {
                tabs.forEachIndexed { i, t ->
                    Tab(tab == i, { tab = i }, text = { Text(if (counts[i] > 0) "$t (${counts[i]})" else t) })
                }
            }
            if (shown.isEmpty()) {
                Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Text(
                        when { query.isNotBlank() -> "Keine Treffer"; tab == 3 -> "Keine offenen Anfragen"; tab == 2 -> "Archiv ist leer"; else -> "Noch keine Chats – füge einen Kontakt hinzu" },
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                LazyColumn(Modifier.fillMaxSize()) {
                    items(shown, key = { it.id }) { c ->
                        if (c.status == "accepted") ConvRow(repo, c, dec) else RequestRow(repo, c)
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f))
                    }
                }
            }
        }
    }

    if (addContact) {
        var name by remember { mutableStateOf("") }
        var err by remember { mutableStateOf<String?>(null) }
        AlertDialog(
            onDismissRequest = { addContact = false },
            title = { Text("Kontakt hinzufügen") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Nach Annahme der Anfrage tauscht ihr eure öffentlichen Schlüssel aus.")
                    OutlinedTextField(name, { name = it }, label = { Text("Nutzername") }, singleLine = true, isError = err != null, supportingText = { err?.let { Text(it) } })
                }
            },
            confirmButton = {
                TextButton({
                    scope.launch {
                        try { repo.addContact(name); addContact = false; repo.say("Anfrage gesendet – wartet auf Annahme"); tab = 3 }
                        catch (e: Exception) { err = e.message }
                    }
                }, enabled = name.isNotBlank()) { Text("Anfrage senden") }
            },
            dismissButton = { TextButton({ addContact = false }) { Text("Abbrechen") } },
        )
    }
    if (newGroup) NewGroupDialog(repo, accepted.filter { !it.isGroup }) { newGroup = false }
}

@Composable
private fun ConvRow(repo: Repo, c: Conv, dec: Map<String, de.cracky.vela.data.Dec>) {
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    val typing by repo.typing.collectAsState()
    val isTyping = (typing[c.id]?.filterValues { it > System.currentTimeMillis() }?.isNotEmpty()) == true
    Box {
        Row(
            Modifier.fillMaxWidth().combinedClickable(onClick = { repo.openChat(c.id) }, onLongClick = { menu = true }).padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box {
                Avatar(repo, c.id, c.isGroup, c.avatarVersion, c.title)
                if (!c.isGroup && c.online) Box(Modifier.align(Alignment.BottomEnd).size(12.dp).background(MaterialTheme.colorScheme.tertiary, CircleShape))
            }
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(c.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    c.last?.let { Text(fmtListTime(it.ts), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (isTyping) "schreibt …" else (if (c.keyChanged) "⚠ Sicherheitsschlüssel geändert" else listPreview(c, dec, repo)),
                        style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        color = if (isTyping) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f),
                    )
                    if (c.pinned) Text("📌", style = MaterialTheme.typography.labelSmall)
                    if (c.muted) Text("🔕", style = MaterialTheme.typography.labelSmall)
                    if (c.unread > 0) Box(
                        Modifier.padding(start = 6.dp).background(MaterialTheme.colorScheme.primary, CircleShape).padding(horizontal = 7.dp, vertical = 2.dp),
                    ) { Text(c.unread.toString(), color = MaterialTheme.colorScheme.onPrimary, style = MaterialTheme.typography.labelSmall) }
                }
            }
        }
        DropdownMenu(menu, { menu = false }) {
            DropdownMenuItem({ Text(if (c.pinned) "Lösen" else "Anheften") }, { menu = false; scope.launch { runCatching { repo.patchConvFlags(c, pinned = !c.pinned) } } })
            DropdownMenuItem({ Text(if (c.muted) "Stumm aufheben" else "Stummschalten") }, { menu = false; scope.launch { runCatching { repo.patchConvFlags(c, muted = !c.muted) } } })
            DropdownMenuItem({ Text(if (c.archived) "Aus Archiv holen" else "Archivieren") }, { menu = false; scope.launch { runCatching { repo.patchConvFlags(c, archived = !c.archived) } } })
        }
    }
}

@Composable
private fun RequestRow(repo: Repo, c: Conv) {
    val scope = rememberCoroutineScope()
    val incoming = c.status == "pending_in"
    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Avatar(repo, c.id, false, 0, c.title)
        Column(Modifier.weight(1f)) {
            Text(c.title, style = MaterialTheme.typography.titleMedium)
            Text(if (incoming) "möchte sich mit dir verbinden" else "Anfrage gesendet – wartet auf Annahme", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (incoming) TextButton({ scope.launch { runCatching { repo.acceptContact(c.id) } } }) { Text("Annehmen") }
        TextButton({ scope.launch { runCatching { repo.removeContact(c.id) } } }) { Text(if (incoming) "Ablehnen" else "Zurückziehen") }
    }
}

@Composable
fun NewGroupDialog(repo: Repo, contacts: List<Conv>, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var desc by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    val selected = remember { mutableStateOf(setOf<String>()) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Neue Gruppe") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it.take(64) }, label = { Text("Gruppenname") }, singleLine = true)
                OutlinedTextField(desc, { desc = it.take(500) }, label = { Text("Beschreibung (optional)") })
                Text("Mitglieder (nur eigene Kontakte)", style = MaterialTheme.typography.labelLarge)
                LazyColumn(Modifier.weight(1f, fill = false)) {
                    items(contacts, key = { it.id }) { c ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(c.id in selected.value, { on -> selected.value = if (on) selected.value + c.id else selected.value - c.id })
                            Text(c.title)
                        }
                    }
                }
                if (contacts.isEmpty()) Text("Du hast noch keine angenommenen Kontakte.", style = MaterialTheme.typography.bodySmall)
                err?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton({
                scope.launch { try { repo.createGroup(name, desc, selected.value.toList()); onClose() } catch (e: Exception) { err = e.message } }
            }, enabled = name.isNotBlank()) { Text("Erstellen") }
        },
        dismissButton = { TextButton(onClose) { Text("Abbrechen") } },
    )
}
