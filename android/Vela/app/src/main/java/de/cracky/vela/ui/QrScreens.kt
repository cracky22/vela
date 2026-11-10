@file:OptIn(ExperimentalMaterial3Api::class)

package de.cracky.vela.ui

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import de.cracky.vela.core.Crypto
import de.cracky.vela.data.Repo
import de.cracky.vela.net.ApiError
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

private val QR_HINTS: Map<DecodeHintType, Any> = mapOf(
    DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
    DecodeHintType.TRY_HARDER to true,
)

/** Liest einen QR-Code aus einem Foto. */
fun decodeQrBitmap(b: Bitmap): String? {
    val s = minOf(1f, 1600f / maxOf(b.width, b.height))
    val bmp = if (s < 1f) Bitmap.createScaledBitmap(b, (b.width * s).toInt(), (b.height * s).toInt(), true) else b
    val w = bmp.width; val h = bmp.height
    val px = IntArray(w * h)
    bmp.getPixels(px, 0, w, 0, 0, w, h)
    return try {
        MultiFormatReader().decode(BinaryBitmap(HybridBinarizer(RGBLuminanceSource(w, h, px))), QR_HINTS).text
    } catch (e: Exception) { null }
}

private fun decodeFrame(p: ImageProxy, reader: MultiFormatReader): String? {
    val plane = p.planes[0]
    val buf = plane.buffer
    val rowStride = plane.rowStride
    val w = p.width; val h = p.height
    val data = ByteArray(buf.remaining()).also { buf.get(it) }
    val packed = if (rowStride == w) data else ByteArray(w * h).also { out ->
        for (y in 0 until h) System.arraycopy(data, y * rowStride, out, y * w, minOf(w, data.size - y * rowStride))
    }
    return try {
        reader.decodeWithState(BinaryBitmap(HybridBinarizer(PlanarYUVLuminanceSource(packed, w, h, 0, 0, w, h, false)))).text
    } catch (e: Exception) {
        null
    } finally {
        reader.reset()
    }
}

private fun describeUA(ua: String): String {
    val os = when {
        "Windows" in ua -> "Windows"; "Android" in ua -> "Android"; Regex("iPhone|iPad").containsMatchIn(ua) -> "iOS"
        "Mac OS X" in ua -> "macOS"; "Linux" in ua -> "Linux"; else -> "unbekanntes System"
    }
    val br = when {
        "Edg/" in ua -> "Edge"; "OPR/" in ua -> "Opera"; "Firefox/" in ua -> "Firefox"; "Chrome/" in ua -> "Chrome"
        "Safari/" in ua -> "Safari"; else -> "Browser"
    }
    return "$br auf $os"
}

private fun lifecycleOwnerOf(ctx: Context): LifecycleOwner? {
    var c: Context? = ctx
    while (c != null) {
        if (c is LifecycleOwner) return c
        c = (c as? ContextWrapper)?.baseContext
    }
    return null
}

// ====================================================================== Dieses Gerät zeigt den QR-Code
/** Anmeldung per QR-Code: ein bereits angemeldetes Gerät (z. B. Vela-Web) scannt oder erhält den Text und bestätigt. */
@Composable
fun QrLoginScreen(repo: Repo, onBack: () -> Unit) {
    val ctx = LocalContext.current
    var run by remember { mutableIntStateOf(0) }
    var req by remember { mutableStateOf<Repo.LinkRequest?>(null) }
    var status by remember { mutableStateOf("QR-Code wird erzeugt …") }
    var failed by remember { mutableStateOf(false) }
    var left by remember { mutableIntStateOf(0) }

    LaunchedEffect(run) {
        failed = false; req = null; status = "QR-Code wird erzeugt …"
        try {
            val r = repo.linkNew()
            req = r
            status = "Warte auf das andere Gerät …"
            repo.linkWaitAndLogin(r) { true }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            status = e.message ?: "Fehler"; failed = true
        }
    }
    LaunchedEffect(req) {
        val r = req ?: return@LaunchedEffect
        while (true) {
            left = ((r.expiresAt - System.currentTimeMillis()) / 1000).toInt().coerceAtLeast(0)
            delay(500)
        }
    }
    val bmp = remember(req?.payload) { req?.let { qrBitmap(it.payload, 640) } }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Vela", style = MaterialTheme.typography.displaySmall, color = MaterialTheme.colorScheme.primary)
        Text("Mit anderem Gerät anmelden", style = MaterialTheme.typography.headlineSmall)
        Text("1. Öffne Vela dort, wo du bereits angemeldet bist (z. B. im Browser).")
        Text("2. Gehe zu Profil → Anmeldung auf anderen Geräten → „Neues Gerät anmelden“.")
        Text("3. Scanne diesen Code – oder füge den Code als Text ein – und bestätige.")
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            if (bmp != null) Image(bmp.asImageBitmap(), "QR-Code zum Anmelden", Modifier.size(260.dp).clip(RoundedCornerShape(16.dp)).background(Color.White).padding(10.dp))
            else Box(Modifier.size(260.dp), contentAlignment = Alignment.Center) { if (!failed) CircularProgressIndicator() }
        }
        if (req != null && !failed) Text(
            "Gültig noch ${left / 60}:${(left % 60).toString().padStart(2, '0')}", fontFamily = FontFamily.Monospace,
            modifier = Modifier.fillMaxWidth(), style = MaterialTheme.typography.titleMedium,
        )
        Text(status, color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
        req?.let { r ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton({
                    (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Vela", r.payload))
                    repo.say("Code kopiert")
                }) { Text("Code kopieren") }
                OutlinedButton({
                    ctx.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, r.payload), "Code senden"))
                }) { Text("Teilen") }
            }
        }
        if (failed) Button({ run++ }, Modifier.fillMaxWidth()) { Text("Neuen Code erzeugen") }
        TextButton(onBack) { Text("Zurück zur Anmeldung") }
    }
}

