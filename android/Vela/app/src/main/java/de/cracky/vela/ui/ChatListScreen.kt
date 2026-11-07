@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)

package de.cracky.vela.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import de.cracky.vela.data.Conv
import de.cracky.vela.data.Dec
import de.cracky.vela.data.Repo
import kotlinx.coroutines.launch

@Composable
fun ChatListScreen(repo: Repo, onSettings: () -> Unit) {
    val convs by repo.convs.collectAsState()
    val dec by repo.dec.collectAsState()
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    var tab by remember { mutableStateOf(0) }
    var query by remember { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var addContact by remember { mutableStateOf(false) }
    var newGroup by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val fabExpanded by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 } }
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()

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
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            LargeTopAppBar(
                title = { Text("Vela", fontWeight = FontWeight.Bold) },
                actions = {
                    IconButton({ haptics.light(); searching = !searching; if (!searching) query = "" }) {
                        Icon(if (searching) Icons.Default.Close else Icons.Default.Search, "Suchen")
                    }
                    IconButton({ menu = true }) { Icon(Icons.Default.MoreVert, "Menü") }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem({ Text("Neue Gruppe") }, { menu = false; newGroup = true })
                        DropdownMenuItem({ Text("Kontakt hinzufügen") }, { menu = false; addContact = true })
                        DropdownMenuItem({ Text("Einstellungen") }, { menu = false; onSettings() })
                    }
                },
                colors = TopAppBarDefaults.largeTopAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                    scrolledContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                ),
                scrollBehavior = scrollBehavior,
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { haptics.light(); addContact = true },
                expanded = fabExpanded,
                icon = { Icon(Icons.Default.Add, "Kontakt hinzufügen") },
                text = { Text("Kontakt") },
                shape = RoundedCornerShape(20.dp),
                containerColor = MaterialTheme.colorScheme.primaryContainer,
                contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                tabs.forEachIndexed { i, t ->
                    FilterChip(
                        selected = tab == i, onClick = { if (tab != i) haptics.tick(); tab = i }, label = { Text(t) },
                        shape = RoundedCornerShape(50),
                        trailingIcon = if (counts[i] > 0) ({ Badge { Text(counts[i].toString()) } }) else null,
                    )
                }
            }
            AnimatedVisibility(searching, enter = expandVertically(spring(stiffness = 500f)) + fadeIn(), exit = shrinkVertically() + fadeOut()) {
                OutlinedTextField(
                    query, { query = it }, singleLine = true, placeholder = { Text("Chats durchsuchen") },
                    shape = RoundedCornerShape(28.dp), modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                )
            }
            if (shown.isEmpty()) {
                Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                    Icon(Icons.Default.ChatBubbleOutline, null, Modifier.size(56.dp), tint = MaterialTheme.colorScheme.outline)
                    Text(
                        when { query.isNotBlank() -> "Keine Treffer"; tab == 3 -> "Keine offenen Anfragen"; tab == 2 -> "Archiv ist leer"; else -> "Noch keine Chats – füge einen Kontakt hinzu" },
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp),
                    )
                }
            } else {
                LazyColumn(Modifier.fillMaxSize(), state = listState) {
                    items(shown, key = { it.id }) { c ->
                        Column(Modifier.animateItem()) {
                            if (c.status == "accepted") ConvRow(repo, c, dec) else RequestRow(repo, c)
                            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f), modifier = Modifier.padding(start = 80.dp))
                        }
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
                        try { repo.addContact(name); haptics.confirm(); addContact = false; repo.say("Anfrage gesendet – wartet auf Annahme"); tab = 3 }
                        catch (e: Exception) { haptics.reject(); err = e.message }
                    }
                }, enabled = name.isNotBlank()) { Text("Anfrage senden") }
            },
            dismissButton = { TextButton({ addContact = false }) { Text("Abbrechen") } },
        )
    }
    if (newGroup) NewGroupDialog(repo, accepted.filter { !it.isGroup }) { newGroup = false }
}

