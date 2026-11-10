package de.cracky.vela.net

import android.content.SharedPreferences
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import okhttp3.Cookie
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiError(val status: Int, message: String) : Exception(message)

/** Cookies (Sitzung) bleiben über App-Neustarts erhalten. */
class PersistentCookieJar(private val prefs: SharedPreferences) : CookieJar {
    private val key = "cookies"
    private val jar = LinkedHashMap<String, Cookie>()

    init {
        val base = (prefs.getString("server", DEFAULT_SERVER) ?: DEFAULT_SERVER).toHttpUrl()
        for (s in prefs.getStringSet(key, emptySet()).orEmpty()) {
            Cookie.parse(base, s)?.let { jar[id(it)] = it }
        }
    }

    private fun id(c: Cookie) = "${c.name}|${c.domain}|${c.path}"

    @Synchronized
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        for (c in cookies) {
            if (c.expiresAt < System.currentTimeMillis()) jar.remove(id(c)) else jar[id(c)] = c
        }
        prefs.edit().putStringSet(key, jar.values.map { it.toString() }.toSet()).apply()
    }

    @Synchronized
    override fun loadForRequest(url: HttpUrl): List<Cookie> =
        jar.values.filter { it.expiresAt > System.currentTimeMillis() && it.matches(url) }

    @Synchronized
    fun clear() {
        jar.clear()
        prefs.edit().remove(key).apply()
    }
}

const val DEFAULT_SERVER = "https://cracky.ddns.net/vela"

class Api(private val prefs: SharedPreferences) {
    val jar = PersistentCookieJar(prefs)
    val client: OkHttpClient = OkHttpClient.Builder()
        .cookieJar(jar)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .build()

    val baseUrl: String get() = (prefs.getString("server", DEFAULT_SERVER) ?: DEFAULT_SERVER).trimEnd('/')

    private fun url(path: String) = baseUrl + "/api" + (if (path.startsWith("/")) path else "/$path")

    private fun detail(text: String, fallback: String): String = try {
        val d = JSONObject(text).opt("detail")
        when (d) {
            is String -> d
            is JSONArray -> (0 until d.length()).joinToString(" · ") {
                d.optJSONObject(it)?.optString("msg", "").orEmpty().removePrefix("Value error, ")
            }
            else -> fallback
        }
    } catch (e: Exception) {
        fallback
    }

    /** Führt eine JSON-Anfrage aus. Ergebnis: JSONObject, JSONArray oder null. */
    suspend fun call(path: String, method: String = "GET", body: JSONObject? = null): Any? = withContext(Dispatchers.IO) {
        val rb: RequestBody? = when {
            body != null -> body.toString().toRequestBody("application/json".toMediaType())
            method == "GET" || method == "HEAD" -> null
            else -> ByteArray(0).toRequestBody(null)
        }
        val req = Request.Builder().url(url(path)).header("X-Requested-With", "vela").method(method, rb).build()
        try {
            client.newCall(req).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (!res.isSuccessful) throw ApiError(res.code, detail(text, "Fehler ${res.code}"))
                if (text.isBlank()) null else JSONTokener(text).nextValue()
            }
        } catch (e: IOException) {
            throw ApiError(0, "Keine Verbindung zum Server")
        }
    }

    /** Sendet rohe Bytes (z. B. JPEG-Profilbild). */
    suspend fun postRaw(path: String, bytes: ByteArray, contentType: String): JSONObject = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(url(path)).header("X-Requested-With", "vela").post(bytes.toRequestBody(contentType.toMediaType())).build()
        try {
            client.newCall(req).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (!res.isSuccessful) throw ApiError(res.code, detail(text, "Fehler ${res.code}"))
                if (text.isBlank()) JSONObject() else JSONObject(text)
            }
        } catch (e: IOException) {
            throw ApiError(0, "Keine Verbindung zum Server")
        }
    }

    suspend fun obj(path: String, method: String = "GET", body: JSONObject? = null): JSONObject =
        call(path, method, body) as? JSONObject ?: JSONObject()

    suspend fun arr(path: String): JSONArray = call(path) as? JSONArray ?: JSONArray()

    /** Lädt eine (bereits verschlüsselte) Datei hoch und meldet den Fortschritt (0..1). */
    /** Führt den Aufruf aus und bricht ihn ab, wenn die Coroutine abgebrochen wird. */
    private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { try { cancel() } catch (e: Throwable) { } }
        enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { if (cont.isActive) cont.resumeWithException(e) }
            override fun onResponse(call: Call, response: Response) {
                if (cont.isActive) cont.resume(response) else response.close()
            }
        })
    }

    suspend fun upload(file: File, onProgress: (Float) -> Unit): String = withContext(Dispatchers.IO) {
        val total = file.length()
        val body = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength() = total
            override fun writeTo(sink: BufferedSink) {
                file.inputStream().use { input ->
                    val buf = ByteArray(64 * 1024)
                    var sent = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        sink.write(buf, 0, n)
                        sent += n
                        onProgress(if (total > 0) sent.toFloat() / total else 1f)
                    }
                }
            }
        }
        val req = Request.Builder().url(url("/files")).header("X-Requested-With", "vela").post(body).build()
        try {
            client.newCall(req).await().use { res ->
                val text = res.body?.string().orEmpty()
                if (!res.isSuccessful) throw ApiError(res.code, detail(text, "Upload fehlgeschlagen (${res.code})"))
                JSONObject(text).getString("id")
            }
        } catch (e: IOException) {
            throw ApiError(0, "Upload abgebrochen – Verbindung verloren")
        }
    }

    suspend fun download(path: String, dst: File, onProgress: (Float) -> Unit = {}) = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(url(path)).header("X-Requested-With", "vela").build()
        try {
            client.newCall(req).execute().use { res ->
                if (!res.isSuccessful) throw ApiError(res.code, if (res.code == 404) "Datei nicht mehr verfügbar" else "Download fehlgeschlagen")
                val body = res.body ?: throw ApiError(0, "Download fehlgeschlagen")
                val total = body.contentLength()
                dst.outputStream().buffered().use { out ->
                    body.byteStream().use { input ->
                        val buf = ByteArray(64 * 1024)
                        var got = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            got += n
                            if (total > 0) onProgress(got.toFloat() / total)
                        }
                    }
                }
            }
        } catch (e: IOException) {
            dst.delete()
            throw ApiError(0, "Download abgebrochen – Verbindung verloren")
        }
    }

    /** Rohdaten (z. B. Profilbilder). Null, wenn nicht vorhanden. */
    suspend fun bytes(path: String): ByteArray? = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(url(path)).header("X-Requested-With", "vela").build()
        try {
            client.newCall(req).execute().use { res -> if (res.isSuccessful) res.body?.bytes() else null }
        } catch (e: IOException) {
            null
        }
    }

    fun wsUrl(): String = baseUrl.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + "/ws"

    fun clearSession() = jar.clear()
}
