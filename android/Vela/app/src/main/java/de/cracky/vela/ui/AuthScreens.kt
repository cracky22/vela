package de.cracky.vela.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color as AColor
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import de.cracky.vela.data.Repo
import kotlinx.coroutines.launch

@Composable
private fun AuthColumn(title: String, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Vela", style = MaterialTheme.typography.displaySmall, color = MaterialTheme.colorScheme.primary)
        Text("Privat. Verschlüsselt. Einfach.", style = MaterialTheme.typography.bodyMedium)
        Text(title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(top = 8.dp))
        content()
    }
}

@Composable
private fun ErrorLine(repo: Repo) {
    val err by repo.lastError.collectAsState()
    val busy by repo.busy.collectAsState()
    err?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    if (busy) CircularProgressIndicator(Modifier.size(28.dp))
}

@Composable
private fun PwField(label: String, value: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value, onChange, label = { Text(label) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
        visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
    )
}

@Composable
fun AuthHost(repo: Repo) {
    var mode by remember { mutableStateOf("login") }
    val scope = rememberCoroutineScope()
    val notice by repo.notice.collectAsState()
    val busy by repo.busy.collectAsState()
    androidx.compose.runtime.LaunchedEffect(mode) { repo.lastError.value = null }

    when (mode) {
        "register" -> RegisterScreen(repo, busy, onBack = { mode = "login" })
        "recover" -> RecoverScreen(repo, busy, onBack = { mode = "login" })
        "qr" -> QrLoginScreen(repo, onBack = { mode = "login" })
        else -> {
            var user by remember { mutableStateOf("") }
            var pw by remember { mutableStateOf("") }
            var code by remember { mutableStateOf("") }
            var server by remember { mutableStateOf(repo.store.server) }
            var showServer by remember { mutableStateOf(false) }
            AuthColumn("Anmelden") {
                notice?.let { Text(it, color = MaterialTheme.colorScheme.tertiary) }
                OutlinedTextField(user, { user = it }, label = { Text("Nutzername") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                PwField("Passwort", pw) { pw = it }
                OutlinedTextField(
                    code, { code = it.filter { c -> c.isDigit() || c == ' ' }.take(7) }, label = { Text("6-stelliger Code aus der Authenticator-App") },
                    singleLine = true, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    supportingText = { Text("Bei nicht abgeschlossener Registrierung leer lassen.") },
                )
                ErrorLine(repo)
                Button(
                    onClick = { repo.store.server = server; scope.launch { repo.login(user, pw, code.replace(" ", "")) } },
                    enabled = !busy && user.isNotBlank() && pw.isNotEmpty(), modifier = Modifier.fillMaxWidth(),
                ) { Text(if (busy) "Bitte warten …" else "Anmelden") }
                OutlinedButton({ mode = "qr" }, Modifier.fillMaxWidth()) { Text("Mit QR-Code / Vela-Web anmelden") }
                OutlinedButton({ mode = "register" }, Modifier.fillMaxWidth()) { Text("Neues Konto erstellen") }
                TextButton({ mode = "recover" }) { Text("Passwort oder 2FA-Gerät verloren?") }
                TextButton({ showServer = !showServer }) { Text(if (showServer) "Server verbergen" else "Server ändern") }
                if (showServer) OutlinedTextField(server, { server = it }, label = { Text("Server-Adresse") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            }
        }
    }
}

@Composable
private fun RegisterScreen(repo: Repo, busy: Boolean, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var user by remember { mutableStateOf("") }
    var mail by remember { mutableStateOf("") }
    var p1 by remember { mutableStateOf("") }
    var p2 by remember { mutableStateOf("") }
    var bits by remember { mutableStateOf(3072) }
    AuthColumn("Konto erstellen") {
        OutlinedTextField(user, { user = it }, label = { Text("Nutzername (a–z, 0–9, _ .)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(mail, { mail = it }, label = { Text("E-Mail-Adresse (nicht öffentlich)") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
        PwField("Passwort (mind. 10 Zeichen)", p1) { p1 = it }
        PwField("Passwort wiederholen", p2) { p2 = it }
        Text("Schlüssellänge (RSA)", style = MaterialTheme.typography.titleSmall)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (b in listOf(2048, 3072, 4096)) FilterChip(bits == b, { bits = b }, label = { Text("$b") })
        }
        Text(
            "Der private Schlüssel wird auf diesem Gerät erzeugt. 3072 Bit entspricht der BSI-Empfehlung; 4096 Bit kann auf dem Handy bis zu eine Minute dauern. 8192 Bit bitte im Web-Client erzeugen.",
            style = MaterialTheme.typography.bodySmall,
        )
        ErrorLine(repo)
        Button(
            onClick = { scope.launch { repo.register(user, mail, p1, bits) } },
            enabled = !busy && p1.length >= 10 && p1 == p2 && user.length >= 3 && mail.contains("@"), modifier = Modifier.fillMaxWidth(),
        ) { Text(if (busy) "Schlüssel werden erzeugt …" else "Weiter") }
        if (p2.isNotEmpty() && p1 != p2) Text("Passwörter stimmen nicht überein", color = MaterialTheme.colorScheme.error)
        TextButton(onBack) { Text("Ich habe schon ein Konto") }
    }
}

@Composable
private fun RecoverScreen(repo: Repo, busy: Boolean, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var user by remember { mutableStateOf("") }
    var rk by remember { mutableStateOf("") }
    var pw by remember { mutableStateOf("") }
    AuthColumn("Konto wiederherstellen") {
        Text("Mit dem Wiederherstellungsschlüssel setzt du Passwort und 2FA neu. Alle anderen Geräte werden abgemeldet.")
        OutlinedTextField(user, { user = it }, label = { Text("Nutzername") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(rk, { rk = it }, label = { Text("Wiederherstellungsschlüssel (XXXX-XXXX-…)") }, minLines = 2, modifier = Modifier.fillMaxWidth())
        PwField("Neues Passwort (mind. 10 Zeichen)", pw) { pw = it }
        ErrorLine(repo)
        Button({ scope.launch { repo.recover(user, rk, pw) } }, Modifier.fillMaxWidth(), enabled = !busy && pw.length >= 10 && user.isNotBlank()) { Text("Konto wiederherstellen") }
        TextButton(onBack) { Text("Zurück zur Anmeldung") }
    }
}

/** Wiederherstellungsschlüssel (nur nach Registrierung) und danach die 2FA-Einrichtung. */
@Composable
fun TotpFlow(repo: Repo) {
    val rk by repo.pendingRecovery.collectAsState()
    if (rk != null) RecoveryKeyScreen(rk!!, onDone = { repo.recoveryAcknowledged() }) else TotpScreen(repo)
}

@Composable
private fun RecoveryKeyScreen(text: String, onDone: () -> Unit) {
    val ctx = LocalContext.current
    var ok by remember { mutableStateOf(false) }
    AuthColumn("Dein Wiederherstellungsschlüssel") {
        Text("Mit diesem Schlüssel stellst du dein Konto wieder her und entsperrst deine Nachrichten auf einem neuen Gerät. Vela kann ihn nicht wiederherstellen.")
        Text(text.split("-").chunked(3).joinToString("\n") { it.joinToString("  ") }, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({
                val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("Vela", text))
            }) { Text("Kopieren") }
            OutlinedButton({
                val i = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Vela – Wiederherstellungsschlüssel:\n$text")
                ctx.startActivity(Intent.createChooser(i, "Sicher speichern"))
            }) { Text("Teilen / Speichern") }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(ok, { ok = it })
            Text("Ich habe den Schlüssel sicher gespeichert.")
        }
        Button(onDone, enabled = ok, modifier = Modifier.fillMaxWidth()) { Text("Weiter") }
    }
}

@Composable
private fun TotpScreen(repo: Repo) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val setup by repo.totp.collectAsState()
    val intro by repo.totpIntro.collectAsState()
    val busy by repo.busy.collectAsState()
    var code by remember { mutableStateOf("") }
    val s = setup ?: return
    val qr = remember(s.uri) { qrBitmap(s.uri) }
    AuthColumn("Zwei-Faktor-Authentifizierung") {
        intro?.let { Text(it, color = MaterialTheme.colorScheme.tertiary) }
        Text("Scanne den QR-Code mit einer Authenticator-App (z. B. Aegis, 2FAS, Google Authenticator) oder öffne ihn direkt in der App auf diesem Handy.")
        Image(qr.asImageBitmap(), "QR-Code", Modifier.size(220.dp).align(Alignment.CenterHorizontally))
        OutlinedButton(
            { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(s.uri))) } },
            Modifier.fillMaxWidth(),
        ) { Text("In Authenticator-App öffnen") }
        Text("Manueller Schlüssel:", style = MaterialTheme.typography.labelMedium)
        Text(s.secret.chunked(4).joinToString(" "), fontFamily = FontFamily.Monospace)
        OutlinedTextField(
            code, { code = it.filter { c -> c.isDigit() || c == ' ' }.take(7) }, label = { Text("6-stelliger Code") },
            singleLine = true, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        )
        ErrorLine(repo)
        Button({ scope.launch { repo.confirmTotp(code) } }, Modifier.fillMaxWidth(), enabled = !busy && code.replace(" ", "").length == 6) { Text("Bestätigen & loslegen") }
    }
}

fun qrBitmap(text: String, size: Int = 512): Bitmap {
    val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size)
    val px = IntArray(size * size) { i -> if (m.get(i % size, i / size)) AColor.BLACK else AColor.WHITE }
    return Bitmap.createBitmap(px, size, size, Bitmap.Config.ARGB_8888)
}

@Composable
fun UnlockScreen(repo: Repo) {
    val scope = rememberCoroutineScope()
    val me by repo.me.collectAsState()
    val vault by repo.vaultEnabled.collectAsState()
    val busy by repo.busy.collectAsState()
    var rk by remember { mutableStateOf("") }
    var pw by remember { mutableStateOf("") }
    DisposableEffect(Unit) { repo.lastError.value = null; onDispose { } }
    AuthColumn("Neues Gerät") {
        Text("Hallo ${me?.username ?: ""}! Auf diesem Gerät sind deine privaten Schlüssel noch nicht vorhanden. Entsperre dein verschlüsseltes Schlüssel-Backup – das passiert lokal, der Schlüssel wird nicht an den Server gesendet.")
        OutlinedTextField(rk, { rk = it }, label = { Text("Wiederherstellungsschlüssel (XXXX-XXXX-…)") }, minLines = 2, modifier = Modifier.fillMaxWidth())
        ErrorLine(repo)
        Button({ scope.launch { repo.unlockWithRecovery(rk) } }, Modifier.fillMaxWidth(), enabled = !busy && rk.isNotBlank()) { Text("Schlüssel entsperren") }
        if (vault) {
            Text("oder mit dem Schlüsseltresor:", style = MaterialTheme.typography.labelMedium)
            PwField("Passwort", pw) { pw = it }
            OutlinedButton({ scope.launch { repo.unlockWithPassword(pw) } }, Modifier.fillMaxWidth(), enabled = !busy && pw.isNotEmpty()) { Text("Mit Passwort entsperren") }
        }
        TextButton({ scope.launch { repo.logout(false) } }) { Text("Abmelden") }
    }
}