// ====================================================================== Dieses Gerät scannt und bestätigt
@Composable
fun QrScanDialog(repo: Repo, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    var granted by remember { mutableStateOf(ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    var pasted by remember { mutableStateOf("") }
    var msg by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf<Pair<String, String>?>(null) }
    var info by remember { mutableStateOf<JSONObject?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun handle(text: String) {
        val p = Crypto.parseLink(text)
        if (p == null) { msg = "Das ist kein Vela-QR-Code"; return }
        haptics.confirm()
        scope.launch {
            try {
                val i = repo.linkInfo(p.first)
                if (i.optString("pub") != p.second) { msg = "Der Code stimmt nicht überein – bitte neu scannen"; return@launch }
                info = i; pending = p
            } catch (e: Exception) { msg = e.message ?: "Fehler" }
        }
    }
    val pickPhoto = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) {
            val bmp = try { ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) } } catch (e: Exception) { null }
            val t = bmp?.let { decodeQrBitmap(it) }
            if (t != null) handle(t) else msg = "Im Foto wurde kein QR-Code gefunden. Bitte näher und gerade fotografieren."
        }
    }

    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize()) {
                TopAppBar(
                    title = { Text("QR-Code scannen") },
                    navigationIcon = { IconButton(onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Zurück") } },
                )
                Box(Modifier.fillMaxWidth().height(320.dp).background(Color.Black), contentAlignment = Alignment.Center) {
                    if (granted && pending == null) CameraPreview { handle(it) }
                    else if (!granted) Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(24.dp)) {
                        Text("Für den Scan braucht Vela die Kamera.", color = Color.White)
                        Button({ askCamera.launch(Manifest.permission.CAMERA) }, Modifier.padding(top = 8.dp)) { Text("Kamera erlauben") }
                    }
                }
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Halte die Kamera auf den QR-Code auf dem Bildschirm des neuen Geräts.")
                    OutlinedButton({ pickPhoto.launch("image/*") }, Modifier.fillMaxWidth()) { Text("QR-Code aus Foto lesen") }
                    OutlinedTextField(pasted, { pasted = it }, label = { Text("Oder Code als Text einfügen") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
                    Button({ handle(pasted) }, Modifier.fillMaxWidth(), enabled = pasted.isNotBlank()) { Text("Text verwenden") }
                    msg?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            }
        }
    }

    val p = pending
    val i = info
    if (p != null && i != null) AlertDialog(
        onDismissRequest = { pending = null; info = null },
        title = { Text("Neues Gerät anmelden?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("${describeUA(i.optString("ua"))} möchte sich mit deinem Konto anmelden und bekommt deine Schlüssel.", style = MaterialTheme.typography.bodyLarge)
                Text(
                    (if (i.optBoolean("same_network")) "Gleiches Netzwerk wie dieses Handy." else "Anderes Netzwerk als dieses Handy (z. B. Mobilfunk) – prüfe besonders sorgfältig.") + " (${i.optString("ip")})",
                    style = MaterialTheme.typography.bodySmall,
                )
                Row(
                    Modifier.clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.errorContainer).padding(10.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(Icons.Filled.Warning, null, tint = MaterialTheme.colorScheme.onErrorContainer)
                    Text(
                        "Bestätige nur, wenn du diesen QR-Code gerade selbst an deinem eigenen Gerät geöffnet hast. Nie für Fremde oder nach einer Aufforderung per Nachricht.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onErrorContainer,
                    )
                }
            }
        },
        confirmButton = {
            TextButton({
                busy = true
                scope.launch {
                    try { repo.linkApprove(p.first, p.second); haptics.confirm(); repo.say("Gerät angemeldet"); onClose() }
                    catch (e: Exception) { haptics.reject(); msg = e.message ?: "Fehler"; pending = null; info = null }
                    busy = false
                }
            }, enabled = !busy) { Text("Anmelden") }
        },
        dismissButton = { TextButton({ scope.launch { repo.linkDeny(p.first) }; pending = null; info = null }) { Text("Ablehnen") } },
    )
}

@Composable
private fun CameraPreview(onCode: (String) -> Unit) {
    val ctx = LocalContext.current
    val owner = remember(ctx) { lifecycleOwnerOf(ctx) }
    val executor = remember { Executors.newSingleThreadExecutor() }
    val handled = remember { AtomicBoolean(false) }
    val holder = remember { arrayOfNulls<ProcessCameraProvider>(1) }
    val reader = remember { MultiFormatReader().apply { setHints(QR_HINTS) } }
    DisposableEffect(Unit) {
        onDispose {
            try { holder[0]?.unbindAll() } catch (e: Exception) { }
            executor.shutdown()
        }
    }
    if (owner == null) { Text("Kamera nicht verfügbar", color = Color.White); return }
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { c ->
            val view = PreviewView(c)
            val future = ProcessCameraProvider.getInstance(c)
            future.addListener({
                try {
                    val provider = future.get()
                    holder[0] = provider
                    val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
                    val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                    analysis.setAnalyzer(executor) { proxy ->
                        val text = try { decodeFrame(proxy, reader) } finally { proxy.close() }
                        if (text != null && text.startsWith("vela-link:") && handled.compareAndSet(false, true)) {
                            Handler(Looper.getMainLooper()).apply { post { onCode(text) }; postDelayed({ handled.set(false) }, 2500) }
                        }
                    }
                    provider.unbindAll()
                    provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                } catch (e: Exception) { /* Kamera nicht verfügbar – Foto/Text bleiben möglich */ }
            }, ContextCompat.getMainExecutor(c))
            view
        },
    )
}
