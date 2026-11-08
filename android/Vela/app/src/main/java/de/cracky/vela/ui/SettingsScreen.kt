@file:OptIn(ExperimentalMaterial3Api::class)

package de.cracky.vela.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
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
import de.cracky.vela.core.Crypto
import de.cracky.vela.data.Repo
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(repo: Repo, onBack: () -> Unit) {
    val me by repo.me.collectAsState()
    val scope = rememberCoroutineScope()
    val m = me ?: return
    var about by remember(m.about) { mutableStateOf(m.about) }
    var bg by remember { mutableStateOf(repo.store.background) }
    var notif by remember { mutableStateOf(repo.store.notifications) }
    var confirmWipe by remember { mutableStateOf(false) }
    val pickAvatar = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) repo.bg { repo.setAvatar(uri); repo.say("Profilbild aktualisiert") }
    }
    var keepHistory by remember { mutableStateOf(repo.store.keepHistory) }
    var keepMedia by remember { mutableStateOf(repo.store.keepMedia) }
    val sync by repo.sync.collectAsState()
    var localCount by remember { mutableStateOf(0) }
    var confirmClear by remember { mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(sync == null, keepHistory) { localCount = repo.localCount() }
    var hapticsOn by remember { mutableStateOf(repo.store.haptics) }
    var trEnabled by remember { mutableStateOf(repo.store.transcribeEnabled) }
    var trEngine by remember { mutableStateOf(repo.store.transcribeEngine) }
    var trUrl by remember { mutableStateOf(repo.store.whisperUrl) }
    var trKey by remember { mutableStateOf(repo.store.whisperKey) }
    var trModel by remember { mutableStateOf(repo.store.whisperModel) }
    var trLang by remember { mutableStateOf(repo.store.transcribeLang) }
    val s = m.settings
    fun save(n: de.cracky.vela.data.Settings) = scope.launch { try { repo.saveSettings(n) } catch (e: Exception) { repo.say(e.message ?: "Fehler") } }

    Scaffold(topBar = { TopAppBar(title = { Text("Einstellungen") }, navigationIcon = { IconButton(onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Zurück") } }) }) { pad ->
        Column(Modifier.padding(pad).padding(horizontal = 16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.clickable { pickAvatar.launch("image/*") }) {
                    Avatar(repo, m.id, false, m.avatarVersion, m.username, 72.dp)
                    Icon(
                        Icons.Filled.PhotoCamera, "Profilbild ändern",
                        Modifier.align(Alignment.BottomEnd).size(26.dp).background(MaterialTheme.colorScheme.primary, CircleShape).padding(5.dp),
                        tint = MaterialTheme.colorScheme.onPrimary,
                    )
                }
                Column { Text(m.username, style = MaterialTheme.typography.titleLarge); Text(m.email, style = MaterialTheme.typography.bodySmall) }
            }
            Row {
                TextButton({ pickAvatar.launch("image/*") }) { Text("Profilbild ändern") }
                if (m.avatarVersion > 0) TextButton({ repo.bg { repo.removeAvatar(); repo.say("Profilbild entfernt") } }) { Text("Entfernen") }
            }
            Text(
                "Profilbilder sind nicht Ende-zu-Ende-verschlüsselt und werden nur an angenommene Kontakte und Gruppenmitglieder ausgeliefert.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(about, { about = it.take(140) }, label = { Text("Info (öffentlich für Kontakte)") }, modifier = Modifier.fillMaxWidth())
            if (about != m.about) Button({ scope.launch { try { repo.saveAbout(about) } catch (e: Exception) { repo.say(e.message ?: "Fehler") } } }) { Text("Info speichern") }
            HorizontalDivider()
            Text("Privatsphäre", style = MaterialTheme.typography.titleMedium)
            SwitchRow("Lesebestätigungen senden", s.readReceipts) { save(s.copy(readReceipts = it)) }
            SwitchRow("Tipp-Anzeige („schreibt …“)", s.typingIndicator) { save(s.copy(typingIndicator = it)) }
            SwitchRow("Live-Typing (Gegenüber sieht deinen Text beim Tippen)", s.liveTyping) { save(s.copy(liveTyping = it)) }
            Text(
                "Die Live-Vorschau ist Ende-zu-Ende-verschlüsselt und wird nur in Einzelchats gesendet (nur die letzten 280 Zeichen). Setzt „Tipp-Anzeige“ voraus.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            SwitchRow("Online-Status zeigen", s.showOnline) { save(s.copy(showOnline = it)) }
            HorizontalDivider()
            Text("Verlauf auf diesem Gerät", style = MaterialTheme.typography.titleMedium)
            SwitchRow("Nachrichten lokal speichern", keepHistory) { keepHistory = it; repo.store.keepHistory = it; if (it) repo.persistAllLoaded() }
            Text(
                "Entschlüsselte Nachrichten werden verschlüsselt (Android-Keystore) in der App gespeichert. Sie bleiben auch nach der Aufbewahrungsfrist des Servers lesbar und sind offline verfügbar.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            SwitchRow("Anhänge mitspeichern (Fotos, Videos, Dateien)", keepMedia) { keepMedia = it; repo.store.keepMedia = it }
            val st = sync
            if (st != null) {
                Text(st.text, style = MaterialTheme.typography.bodyMedium)
                androidx.compose.material3.LinearProgressIndicator(progress = { st.progress }, modifier = Modifier.fillMaxWidth())
            } else {
                Button({ keepHistory = true; repo.bg { repo.syncHistory(keepMedia) } }, Modifier.fillMaxWidth()) { Text("Alle Nachrichten jetzt laden") }
            }
            Text("$localCount Nachrichten lokal gespeichert", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton({ confirmClear = true }) { Text("Lokalen Verlauf löschen", color = MaterialTheme.colorScheme.error) }
            HorizontalDivider()
            Text("Bedienung", style = MaterialTheme.typography.titleMedium)
            SwitchRow("Haptisches Feedback (Vibrationen)", hapticsOn) { hapticsOn = it; repo.store.haptics = it }
            HorizontalDivider()
            Text("Benachrichtigungen", style = MaterialTheme.typography.titleMedium)
            SwitchRow("Benachrichtigungen anzeigen", notif) { notif = it; repo.store.notifications = it }
            SwitchRow("Im Hintergrund verbunden bleiben", bg) { bg = it; repo.setBackground(it) }
            Text(
                "Vela nutzt keine Google-Dienste. Solange die App geöffnet ist, gibt es keine Dienst-Benachrichtigung. Im Hintergrund hält ein Dienst die Verbindung offen – Android verlangt dafür eine Benachrichtigung; sie ist stumm, ohne Symbol in der Statusleiste und auf dem Sperrbildschirm unsichtbar.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            HorizontalDivider()
            Text("Transkription von Sprachnachrichten", style = MaterialTheme.typography.titleMedium)
            SwitchRow("Transkription aktivieren", trEnabled) { trEnabled = it; repo.store.transcribeEnabled = it }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { trEngine = "device"; repo.store.transcribeEngine = "device" }) {
                androidx.compose.material3.RadioButton(trEngine == "device", null)
                Column(Modifier.padding(start = 12.dp)) {
                    Text("Auf dem Gerät (Offline-Spracherkennung)")
                    Text("Ab Android 13. Das Audio verlässt das Gerät nicht.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { trEngine = "server"; repo.store.transcribeEngine = "server" }) {
                androidx.compose.material3.RadioButton(trEngine == "server", null)
                Column(Modifier.padding(start = 12.dp)) {
                    Text("Eigener Whisper-Server")
                    Text("OpenAI-kompatible Schnittstelle (/v1/audio/transcriptions). Das Audio geht an diesen Server.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (trEngine == "server") {
                OutlinedTextField(trUrl, { trUrl = it; repo.store.whisperUrl = it }, label = { Text("Server-Adresse, z. B. https://…/v1") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(trKey, { trKey = it; repo.store.whisperKey = it }, label = { Text("API-Schlüssel (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation())
                OutlinedTextField(trModel, { trModel = it; repo.store.whisperModel = it }, label = { Text("Modell (Standard: whisper-1)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            }
            OutlinedTextField(trLang, { trLang = it; repo.store.transcribeLang = it }, label = { Text("Sprache (z. B. de, leer = automatisch)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            HorizontalDivider()
            Text("Schlüssel", style = MaterialTheme.typography.titleMedium)
            Text("RSA ${m.keyBits} Bit · Schlüsselversion ${m.keyVersion}")
            Text(Crypto.shortFingerprint(m.encPub, m.sigPub), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            Text("Server: ${repo.store.server}", style = MaterialTheme.typography.bodySmall)
            HorizontalDivider()
            OutlinedButton({ scope.launch { repo.logout(false) } }, Modifier.fillMaxWidth()) { Text("Abmelden") }
            TextButton({ confirmWipe = true }, Modifier.fillMaxWidth()) { Text("Abmelden und Schlüssel von diesem Gerät entfernen", color = MaterialTheme.colorScheme.error) }
            Text("com.crackyOS.vela · Android", style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(bottom = 24.dp))
        }
    }
    if (confirmClear) AlertDialog(
        onDismissRequest = { confirmClear = false }, title = { Text("Lokalen Verlauf löschen?") },
        text = { Text("Alle auf diesem Gerät gespeicherten Nachrichten und Anhänge werden entfernt. Was der Server noch hat, lässt sich erneut laden.") },
        confirmButton = { TextButton({ confirmClear = false; repo.bg { repo.clearLocalHistory(); localCount = repo.localCount() } }) { Text("Löschen", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton({ confirmClear = false }) { Text("Abbrechen") } },
    )
    if (confirmWipe) AlertDialog(
        onDismissRequest = { confirmWipe = false }, title = { Text("Schlüssel entfernen?") },
        text = { Text("Danach brauchst du deinen Wiederherstellungsschlüssel (oder den Schlüsseltresor), um Nachrichten auf diesem Gerät wieder zu lesen.") },
        confirmButton = { TextButton({ scope.launch { repo.logout(true) } }) { Text("Entfernen", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton({ confirmWipe = false }) { Text("Abbrechen") } },
    )
}

@Composable
private fun SwitchRow(label: String, value: Boolean, onChange: (Boolean) -> Unit) {
    val haptics = rememberHaptics()
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f))
        Switch(value, { haptics.toggle(it); onChange(it) })
    }
}
