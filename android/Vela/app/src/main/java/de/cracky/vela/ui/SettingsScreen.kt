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
    val s = m.settings
    fun save(n: de.cracky.vela.data.Settings) = scope.launch { try { repo.saveSettings(n) } catch (e: Exception) { repo.say(e.message ?: "Fehler") } }

    Scaffold(topBar = { TopAppBar(title = { Text("Einstellungen") }, navigationIcon = { IconButton(onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Zurück") } }) }) { pad ->
        Column(Modifier.padding(pad).padding(horizontal = 16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Avatar(repo, m.id, false, m.avatarVersion, m.username, 64.dp)
                Column { Text(m.username, style = MaterialTheme.typography.titleLarge); Text(m.email, style = MaterialTheme.typography.bodySmall) }
            }
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
            Text("Benachrichtigungen", style = MaterialTheme.typography.titleMedium)
            SwitchRow("Benachrichtigungen anzeigen", notif) { notif = it; repo.store.notifications = it }
            SwitchRow("Im Hintergrund verbunden bleiben", bg) { bg = it; repo.setBackground(it) }
            Text(
                "Vela nutzt keine Google-Dienste. Solange die App geöffnet ist, gibt es keine Dienst-Benachrichtigung. Im Hintergrund hält ein Dienst die Verbindung offen – Android verlangt dafür eine Benachrichtigung; sie ist stumm, ohne Symbol in der Statusleiste und auf dem Sperrbildschirm unsichtbar.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
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
    if (confirmWipe) AlertDialog(
        onDismissRequest = { confirmWipe = false }, title = { Text("Schlüssel entfernen?") },
        text = { Text("Danach brauchst du deinen Wiederherstellungsschlüssel (oder den Schlüsseltresor), um Nachrichten auf diesem Gerät wieder zu lesen.") },
        confirmButton = { TextButton({ scope.launch { repo.logout(true) } }) { Text("Entfernen", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton({ confirmWipe = false }) { Text("Abbrechen") } },
    )
}

@Composable
private fun SwitchRow(label: String, value: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f))
        Switch(value, onChange)
    }
}
