package de.cracky.vela.net

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** WebSocket zum Server (Echtzeit-Ereignisse) mit automatischem Wiederverbinden. */
class WsClient(
    private val api: Api,
    private val scope: CoroutineScope,
    private val onEvent: (JSONObject) -> Unit,
    private val onState: (open: Boolean, reconnect: Boolean) -> Unit,
    private val onSessionExpired: () -> Unit,
) {
    private val client: OkHttpClient = api.client.newBuilder().readTimeout(0, TimeUnit.SECONDS).pingInterval(25, TimeUnit.SECONDS).build()
    private var ws: WebSocket? = null
    private var backoff = 1000L
    private var retryJob: Job? = null
    private var pingJob: Job? = null
    private var wanted = false
    private var everConnected = false

    @Synchronized
    fun start() {
        if (wanted && ws != null) return
        wanted = true
        connect()
    }

    @Synchronized
    fun stop() {
        wanted = false
        retryJob?.cancel(); pingJob?.cancel()
        ws?.close(1000, null)
        ws = null
        everConnected = false
        backoff = 1000L
    }

    /** Sofort neu verbinden (z. B. wenn das Netzwerk wieder da ist). */
    @Synchronized
    fun kick() {
        if (!wanted) return
        retryJob?.cancel()
        ws?.cancel()
        ws = null
        connect()
    }

    fun send(o: JSONObject): Boolean = ws?.send(o.toString()) ?: false

    @Synchronized
    private fun connect() {
        val req = Request.Builder().url(api.wsUrl()).build()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (ws !== webSocket) return
                val reconnect = everConnected || backoff > 1000L
                everConnected = true
                backoff = 1000L
                onState(true, reconnect)
                pingJob?.cancel()
                pingJob = scope.launch {
                    while (isActive) {
                        delay(60_000)
                        webSocket.send("""{"type":"ping"}""")
                    }
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (ws !== webSocket) return
                try {
                    onEvent(JSONObject(text))
                } catch (e: Exception) {
                    // fehlerhafte Nachricht ignorieren
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = lost(webSocket, code)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = lost(webSocket, response?.code ?: 0)
        }
        ws = client.newWebSocket(req, listener)
    }

    @Synchronized
    private fun lost(socket: WebSocket, code: Int) {
        if (ws !== socket) return
        ws = null
        pingJob?.cancel()
        if (!wanted) return
        if (code == 4401 || code == 401) {
            wanted = false
            onState(false, false)
            onSessionExpired()
            return
        }
        onState(false, false)
        retryJob?.cancel()
        retryJob = scope.launch {
            delay(backoff)
            backoff = (backoff * 2).coerceAtMost(30_000L)
            synchronized(this@WsClient) { if (wanted && ws == null) connect() }
        }
    }
}