@Composable
private fun ConvRow(repo: Repo, c: Conv, dec: Map<String, Dec>) {
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    var menu by remember { mutableStateOf(false) }
    val typing by repo.typing.collectAsState()
    val isTyping = (typing[c.id]?.filterValues { it > System.currentTimeMillis() }?.isNotEmpty()) == true
    Box {
        Row(
            Modifier.fillMaxWidth()
                .combinedClickable(onClick = { haptics.light(); repo.openChat(c.id) }, onLongClick = { haptics.longPress(); menu = true })
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Box {
                Avatar(repo, c.id, c.isGroup, c.avatarVersion, c.title, 52.dp)
                androidx.compose.animation.AnimatedVisibility(
                    visible = !c.isGroup && c.online, modifier = Modifier.align(Alignment.BottomEnd),
                    enter = scaleIn(spring(dampingRatio = Spring.DampingRatioMediumBouncy)), exit = scaleOut(),
                ) {
                    Box(Modifier.size(14.dp).background(MaterialTheme.colorScheme.background, CircleShape).padding(2.dp).background(MaterialTheme.colorScheme.tertiary, CircleShape))
                }
            }
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        c.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                        fontWeight = if (c.unread > 0) FontWeight.Bold else FontWeight.SemiBold,
                    )
                    c.last?.let {
                        Text(
                            fmtListTime(it.ts), style = MaterialTheme.typography.labelSmall,
                            color = if (c.unread > 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (isTyping) "schreibt …" else (if (c.keyChanged) "Sicherheitsschlüssel geändert" else listPreview(c, dec, repo)),
                        style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        color = when {
                            isTyping -> MaterialTheme.colorScheme.primary
                            c.keyChanged -> MaterialTheme.colorScheme.error
                            else -> MaterialTheme.colorScheme.onSurfaceVariant
                        },
                        modifier = Modifier.weight(1f),
                    )
                    if (c.pinned) Icon(Icons.Filled.PushPin, "Angeheftet", Modifier.padding(start = 4.dp).size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (c.muted) Icon(Icons.Filled.NotificationsOff, "Stumm", Modifier.padding(start = 4.dp).size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    AnimatedVisibility(
                        visible = c.unread > 0,
                        enter = scaleIn(spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMedium)) + fadeIn(),
                        exit = scaleOut() + fadeOut(),
                    ) {
                        Box(
                            Modifier.padding(start = 8.dp).background(MaterialTheme.colorScheme.primary, RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 2.dp),
                            contentAlignment = Alignment.Center,
                        ) { Text(c.unread.toString(), color = MaterialTheme.colorScheme.onPrimary, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold) }
                    }
                }
            }
        }
        DropdownMenu(menu, { menu = false }) {
            DropdownMenuItem({ Text(if (c.pinned) "Lösen" else "Anheften") }, { menu = false; haptics.tick(); scope.launch { runCatching { repo.patchConvFlags(c, pinned = !c.pinned) } } })
            DropdownMenuItem({ Text(if (c.muted) "Stumm aufheben" else "Stummschalten") }, { menu = false; haptics.tick(); scope.launch { runCatching { repo.patchConvFlags(c, muted = !c.muted) } } })
            DropdownMenuItem({ Text(if (c.archived) "Aus Archiv holen" else "Archivieren") }, { menu = false; haptics.tick(); scope.launch { runCatching { repo.patchConvFlags(c, archived = !c.archived) } } })
        }
    }
}

@Composable
private fun RequestRow(repo: Repo, c: Conv) {
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    val incoming = c.status == "pending_in"
    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Avatar(repo, c.id, false, 0, c.title, 52.dp)
        Column(Modifier.weight(1f)) {
            Text(c.title, style = MaterialTheme.typography.titleMedium)
            Text(if (incoming) "möchte sich mit dir verbinden" else "Anfrage gesendet – wartet auf Annahme", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (incoming) TextButton({ haptics.confirm(); scope.launch { runCatching { repo.acceptContact(c.id) } } }) { Text("Annehmen") }
        TextButton({ haptics.tick(); scope.launch { runCatching { repo.removeContact(c.id) } } }) { Text(if (incoming) "Ablehnen" else "Zurückziehen") }
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
