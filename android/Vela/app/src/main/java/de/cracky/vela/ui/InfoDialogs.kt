@file:OptIn(ExperimentalMaterial3Api::class)

package de.cracky.vela.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import de.cracky.vela.core.Crypto
import de.cracky.vela.data.Conv
import de.cracky.vela.data.Repo
import kotlinx.coroutines.launch

@Composable
fun SafetyNumberDialog(repo: Repo, c: Conv, onClose: () -> Unit) {
    val mine = repo.myKeys()
    val theirs = repo.userKeys(c.id)
    if (mine == null || theirs == null) { onClose(); return }
    val digits = remember(c.id) { Crypto.safetyNumber(mine, theirs) }
    val pin = repo.pinOf(c.id)
    var verified by remember { mutableStateOf(pin?.verified == true) }
    AlertDialog(
        onDismissRequest = onClose, title = { Text("Sicherheitsnummer") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Vergleiche diese Nummer mit ${c.title} – am besten persönlich oder per Videoanruf. Stimmt sie überein, hat niemand (auch nicht der Server) eure Schlüssel ausgetauscht.")
                digits.chunked(3).forEach { Text(it.joinToString("   "), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.titleMedium) }
                Text("Dein Fingerabdruck:", style = MaterialTheme.typography.labelMedium)
                Text(Crypto.shortFingerprint(mine.encPub, mine.sigPub), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                Text("Fingerabdruck von ${c.title}:", style = MaterialTheme.typography.labelMedium)
                Text(Crypto.shortFingerprint(theirs.encPub, theirs.sigPub), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                Text("RSA-OAEP ${pin?.bits ?: c.keyBits} Bit · ECDSA P-256 · AES-256-GCM", style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = { TextButton({ verified = !verified; repo.setVerified(c.id, verified) }) { Text(if (verified) "Verifizierung aufheben" else "Als verifiziert markieren") } },
        dismissButton = { TextButton(onClose) { Text("Schließen") } },
    )
}

@Composable
fun ContactInfoDialog(repo: Repo, c: Conv, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var safety by remember { mutableStateOf(false) }
    var confirmRemove by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) { Avatar(repo, c.id, false, c.avatarVersion, c.title, 56.dp); Text(c.title) } },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (c.online) Text("online", color = MaterialTheme.colorScheme.tertiary)
                Text(c.about.ifBlank { "Keine Info hinterlegt" }, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text((if (c.verified) "✔ Verifiziert" else "🔒 Ende-zu-Ende-verschlüsselt") + " · RSA ${c.keyBits}")
                if (c.ttl > 0) Text("⏱ Verschwindende Nachrichten: ${de.cracky.vela.data.ttlLabel(c.ttl)}")
                OutlinedButton({ safety = true }, Modifier.fillMaxWidth()) { Text("Sicherheitsnummer") }
                TextButton({ confirmRemove = true }) { Text("Kontakt entfernen", color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = { TextButton(onClose) { Text("Schließen") } },
    )
    if (safety) SafetyNumberDialog(repo, c) { safety = false }
    if (confirmRemove) AlertDialog(
        onDismissRequest = { confirmRemove = false }, title = { Text("Kontakt entfernen?") },
        text = { Text("Der gemeinsame Chatverlauf und alle Dateien werden auf dem Server gelöscht.") },
        confirmButton = { TextButton({ scope.launch { runCatching { repo.removeContact(c.id) }; onClose() } }) { Text("Entfernen", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton({ confirmRemove = false }) { Text("Abbrechen") } },
    )
}

@Composable
fun GroupInfoDialog(repo: Repo, g: Conv, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val convs by repo.convs.collectAsState()
    val isAdmin = g.role == "admin"
    val canEdit = isAdmin || !g.onlyAdmins
    var name by remember(g.title) { mutableStateOf(g.title) }
    var desc by remember(g.about) { mutableStateOf(g.about) }
    var adding by remember { mutableStateOf(false) }
    var confirmLeave by remember { mutableStateOf(false) }
    var memberMenu by remember { mutableStateOf<String?>(null) }
    val candidates = convs.filter { !it.isGroup && it.status == "accepted" && g.members.none { m -> m.id == it.id } }

    Dialog(onClose, DialogProperties(usePlatformDefaultWidth = false)) {
        androidx.compose.material3.Surface(Modifier.fillMaxSize()) {
            Scaffold(topBar = {
                TopAppBar(title = { Text("Gruppeninfo") }, navigationIcon = { IconButton(onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Zurück") } })
            }) { pad ->
                LazyColumn(Modifier.padding(pad).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    item {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) { Avatar(repo, g.id, true, g.avatarVersion, g.title, 96.dp) }
                        OutlinedTextField(name, { name = it.take(64) }, label = { Text("Name") }, enabled = canEdit, singleLine = true, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(desc, { desc = it.take(500) }, label = { Text("Beschreibung") }, enabled = canEdit, modifier = Modifier.fillMaxWidth())
                        if (canEdit && (name != g.title || desc != g.about) && name.isNotBlank()) {
                            Button({ scope.launch { try { repo.patchGroup(g.id, name, desc) } catch (e: Exception) { repo.say(e.message ?: "Fehler") } } }, Modifier.fillMaxWidth()) { Text("Speichern") }
                        }
                        if (isAdmin) Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Nur Admins dürfen die Gruppeninfo ändern", Modifier.weight(1f))
                            Switch(g.onlyAdmins, { v -> scope.launch { runCatching { repo.patchGroup(g.id, onlyAdmins = v) } } })
                        }
                        Text("${g.members.size} Mitglieder", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp))
                        if (isAdmin && candidates.isNotEmpty()) OutlinedButton({ adding = true }, Modifier.fillMaxWidth()) { Text("Mitglieder hinzufügen") }
                    }
                    items(g.members, key = { it.id }) { m ->
                        Row(
                            Modifier.fillMaxWidth().clickable(enabled = isAdmin && m.id != repo.myId) { memberMenu = m.id }.padding(vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Avatar(repo, m.id, false, m.avatarVersion, m.username, 40.dp)
                            Column(Modifier.weight(1f)) {
                                Text(if (m.id == repo.myId) "Du" else m.username)
                                if (repo.isChanged(m.id)) Text("⚠ Schlüssel geändert", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                            }
                            if (m.role == "admin") Text("Admin", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                            DropdownMenu(memberMenu == m.id, { memberMenu = null }) {
                                DropdownMenuItem({ Text(if (m.role == "admin") "Admin entziehen" else "Zum Admin machen") }, {
                                    memberMenu = null; scope.launch { runCatching { repo.setRole(g.id, m.id, m.role != "admin") } }
                                })
                                DropdownMenuItem({ Text("Aus Gruppe entfernen") }, { memberMenu = null; scope.launch { runCatching { repo.removeMember(g.id, m.id) } } })
                            }
                        }
                        HorizontalDivider()
                    }
                    item { TextButton({ confirmLeave = true }) { Text("Gruppe verlassen", color = MaterialTheme.colorScheme.error) } }
                }
            }
        }
    }
    if (adding) {
        val sel = remember { mutableStateOf(setOf<String>()) }
        AlertDialog(
            onDismissRequest = { adding = false }, title = { Text("Mitglieder hinzufügen") },
            text = {
                LazyColumn { items(candidates, key = { it.id }) { c ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(c.id in sel.value, { on -> sel.value = if (on) sel.value + c.id else sel.value - c.id }); Text(c.title)
                    }
                } }
            },
            confirmButton = { TextButton({ scope.launch { runCatching { repo.addMembers(g.id, sel.value.toList()) }; adding = false } }, enabled = sel.value.isNotEmpty()) { Text("Hinzufügen") } },
            dismissButton = { TextButton({ adding = false }) { Text("Abbrechen") } },
        )
    }
    if (confirmLeave) AlertDialog(
        onDismissRequest = { confirmLeave = false }, title = { Text("Gruppe verlassen?") },
        confirmButton = { TextButton({ scope.launch { runCatching { repo.leaveGroup(g.id) }; onClose() } }) { Text("Verlassen", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton({ confirmLeave = false }) { Text("Abbrechen") } },
    )
}
